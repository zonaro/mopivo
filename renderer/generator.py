#!/usr/bin/env python3
"""Mopivo wallpaper generator -- numpy/PIL port of the Wallrus GLSL shaders.

Renders abstract wallpapers exactly like the Wallrus app (megakode/wallrus)
but without OpenGL: the fragment-shader math is ported to vectorized numpy
and post-processing uses PIL for the Gaussian passes.

Pipeline order (matches gl_renderer.rs):
    Scene -> Blur -> Bloom -> Chromatic Aberration -> Effects

CLI: reads a JSON spec from stdin (or --spec <file>) and writes the image.
Exit code 0 on success (prints the output path), 1 on error (message to
stderr).

Spec fields (all optional except preset/width/height/colors/out):
    width, height          : output size in pixels        (int)
    preset                 : Bars|Circle|Plasma|Waves|Terrain|Dunes|Spark
    colors                 : [[r,g,b] x4] in 0..1 (normalized floats)
    angle                  : rotation angle, radians (UI degrees converted)
    scale, speed, blend    : shader params (float; defaults 1.0, 0.0, 0.5)
    center, variation      : circle-center / dunes-seed params (default 0.0)
    distort_type           : 0 none, 1 swirl, 2 fisheye, 3 sine wave
    distort_strength       : float (swirl/fisheye -10..10, sine 0..5)
    lighting_type          : 0 none, 1 bevel, 2 gradient, 3 vignette
    light_strength         : float (default 0.0)
    bevel_width            : float (default 0.05)
    light_angle            : radians, 0 = light from top (UI: (deg-90) rad)
    blur_type              : 0 none, 1 gaussian, 2 tilt-shift, 3 radial,
                             4 vignette, 5 directional
    blur_strength, blur_angle : float (radians)
    bloom                  : bool
    bloom_threshold        : float (default 0.5)
    bloom_intensity        : float (default 1.0)
    chromatic              : bool
    chromatic_strength     : float (default 0.5, UI 0..1)
    chromatic_angle        : radians
    effect_type            : 0 none, 1 noise, 2 dither, 3 film grain
    noise                  : float (default 0.0, UI -0.2..0.2)
    dither_strength        : float (default 0.5)
    dither_levels          : float (default 4.0, 2..8)
    grain_intensity        : float (default 0.3)
    out                    : output path (.png or .jpg/.jpeg)

Notes on fidelity (documented approximations, not bit-exact):
  * GLSL uses float32 throughout; numpy math runs in float32 to stay close.
  * Gaussian-family blurs use PIL GaussianBlur with the same sigma the GLSL
    13x13 kernel produces (sigma_px = radius * 0.5).
  * Tilt-shift / vignette blur vary the sigma per pixel (layered, 6 levels).
  * Directional blur samples 37 taps like the GLSL, deduplicated by rounded
    integer offset; edges clamp instead of wrap.
  * Radial-style blur is a mild gaussian (the GLSL offsets stay sub-pixel at
    the UI strength range, so the original effect is nearly invisible).
"""

import json
import math
import sys

import numpy as np
from PIL import Image, ImageFilter

PRESETS = ("Bars", "Circle", "Plasma", "Waves", "Terrain", "Dunes", "Spark")

BAYER4X4 = np.array(
    [
        [0, 8, 2, 10],
        [12, 4, 14, 6],
        [3, 11, 1, 9],
        [15, 7, 13, 5],
    ],
    dtype=np.int32,
)

LUMINANCE = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


# ---------------------------------------------------------------------------
# Scalar helpers (vectorized; arrays are float32 (H, W))
# ---------------------------------------------------------------------------

def fract(x):
    return np.mod(x, 1.0)


def clamp01(x):
    return np.clip(x, 0.0, 1.0)


def mix(a, b, f):
    return a + (b - a) * f


def smoothstep(edge0, edge1, x):
    """GLSL smoothstep. Handles edge0 > edge1 (inverted edges)."""
    denom = edge1 - edge0
    t = np.where(denom != 0.0, (x - edge0) / np.where(denom != 0.0, denom, 1.0), 0.0)
    t = clamp01(t)
    return t * t * (3.0 - 2.0 * t)


