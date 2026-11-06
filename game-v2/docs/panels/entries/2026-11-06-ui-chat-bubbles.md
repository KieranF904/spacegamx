---
date: "2026-11-06"
category: "ui"
topic: "chat bubbles"
files:
- "chat-bubbles/bubbles-flight-near-before.png"
- "chat-bubbles/bubbles-flight-near-after.png"
- "chat-bubbles/bubbles-flight-near.png"
- "chat-bubbles/bubbles-flight-far-before.png"
- "chat-bubbles/bubbles-flight-far-after.png"
- "chat-bubbles/bubbles-flight-far.png"
- "chat-bubbles/bubbles-map-before.png"
- "chat-bubbles/bubbles-map-after.png"
- "chat-bubbles/bubbles-map.png"
---
Public chat now shows as bubbles over the pilot's ship (client/src/ui/bubbles): hull-plate glass like the join screen, the pilot's name on a tab on the top bubble (yours amber, others blue), a tail on the bottom one pointing at the ship, wrapped at 260px, five lines at most and long lines cut at a word with an ellipsis. The same size at any zoom (zoom 0.7 and 0.22 here, a stack of three of mine and one from a bot), anchored above the ship as drawn. A new line arrives at the bottom and the older ones glide up; each fades in and out, staying 4.5 to 11 s by length, four to a pilot and 36 in all. On the system map pilots within the focus radius plus a cell and a half get bubbles too: live ones follow their ship, ones past the focus grid (rockery_bot_9 and 10 here, 28 to 30 km out) take a place from the map feed once a second and ease to it. Hidden with the chat box (Settings or the chat's hide button) and in shoot.mjs shots unless a step asks for them. Before is the same moment with the bubbles hidden (before this change the line was only in the chat box, which shots hide); live game on a scratch server, the bot lines sent to the client as the server sends a chat.
