# client/src/rendering: context pointer
Read only the guide for your task (never open Renderer.ts whole; its section map is in the guide):
- World, sky, star, planets, surfaces, asteroids, lighting, bloom, particles, shader warm-up, asset cache, quality tiers: docs/areas/render-world.md
- Ship hulls, `lighting/ShipBatch.ts`, decor, ship effects, native renderer stills: docs/areas/render-ships.md
- Every generated asset needs a `*_VERSION` through `client/src/assets/assetCache.ts`; every new shader goes in `gameShaders.ts`. The sandbox and the labs live in `client/tools/` (outside `src/`, with the old star renderers in `tools/legacy/`).