def step(edge, x):
    return np.where(x >= edge, 1.0, 0.0)


# ---------------------------------------------------------------------------
# common.glsl -- palette, distortion, lighting, hash, dither
# ---------------------------------------------------------------------------

def palette_color(t, colors, blend):
    """common.glsl paletteColor() -- 4-color band mix with blend width."""
    t = clamp01(t)
    fw = blend * 0.25
    if fw > 0.0001:
        f1 = smoothstep(0.25 - fw, 0.25 + fw, t)
        f2 = smoothstep(0.50 - fw, 0.50 + fw, t)
        f3 = smoothstep(0.75 - fw, 0.75 + fw, t)
    else:
        f1 = step(0.25, t)
        f2 = step(0.50, t)
        f3 = step(0.75, t)
    c1 = np.asarray(colors[0], dtype=np.float32)
    c2 = np.asarray(colors[1], dtype=np.float32)
    c3 = np.asarray(colors[2], dtype=np.float32)
    c4 = np.asarray(colors[3], dtype=np.float32)
    color = np.broadcast_to(c1, t.shape + (3,)).copy()
    color = mix(color, np.broadcast_to(c2, t.shape + (3,)), f1[..., None])
    color = mix(color, np.broadcast_to(c3, t.shape + (3,)), f2[..., None])
    color = mix(color, np.broadcast_to(c4, t.shape + (3,)), f3[..., None])
    return color


def distort_uv(uv, distort_type, distort_strength):
    """common.glsl distortUV() -> swirl(1), fisheye(2), sineWave(3)."""
    if distort_type == 1:  # swirl
        c = uv - 0.5
        r = np.linalg.norm(c, axis=-1)
        angle = distort_strength * (1.0 - r)
        ca = np.cos(angle)
        sa = np.sin(angle)
        x = ca * c[..., 0] - sa * c[..., 1]
        y = sa * c[..., 0] + ca * c[..., 1]
        return np.stack([x, y], axis=-1) + 0.5
    if distort_type == 2:  # fisheye (barrel/pincushion)
        c = uv - 0.5
        r = np.linalg.norm(c, axis=-1)
        power = 1.0 + distort_strength * 0.2
        bind = 0.5
        nr = np.power(np.clip(r / bind, 0.0, None), power) * bind
        scale = np.where(r > 0.0, nr / np.where(r > 0.0, r, 1.0), 0.0)
        return c * scale[..., None] + 0.5
    if distort_type == 3:  # sine wave (sequential x then y!)
        amp = distort_strength * 0.02
        freq = 10.0
        uvx = uv[..., 0] + np.sin(uv[..., 1] * freq) * amp
        uvy = uv[..., 1] + np.sin(uvx * freq) * amp
        return np.stack([uvx, uvy], axis=-1)
    return uv


def apply_lighting(color, t, uv, lighting):
    """common.glsl applyLighting() -> bevel(1), gradient(2), vignette(3)."""
    ltype = lighting.get("type", 0)
    if ltype == 0:
        return color
    strength = lighting.get("strength", 0.0)
    shade = np.zeros(color.shape[:-1], dtype=np.float32)
    if ltype == 1:  # bevel: shadow/highlight at color band boundaries
        w = lighting.get("bevel_width", 0.05)
        b1 = smoothstep(-w, w, t - 0.25) * 2.0 - 1.0
        b2 = smoothstep(-w, w, t - 0.50) * 2.0 - 1.0
        b3 = smoothstep(-w, w, t - 0.75) * 2.0 - 1.0
        m1 = 1.0 - smoothstep(0.0, w * 2.0, np.abs(t - 0.25))
        m2 = 1.0 - smoothstep(0.0, w * 2.0, np.abs(t - 0.50))
        m3 = 1.0 - smoothstep(0.0, w * 2.0, np.abs(t - 0.75))
        shade = (b1 * m1 + b2 * m2 + b3 * m3) * 0.25
    elif ltype == 2:  # gradient: directional light (0 = from top)
        la = lighting.get("angle", 0.0)
        light_dir = np.array([np.cos(la), np.sin(la)], dtype=np.float32)
        shade = (uv - 0.5) @ light_dir
    elif ltype == 3:  # vignette: darken toward edges
        dist = np.linalg.norm(uv - 0.5, axis=-1) * 2.0
        shade = -dist * 0.5
    return clamp01(color + shade[..., None] * strength)


