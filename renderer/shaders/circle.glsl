#version 300 es
precision highp float;
precision highp int;
uniform vec3 iResolution;
uniform float iTime;
uniform float uScale;
uniform float uCenter;

// common.glsl inserted here

out vec4 fragColor;

void main() {
    vec2 uv = distortUV(gl_FragCoord.xy / iResolution.xy);

    // Offset center horizontally based on uCenter
    vec2 center = vec2(0.5 + uCenter * 0.4, 0.5);

    // Distance from offset center
    float d = length(uv - center);

    // Map distance to palette range, scaled
    float d_scaled = d * uScale * 2.0;

    // Ping-pong: 1,2,3,4,3,2,1,2,3,4,...
    // Triangle wave maps d_scaled into repeating 0→1→0 pattern
    float t = 1.0 - abs(fract(d_scaled * 0.5) * 2.0 - 1.0);

    vec3 color = paletteColor(t);
    color = applyLighting(color, t, uv);
    fragColor = vec4(color, 1.0);
}
