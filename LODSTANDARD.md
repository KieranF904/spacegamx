# LOD Standard (Draft)

This document defines LOD practices for Spacegame assets, shaders, and systems. It is intended to be shared between the system designer and the main game, and to remain stable as client graphics settings are introduced.

## Goals
- Preserve visual fidelity at close range with scalable detail.
- Ensure stable performance across a wide range of hardware.
- Keep the system designer faithful to runtime behavior.
- Provide deterministic, testable, and repeatable LOD transitions.

## Terminology
- **LOD**: Level of Detail. A continuous or discrete measure of detail for visuals or simulation.
- **LOD Driver**: The input variable used to control LOD (e.g., zoom, distance, screen size).
- **LOD Schema**: The mapping from a driver to detail tiers or a continuous factor.
- **LOD Budget**: The maximum acceptable cost for a visual or system.

## LOD Principles
1. **Shared Driver**: Use a single LOD driver per system (e.g., zoom or distance) to avoid conflicting transitions.
2. **Continuous First**: Prefer continuous LOD functions (smoothstep, exponential fade) before discrete tiers.
3. **Tier Fallback**: When discrete tiers are required, ensure cross-fade at transitions.
4. **Stable Seeds**: Noise or randomization must be deterministic across frames and LOD changes.
5. **Minimal Branching**: Keep shader branches low; prefer parameter blending.
6. **Perceptual Priorities**: Preserve silhouette, large scale motion, and lighting before micro-detail.

## LOD Drivers
- **Zoom**: Preferred for editor and camera-based scenes.
- **Distance to Camera**: Preferred for in-game objects with fixed scale.
- **Screen Coverage**: Use for UI or large-scale objects with variable sizes.

## Recommended LOD Curve
Use a normalized driver in $[0,1]$ and shape it to favor near-field detail:
- Example: $f = smoothstep(0.0, 1.0, x)$
- Optional: $f = pow(f, 0.8)$ to bias toward high detail near the camera.

## Shader LOD Guidance
- **Layered noise**: Use 3–6 layers with per-layer fade using continuous LOD.
- **Texture detail**: Blend between a coarse base and fine detail; avoid hard swaps.
- **Temporal stability**: Don’t increase time frequency with LOD unless required.
- **Uniform naming**: Use `uLOD` for the normalized LOD factor.

## Particle/Trail LOD Guidance
- **Spawn rate**: Scale with LOD first; then reduce particle lifetime and size.
- **Batching**: Prefer fewer larger particles at low LOD.
- **Update step**: Consider decimating update frequency for low LOD if stable.

## CPU/System LOD Guidance
- **Simulation**: Reduce tick rate or skip updates for distant objects.
- **AI/Logic**: Defer expensive computations when below a minimum LOD.
- **Networking**: Reduce update frequency or precision for low LOD objects.

## Graphics Settings (Future)
Introduce a global `GraphicsQuality` setting that clamps or scales LOD:
- **Low**: Clamp max LOD to 0.4–0.6
- **Medium**: Clamp max LOD to 0.7–0.85
- **High**: Allow full LOD (1.0)
- **Ultra**: Allow extended high-frequency detail (1.0+)

## Editor Parity Rules
- The system designer must use the same LOD driver and mapping as runtime.
- The editor must not introduce additional visual shortcuts.
- Any editor-only optimizations must be opt-in and clearly labeled.

## Validation Checklist
- LOD transitions are visually smooth (no popping).
- Performance scales measurably with LOD changes.
- LOD factor is deterministic and logged for debugging.
- Shader and CPU systems use the same normalized LOD factor.

## Versioning
- LOD standard changes must be recorded with a short changelog entry below.

### Changelog
- 2026-02-09: Initial draft.