def hash2(p):
    """common.glsl hash(vec2) -- computes on pixel coords."""
    p3x = fract(p[..., 0] * 0.1031)
    p3y = fract(p[..., 1] * 0.1031)
    p3z = fract(p[..., 0] * 0.1031)
    # dot(p3, p3.yzx + 33.33) == p3.x*(p3.y+33.33)+p3.y*(p3.z+33.33)+p3.z*(p3.x+33.33)
    d = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33)
    p3x += d
    p3y += d
    p3z += d
    return fract((p3x + p3y) * p3z)


def bayer_at(px, py):
    flat = BAYER4X4.ravel()
    idx = (px & 3) + (py & 3) * 4
    return flat[idx].astype(np.float32) / 16.0


# ---------------------------------------------------------------------------
# Preset scene shaders (bars/plasma/waves/terrain/circle/dunes/spark)
# ---------------------------------------------------------------------------

def _uv_grid(width, height):
    """Build uv (H, W, 2) float32 grid matching gl_FragCoord/iResolution.

    Row 0 of the output image is the TOP (uv.y = 1), matching how the GL
    framebuffer is saved/exposed by Wallrus.
    """
    xs = (np.arange(width, dtype=np.float32) + 0.5) / width
    ys = (height - 0.5 - np.arange(height, dtype=np.float32)) / height
    uv = np.empty((height, width, 2), dtype=np.float32)
    uv[..., 0] = xs[None, :]
    uv[..., 1] = ys[:, None]
    return uv


