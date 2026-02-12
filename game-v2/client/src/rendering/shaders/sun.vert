// Sun shader with flowfield noise patterns
// Vertex shader - just passes through position and UV

precision mediump float;

attribute vec2 aPosition;
attribute vec2 aUV;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;

varying vec2 vUV;

void main() {
    vUV = aUV;
    gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}
