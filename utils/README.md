# 🤖 Copilot Communication Utils

This folder contains tools for asynchronous communication between Copilot and the user via mobile device.

## Standard Practice for Copilot

### When Starting Listen Mode

1. Run: `npx tsx notify.ts "Your status message here"`
2. This sends a push notification and starts the messenger server
3. **Continuously check** `messenger/messages.json` for new user messages

### Message Handling Rules

| User Message Contains | Copilot Action |
|----------------------|----------------|
| **"Implement"** | STOP the server, close listen mode, and begin implementing the requested task |
| Anything else | REPLY via the messenger (add a message to messages.json), stay in listen mode |

### How to Reply to User

1. Read `messenger/messages.json`
2. Add a new message object:
```json
{
  "id": "<unique-id>",
  "from": "copilot", 
  "text": "Your reply here",
  "timestamp": <Date.now()>,
  "read": false
}
```
3. Save the file - the WebSocket will broadcast to the user's phone automatically

### Example Workflow

```
1. Copilot finishes a task
2. Copilot runs: npx tsx notify.ts "Finished implementing shaders. Need input: should I add glow effects too?"
3. User receives push notification, opens messenger
4. User types: "Yes, add glow effects"
5. Copilot sees message, replies: "Got it! Anything specific about the glow?"
6. User types: "Implement: Add glow with radius 50px and orange color"
7. Copilot sees "Implement" keyword, stops server, begins coding
```

### Status Message Guidelines

When starting listen mode, the status message should include:
- ✅ What was just completed
- ❓ What input/decision is needed (if any)
- 📋 What's next on the agenda (if known)

Example:
```
npx tsx notify.ts "✅ Completed: Shader files created (sun.vert, sun.frag)
❓ Need input: Should I integrate these into the renderer now, or work on the glow shader first?
📋 Remaining: PixiRenderer refactor, Game.ts updates"
```

## Files

| File | Purpose |
|------|---------|
| `pushover.ts` | CLI for sending push notifications |
| `notify.ts` | Combined: starts messenger server + sends notification + shows status |
| `messenger/server.ts` | WebSocket server (standalone, used by notify.ts) |
| `messenger/index.html` | Mobile-friendly chat UI |
| `messenger/messages.json` | Message history (read/write this for communication) |

## Commands

```bash
# Just send a push notification (no server)
npx tsx pushover.ts "Message" "Title"

# Start messenger with status (preferred for starting listen mode)
npx tsx notify.ts "Your status message"

# Send a message to the running messenger (use this to reply!)
npx tsx send.ts "Your reply message"

# Start messenger standalone (no initial message)
npx tsx messenger/server.ts
```

## How to Reply to User (Preferred Method)

While the messenger server is running, use the send.ts CLI:
```bash
npx tsx send.ts "Got it! Working on that now..."
```

This sends an HTTP POST to the server which broadcasts via WebSocket to the phone instantly.

## Network Info

- Local: http://localhost:3001
- Mobile: http://<your-local-ip>:3001 (check terminal output)
- User must be on same WiFi network

## Important Notes

1. **Never stop listening** unless user says "Implement"
2. **Always reply** to non-implement messages to confirm you received them
3. **Check messages frequently** while in listen mode (every few seconds)
4. **Include context** in status messages so user knows what's happening
5. Messages are stored in `messages.json` - this persists between server restarts