def _render_scene(preset, uv, colors, params):
    """Dispatch to the preset shader; returns (H, W, 3) float32 in 0..1."""
    if preset == "Bars":
        angle = params.get("angle", 0.0)
        dirx = np.cos(angle)
        diry = np.sin(angle)
        t = (uv[..., 0] - 0.5) * dirx + (uv[..., 1] - 0.5) * diry + 0.5
        t = clamp01(t)
        color = palette_color(t, colors, params.get("blend", 0.5))
        return apply_lighting(color, t, uv, params.get("lighting", {}))

    if preset == "Plasma":
        scale = params.get("scale", 1.0)
        time = params.get("speed", 0.0)
        p = (uv - 0.5) * scale * 10.0
        v = np.sin(p[..., 0] + time)
        v += np.sin((p[..., 1] + time) * 0.5)
        v += np.sin((p[..., 0] + p[..., 1] + time) * 0.5)
        cx = p[..., 0] + 0.5 * np.sin(time * 0.33)
        cy = p[..., 1] + 0.5 * np.cos(time * 0.5)
        v += np.sin(np.sqrt(cx * cx + cy * cy + 1.0) + time)
        v *= 0.5
        t = np.sin(v * math.pi) * 0.5 + 0.5
        color = palette_color(t, colors, params.get("blend", 0.5))
        return apply_lighting(color, t, uv, params.get("lighting", {}))

    if preset == "Waves":
        angle = params.get("angle", 0.0)
        scale = params.get("scale", 1.0)
        time = params.get("speed", 0.0)
        center = uv - 0.5
        ca = np.cos(angle)
        sa = np.sin(angle)
        ruvx = ca * center[..., 0] - sa * center[..., 1]
        ruvy = sa * center[..., 0] + ca * center[..., 1]
        ruvx = ruvx + 0.5
        ruvy = ruvy + 0.5
        rlen = np.linalg.norm(center, axis=-1)
        wave = np.sin(ruvx * scale * 20.0 + time * 2.0) * 0.25
        wave += np.sin(ruvx * scale * 10.0 - time * 1.5 + ruvy * 5.0) * 0.25
        wave += np.sin(ruvy * scale * 15.0 + time * 1.0) * 0.15
        wave += np.sin(rlen * scale * 15.0 - time * 2.0) * 0.2
        t = clamp01(wave + ruvy)
        t = t * t * (3.0 - 2.0 * t)
        color = palette_color(t, colors, params.get("blend", 0.5))
        return apply_lighting(color, t, uv, params.get("lighting", {}))

    if preset == "Terrain":
        scale = params.get("scale", 0.5)
        speed = params.get("speed", 0.0)
        p = (uv - 0.5) * scale * 2.0
        p = p + np.array([speed * 1.7, speed * 1.3], dtype=np.float32)
        height = _gnoise(p)
        height = clamp01((height - 0.15) * 1.4)
        height = height * height * (3.0 - 2.0 * height)
        height = height * height * (3.0 - 2.0 * height)
        color = palette_color(height, colors, params.get("blend", 0.5))
        return apply_lighting(color, height, uv, params.get("lighting", {}))

    if preset == "Circle":
        scale = params.get("scale", 1.0)
        center_x = 0.5 + params.get("center", 0.0) * 0.4
        d = np.linalg.norm(uv - np.array([center_x, 0.5], dtype=np.float32), axis=-1)
        d_scaled = d * scale * 2.0
        t = 1.0 - np.abs(fract(d_scaled * 0.5) * 2.0 - 1.0)
        color = palette_color(t, colors, params.get("blend", 0.5))
        return apply_lighting(color, t, uv, params.get("lighting", {}))

    if preset == "Dunes":
        scale = params.get("scale", 1.0)
        speed = params.get("speed", 0.0)
        variation = params.get("variation", 0.0)
        blend = params.get("blend", 0.5)
        x = uv[..., 0] * scale * 10.0 + speed
        y = uv[..., 1]
        seed = math.floor(variation * 10.0) * 0.1
        h1 = lambda n: fract(np.sin(np.float32(n)) * 43758.5453123)
        freq0 = 0.5 + h1(seed + 0.1) * 2.5
        freq1 = 0.5 + h1(seed + 0.2) * 2.5
        freq2 = 0.5 + h1(seed + 0.3) * 2.5
        p0 = h1(seed + 0.4) * 6.2832
        p1 = h1(seed + 0.5) * 6.2832
        p2 = h1(seed + 0.6) * 6.2832
        lfo0 = freq0 * (0.05 + h1(seed + 0.7) * 0.2)
        lfo1 = freq1 * (0.05 + h1(seed + 0.8) * 0.2)
        lfo2 = freq2 * (0.05 + h1(seed + 0.9) * 0.2)

        def dune_wave(xx, base_y, freq, phase, amplitude, lfo_freq):
            lfo = np.sin(xx * lfo_freq + phase * 0.7) * amplitude * 1.6
            return base_y + np.sin(xx * freq + phase) * amplitude + lfo

        w0 = dune_wave(x, 0.30, freq0, p0, 0.07, lfo0)
        w1 = dune_wave(x, 0.55, freq1, p1, 0.08, lfo1)
        w2 = dune_wave(x, 0.80, freq2, p2, 0.07, lfo2)
        edge = 0.005 + blend * 0.18
        below0 = smoothstep(w0 + edge, w0 - edge, y)
        below1 = smoothstep(w1 + edge, w1 - edge, y)
        below2 = smoothstep(w2 + edge, w2 - edge, y)
        t = mix(0.125, 0.375, below2)
        t = mix(t, 0.625, below1)
        t = mix(t, 0.875, below0)
        color = palette_color(t, colors, 0.0)  # dunes blend is in the edges
        return apply_lighting(color, t, uv, params.get("lighting", {}))

    if preset == "Spark":
        scale = params.get("scale", 1.0)
        time = params.get("speed", 0.0)
        width, height = uv.shape[1], uv.shape[0]
        ratio = width / height
        # uv is used for the line math with y divided by the aspect ratio.
        work_uv = uv.copy()
        work_uv[..., 1] = work_uv[..., 1] / ratio
        slowing = 4.0
        frequency = 4.0 * scale
        amplitude_lim = 2.0
        curvature = -(work_uv[..., 1] - 0.5) ** 2 / 0.5 + 0.5
        wave = np.cos((work_uv[..., 1] + time / slowing) * frequency) / amplitude_lim
        line = wave * curvature + 0.55
        centre = np.stack([line, work_uv[..., 1]], axis=-1)
        pos = centre - work_uv
        with np.errstate(divide="ignore", invalid="ignore"):
            dist = 1.0 / np.linalg.norm(pos, axis=-1)
            dist *= 0.1
            dist = np.power(dist, 1.1)
        pal_t = fract(work_uv[..., 1] * ratio + time * 0.1)
        color = dist[..., None] * palette_color(pal_t, colors, params.get("blend", 0.5))
        with np.errstate(over="ignore", invalid="ignore"):
            color = 1.0 - np.exp(-color)
        color = clamp01(color)
        # Spark lights using the ORIGINAL (undistorted) uv.
        return apply_lighting(color, pal_t, uv, params.get("lighting", {}))

    raise ValueError("unknown preset: %s" % preset)


