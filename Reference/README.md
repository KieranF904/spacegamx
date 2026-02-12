# ⚠️ REFERENCE ONLY - DO NOT MODIFY ⚠️

This folder contains the **original game code** for reference purposes only.

## IMPORTANT RULES FOR AI ASSISTANTS

1. **NEVER create files** in this folder or any subfolder
2. **NEVER modify files** in this folder or any subfolder  
3. **NEVER delete files** from this folder (except accidental additions)
4. **READ ONLY** - Use this code as a reference for understanding the original implementation

## Correct Working Directory

All new development and modifications should be made in:

```
c:\Users\Kieran\Desktop\Spacegame\game-v2\
```

NOT in:
- `Reference/ball/game-v2/` ❌
- `Reference/ball/game/` ❌
- `Reference/` anything ❌

## Folder Structure

```
Spacegame/
├── game-v2/          <-- ✅ WORKING CODE - Make changes here!
│   ├── client/
│   ├── server/
│   ├── common/
│   └── data/
├── Reference/        <-- ⛔ READ ONLY - Never modify!
│   ├── README.md     (this file)
│   └── ball/         (original game source)
│       ├── game/           (original Canvas2D client)
│       └── game-server/    (original server)
└── MIGRATION_CATALOG.md
```

## What's in Reference/ball/

- `game/` - Original Canvas2D single-player game (simulation.html)
- `game-server/` - Original multiplayer server
- `dev-tools/` - Development utilities
- `server-browser/` - Server browser component

Use these as reference for:
- Understanding original rendering (Canvas2D gradients, effects)
- Replicating game mechanics
- Matching visual appearance
- Understanding data formats
