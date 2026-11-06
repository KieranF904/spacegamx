---
date: "2026-11-07"
category: "website"
topic: "database as the component guide"
files:
- "2026-11-07/website-database/database-parts-1440-before.png"
- "2026-11-07/website-database/database-parts-1440-after.png"
- "2026-11-07/website-database/database-parts-phone-before.png"
- "2026-11-07/website-database/database-parts-phone-after.png"
- "2026-11-07/website-database/database-parts-weapons-open-1440-after.png"
- "2026-11-07/website-database/database-parts-structure-open-1440-after.png"
- "2026-11-07/website-database/database-parts-open-phone-after.png"
- "2026-11-07/website-database/database-part-entry-1440-before.png"
- "2026-11-07/website-database/database-part-entry-1440-after.png"
- "2026-11-07/website-database/database-index-1440-before.png"
- "2026-11-07/website-database/database-index-1440-after.png"
- "2026-11-07/website-database/database-items-1440-after.png"
---
The website's Database Parts tab now reads like the game's component guide instead of a table: the guide's category tabs (Structure, Weapons, Engines & jump, Power, Shields & plating, Utility, plus All), rows sorted by the level a part opens at, each row its level, its picture, its name, what gates it (level, licence, a boss part) and what making it takes as item chips. A row opens without any script to its trade-off line, family, size, grade, key numbers, mounting, fabricating time, where its rare parts drop, its numbers and its cost, with a link to the full entry. Structure is one row per material (hull, armour and cargo in it, with a table), as in the game. Adapted for the web: wider rows with a key-numbers column, a two-column opened row on desktop and one column on a phone, a sideways-scrolling tab row on a phone, and every row linkable (/database/parts#cannon_hammer opens it). The pictures are the game's own: `npm run build-part-images` (in site/) draws every component and item icon with the client's component guide drawing code in headless Chrome, into WebP files the site serves; part entries and the items list use them too. The guides page is hidden (SITE_GUIDES=1 brings it back), so the after shots have no Guides link. Shots from a local site on a spare port with the snapshot catalog.