def _hash2_grad(p):
    """terrain.glsl hash2() -- gradient direction."""
    px = p[..., 0] * 127.1 + p[..., 1] * 311.7
    py = p[..., 0] * 269.5 + p[..., 1] * 183.3
    gx = -1.0 + 2.0 * fract(np.sin(px) * 43758.5453123)
    gy = -1.0 + 2.0 * fract(np.sin(py) * 43758.5453123)
    return np.stack([gx, gy], axis=-1)


def _gnoise(p):
    """terrain.glsl gnoise() -- 2D gradient noise, quintic interpolation."""
    i = np.floor(p)
    f = fract(p)
    u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0)
    o00 = np.array([0.0, 0.0], dtype=np.float32)
    o10 = np.array([1.0, 0.0], dtype=np.float32)
    o01 = np.array([0.0, 1.0], dtype=np.float32)
    o11 = np.array([1.0, 1.0], dtype=np.float32)
    a = np.sum(_hash2_grad(i + o00) * (f - o00), axis=-1)
    b = np.sum(_hash2_grad(i + o10) * (f - o10), axis=-1)
    c = np.sum(_hash2_grad(i + o01) * (f - o01), axis=-1)
    d = np.sum(_hash2_grad(i + o11) * (f - o11), axis=-1)
    m1 = mix(a, b, u[..., 0])
    m2 = mix(c, d, u[..., 0])
    return mix(m1, m2, u[..., 1]) * 0.5 + 0.5


# ---------------------------------------------------------------------------
# Post-processing passes (blur.glsl, bloom.glsl, chromatic.glsl, effects.glsl)
# ---------------------------------------------------------------------------

def _gaussian_blur_pil(img, sigma):
    """PIL gaussian blur on a float32 (H, W, 3) image in 0..1."""
    if sigma <= 0.0:
        return img
    pil = Image.fromarray((np.clip(img, 0.0, 1.0) * 255.0).astype(np.uint8))
    pil = pil.filter(ImageFilter.GaussianBlur(radius=float(sigma)))
    return np.asarray(pil, dtype=np.float32) / 255.0


def _blur_layered(img, strength, mask, levels=6):
    """Approximate per-pixel sigma blur (tilt-shift/vignette) via layers."""
    radius = strength * 48.0
    if radius <= 1.0 or mask.max() < 0.02:
        return img
    out = np.array(img, copy=True)
    q = (np.clip(mask, 0.0, 1.0) * levels).astype(np.int32)
    for k in range(1, levels):
        sel = q == k
        if not sel.any():
            continue
        frac = (k + 0.5) / levels
        sigma = max(radius * 0.5 * frac, 0.5)
        out[sel] = _gaussian_blur_pil(img, sigma)[sel]
    return out


