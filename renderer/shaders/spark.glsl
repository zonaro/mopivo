#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform float iTime;
uniform float uScale;
uniform float uSpeed;

// common.glsl inserted here

out vec4 fragColor;

void main() {
    vec2 uv = distortUV(gl_FragCoord.xy / iResolution.xy);
    float widthHeightRatio = iResolution.x / iResolution.y;
    uv.y /= widthHeightRatio;

    // Wave parameters
    float slowing = 4.0;
    float frequency = 4.0 * uScale;
    float amplitudeLim = 2.0;

    float t_time = uSpeed;

    float curvature = -pow(uv.y - 0.5, 2.0) / 0.5 + 0.5;
    float wave = cos((uv.y + t_time / slowing) * frequency) / amplitudeLim;
    float line = wave * curvature + 0.55;

    vec2 centre = vec2(line, uv.y);
    vec2 pos = centre - uv;

    // 1/x hyperbola glow — intense near line, rapid falloff
    float dist = 1.0 / length(pos);
    dist *= 0.1;
    dist = pow(dist, 1.1);

    // Map position along the line to palette color
    float palT = uv.y * widthHeightRatio;
    palT = fract(palT + t_time * 0.1);

    vec3 color = dist * paletteColor(palT);

    // Tone mapping — soft highlight compression
    color = 1.0 - exp(-color);

    color = applyLighting(color, palT, gl_FragCoord.xy / iResolution.xy);
    fragColor = vec4(color, 1.0);
}
