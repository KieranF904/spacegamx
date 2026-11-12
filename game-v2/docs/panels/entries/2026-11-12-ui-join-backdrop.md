---
date: "2026-11-12"
category: "ui"
topic: "join backdrop"
files:
- "2026-11-12/join-backdrop/before-join-1280x800.png"
- "2026-11-12/join-backdrop/after-join-1280x800.png"
- "2026-11-12/join-backdrop/before-join-800x1100.png"
- "2026-11-12/join-backdrop/after-join-800x1100.png"
- "2026-11-12/join-backdrop/before-join-1920x1080.png"
- "2026-11-12/join-backdrop/after-join-1920x1080.png"
- "2026-11-12/join-backdrop/after-join-glide.png"
- "2026-11-12/join-backdrop/after-login-1280x800.png"
numbers: "Before: six CSS dots on a 240 px tile, repeated across the screen · After: Sol's sky by the game's renderer (stars and nebula, no bodies), no new canvas, no new assets · The sign-in screen's bodies leave by one 10 s camera move (a tilt that takes everything down the screen and a push-in, worked out so every body, rings too, is out of frame at the end; the sun's leftover plasma fades over the last 3 s) while the sky pans and pushes in gently with them (reduced motion: a 0.25 s fade, no pan) and are then not updated or drawn"
---
The join screen's background was a CSS pattern: six star dots on a 240 px tile, repeated, over a flat gradient with an orange glow at the bottom. It is now the sign-in screen's own sky, which carries on under the join screen: Sol's nebula, haze and drifting stars, drawn by the game's renderer, under a see-through scrim so the plates and the small print read. The sun, the planet and the small body belong to the sign-in screen alone: going to the join screen each glides out of the frame, away from the screen's centre (after-join-glide is a moment of it, about 0.45 s in), and they glide back in when the sign-in form returns (after-login: the form after Log out, bodies back). Shots with shoot.mjs on the dev server, as a guest.