def _shift_clamp(img, ox, oy):
    """Sample img at (x+ox, y+oy), clamping at edges (uv clamp)."""
    h, w = img.shape[:2]
    idx_x = np.clip(np.arange(w) + int(round(ox)), 0, w - 1)
    idx_y = np.clip(np.arange(h) + int(round(oy)), 0, h - 1)
    return img[idx_y][:, idx_x]


def _blur_pass(img, width, height, blur):
    """blur.glsl -- type: 1 gaussian, 2 tilt-shift, 3 radial, 4 vignette, 5 directional."""
    btype = blur.get("type", 0)
    strength = blur.get("strength", 0.5)
    angle = blur.get("angle", 0.0)
    if btype == 0 or strength <= 0.0:
        return img
    if btype == 1:  # gaussian
        sigma = max(strength * 48.0 * 0.5, 0.5)
        return _gaussian_blur_pil(img, sigma)
    if btype == 2:  # tilt-shift
        ux = np.linspace(0.5 / width, 1.0 - 0.5 / width, width, dtype=np.float32)
        uy = np.linspace(0.5 / height, 1.0 - 0.5 / height, height, dtype=np.float32)
        gy, gx = np.meshgrid(uy, ux, indexing="ij")
        dirx = -np.sin(angle)
        diry = np.cos(angle)
        dist_band = np.abs((gx - 0.5) * dirx + (gy - 0.5) * diry)
        factor = smoothstep(0.15, 0.45, dist_band)
        return _blur_layered(img, strength, factor)
    if btype == 3:  # radial (GLSL offsets are sub-pixel; mild gaussian)
        return _gaussian_blur_pil(img, max(strength * 1.5, 0.5))
    if btype == 4:  # vignette
        ux = np.linspace(0.5 / width, 1.0 - 0.5 / width, width, dtype=np.float32)
        uy = np.linspace(0.5 / height, 1.0 - 0.5 / height, height, dtype=np.float32)
        gy, gx = np.meshgrid(uy, ux, indexing="ij")
        dist = np.linalg.norm(np.stack([gx, gy], axis=-1) - 0.5, axis=-1) * 2.0
        factor = smoothstep(0.2, 1.2, dist)
        return _blur_layered(img, strength, factor)
    if btype == 5:  # directional (37 taps, dedup by int offset)
        radius = strength * 200.0
        dx = np.cos(angle) * radius
        dy = np.sin(angle) * radius
        samples = 37
        taps = {}
        for i in range(samples):
            t = i / (samples - 1) - 0.5
            ox = dx * t
            oy = dy * t
            key = (int(round(ox)), int(round(oy)))
            weight = math.exp(-(t * t) / (2.0 * 0.35 * 0.35))
            taps[key] = taps.get(key, 0.0) + weight
        total_w = sum(taps.values())
        acc = np.zeros_like(img, dtype=np.float32)
        for (ox, oy), w in taps.items():
            acc += _shift_clamp(img, ox, oy) * w
        return acc / total_w
    return img


def _bloom_pass(img, bloom):
    """bloom.glsl -- bright pass + soft knee + gaussian blur + additive."""
    threshold = bloom.get("threshold", 0.5)
    intensity = bloom.get("intensity", 1.0)
    brightness = img @ LUMINANCE
    bright_pass = np.maximum(img - threshold, 0.0)
    excess = np.maximum(brightness - threshold, 0.0)
    bright_pass *= (excess / (excess + 0.5))[..., None]
    blurred = _gaussian_blur_pil(bright_pass, 12.0)
    return img + blurred * intensity


def _chromatic_pass(img, width, height, chromatic):
    """chromatic.glsl -- per-channel split along an angle."""
    strength = chromatic.get("strength", 0.5)
    angle = chromatic.get("angle", 0.0)
    if strength <= 0.0:
        return img
    dirx = np.cos(angle)
    diry = np.sin(angle)
    offset = dirx * strength * 20.0
    offset_y = diry * strength * 20.0
    out = np.empty_like(img)
    out[..., 0] = _shift_clamp(img[..., 0][..., None], offset, offset_y)[..., 0]
    out[..., 1] = img[..., 1]
    out[..., 2] = _shift_clamp(img[..., 2][..., None], -offset, -offset_y)[..., 0]
    return out


