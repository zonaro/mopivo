// SPDX-License-Identifier: GPL-3.0-or-later
// Video wallpaper subsystem — GLSL rounded-corners effect.
// Adapted from gnome-ext-hanabi (jeffshee), originally ported from Mutter's
// meta-background-content.c for antialiased rounded rectangle clipping.

import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {LOG_PREFIX} from './constants.js';

function _log(msg) {
    console.log(`${LOG_PREFIX} roundedCorners: ${msg}`);
}

// Hook compatibility: Shell.GLSLEffect uses SnippetHook from Shell or Cogl.
const FragmentHook = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;

// Default clip radius in pixels.
const DEFAULT_RADIUS = 30;

// --- GLSL fragment shader (adapted from Mutter) ----------------------------
// See <https://gitlab.gnome.org/GNOME/mutter/-/blob/main/src/compositor/meta-background-content.c>

const FRAGMENT_DECLS = `
uniform vec4 bounds;           // x, y: top left; z, w: bottom right
uniform float clip_radius;
uniform vec2 pixel_step;
uniform float border_stroke;
uniform vec4 border_color;

float
rounded_rect_coverage (vec2 p)
{
  float center_left  = bounds.x + clip_radius;
  float center_right = bounds.z - clip_radius;
  float center_x;

  if (p.x < center_left)
    center_x = center_left;
  else if (p.x > center_right)
    center_x = center_right;
  else
    return 1.0; // early exit for most pixels

  float center_top    = bounds.y + clip_radius;
  float center_bottom = bounds.w - clip_radius;
  float center_y;

  if (p.y < center_top)
    center_y = center_top;
  else if (p.y > center_bottom)
    center_y = center_bottom;
  else
    return 1.0;

  vec2 delta = p - vec2 (center_x, center_y);
  float dist_squared = dot (delta, delta);

  // Fully outside the circle
  float outer_radius = clip_radius + 0.5;
  if (dist_squared >= (outer_radius * outer_radius))
    return 0.0;

  // Fully inside the circle
  float inner_radius = clip_radius - 0.5;
  if (dist_squared <= (inner_radius * inner_radius))
    return 1.0;

  // Edge pixels — antialiasing
  return outer_radius - sqrt (dist_squared);
}
`;

const FRAGMENT_BODY = `
vec2 texture_coord = cogl_tex_coord0_in.xy / pixel_step;

bool inside = texture_coord.x >= bounds.x && texture_coord.x <= bounds.z
           && texture_coord.y >= bounds.y && texture_coord.y <= bounds.w;

// Border stroke for debug / decoration
bool on_border = border_stroke > 0.0 && inside && (
    texture_coord.x < bounds.x + border_stroke ||
    texture_coord.x > bounds.z - border_stroke ||
    texture_coord.y < bounds.y + border_stroke ||
    texture_coord.y > bounds.w - border_stroke);

if (on_border)
    cogl_color_out = border_color;
else if (clip_radius > 0.0 && !inside)
    cogl_color_out = vec4 (0.0);
else if (clip_radius > 0.0)
    cogl_color_out *= rounded_rect_coverage (texture_coord);
`;

/**
 * GLSL effect that clips the background actor to a rounded rectangle.
 *
 * Call `setPixelStep`, `setClipRadius`, and `setBounds` after adding the
 * effect to an actor.  Convenience setters `setRadius` and `setBorder`
 * wrap the raw uniform calls.
 */
export const RoundedCornersEffect = GObject.registerClass(
class RoundedCornersEffect extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(
            FragmentHook,
            FRAGMENT_DECLS,
            FRAGMENT_BODY,
            false
        );
    }

    /* ----- uniform setters --------------------------------------------- */

    setBounds(x1, y1, x2, y2) {
        this.set_uniform_float(
            this.get_uniform_location('bounds'),
            4,
            [x1, y1, x2, y2]
        );
    }

    setClipRadius(clipRadius) {
        this.set_uniform_float(
            this.get_uniform_location('clip_radius'),
            1,
            [clipRadius]
        );
    }

    setPixelStep(pixelStep) {
        this.set_uniform_float(
            this.get_uniform_location('pixel_step'),
            2,
            pixelStep
        );
    }

    setBorderStroke(stroke) {
        this.set_uniform_float(
            this.get_uniform_location('border_stroke'),
            1,
            [stroke]
        );
    }

    setBorderColor(color) {
        this.set_uniform_float(
            this.get_uniform_location('border_color'),
            4,
            color
        );
    }

    /* ----- convenience API --------------------------------------------- */

    /**
     * Set the corner radius in logical pixels.
     * The caller must account for monitor scale before calling.
     * @param {number} radius — radius in scaled (physical) pixels
     */
    setRadius(radius) {
        this.setClipRadius(radius);
    }

    /**
     * Set border stroke width and color in a single call.
     * @param {number} stroke — stroke width in scaled pixels
     * @param {number[]} color — RGBA array, e.g. [1, 0, 0, 1]
     */
    setBorder(stroke, color) {
        this.setBorderStroke(stroke);
        this.setBorderColor(color);
    }
});