def _effects_pass(img, width, height, effects):
    """effects.glsl -- 1 noise, 2 ordered dither, 3 film grain."""
    etype = effects.get("type", 0)
    if etype == 0:
        return img
    xs = np.arange(width, dtype=np.float32) + 0.5
    ys = np.arange(height, dtype=np.float32) + 0.5
    py, px = np.meshgrid(ys, xs, indexing="ij")
    if etype == 1:  # noise grain
        n = hash2(np.stack([px, py], axis=-1))
        return clamp01(img + n[..., None] * effects.get("noise", 0.0) * 0.3)
    if etype == 2:  # ordered dither
        threshold = (bayer_at(px.astype(np.int32), py.astype(np.int32)) - 0.5) * effects.get(
            "dither_strength", 0.5
        )
        step_ = 1.0 / effects.get("dither_levels", 4.0)
        return clamp01(
            np.floor(img / step_ + threshold[..., None] + 0.5) * step_
        )
    if etype == 3:  # film grain, luminance-dependent
        n = hash2(np.stack([px, py], axis=-1)) * 2.0 - 1.0
        luminance = img @ LUMINANCE
        midtone = 1.0 - np.power(2.0 * luminance - 1.0, 2.0)
        return clamp01(img + n[..., None] * effects.get("grain_intensity", 0.3) * midtone[..., None])
    return img


# ---------------------------------------------------------------------------
# Top-level pipeline
# ---------------------------------------------------------------------------

def render(spec):
    """Render a full spec dict into a (H, W, 3) float32 image in 0..1."""
    width = int(spec["width"])
    height = int(spec["height"])
    preset = spec["preset"]
    colors = spec["colors"]
    if preset not in PRESETS:
        raise ValueError("preset must be one of %s" % (", ".join(PRESETS)))
    uv = _uv_grid(width, height)

    dv = spec.get("distort", {})
    uv = distort_uv(uv, dv.get("type", 0), dv.get("strength", 0.0))

    params = {
        "angle": spec.get("angle", 0.0),
        "scale": spec.get("scale", 1.0),
        "speed": spec.get("speed", 0.0),
        "blend": spec.get("blend", 0.5),
        "center": spec.get("center", 0.0),
        "variation": spec.get("variation", 0.0),
        "lighting": spec.get("lighting", {}),
    }
    img = _render_scene(preset, uv, colors, params)

    blur = spec.get("blur", {})
    img = _blur_pass(img, width, height, blur)

    if spec.get("bloom", {}).get("enabled", False):
        img = _bloom_pass(img, spec.get("bloom", {}))

    chromatic = spec.get("chromatic", {})
    if chromatic.get("enabled", False):
        img = _chromatic_pass(img, width, height, chromatic)

    effects = spec.get("effects", {})
    img = _effects_pass(img, width, height, effects)

    return clamp01(img)


def save_image(img, path):
    """Write the float image to PNG or JPEG."""
    arr = (np.clip(img, 0.0, 1.0) * 255.0).astype(np.uint8)
    pil = Image.fromarray(arr, mode="RGB")
    if path.lower().endswith((".jpg", ".jpeg")):
        pil.save(path, format="JPEG", quality=92)
    else:
        pil.save(path, format="PNG")


def main(argv):
    if "--version" in argv:
        print("mopivo-generator 1.0.0")
        return 0
    if "--presets" in argv:
        print("\n".join(PRESETS))
        return 0
    if "--help" in argv or "-h" in argv:
        print(__doc__)
        return 0

    spec = None
    if "--spec" in argv:
        idx = argv.index("--spec")
        with open(argv[idx + 1], "r", encoding="utf-8") as fh:
            spec = json.load(fh)
    else:
        spec = json.load(sys.stdin)

    out = spec.get("out")
    if not out:
        raise ValueError("spec is missing 'out' path")
    img = render(spec)
    save_image(img, out)
    print(out)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001 -- CLI boundary
        sys.stderr.write("generator error: %s\n" % exc)
        sys.exit(1)