# Admin chat from the website (November 2026)

An admin can talk to pilots who are in the game from the website's admin panel, on a phone. The join notice on the owner's phone no longer says who joined (see below), so this page is also where to look: it lists who is on.

## Using it

- **Where:** the website, Admin, **Chat** tab: `/admin/chat`. The Activity page has a button to it. Admins and the owner only.
- **Who is on:** each connected game server with its pilots: name, guest or not, and since when. It refreshes every 3 seconds.
- **To everyone on a server:** pick "Everyone", write, Send. In the game it shows in chat as from `[Admin] yourname`.
- **To one pilot:** tap their name, write, Send. They get it as a private message from your account name, with one line the first time saying you are an admin writing from outside the game and how to reply.
- **Replies:** the pilot answers the normal way (`/w yourname message`, or replying in their private messages). The reply shows in the conversation on the page. Public chat stays on the Activity page as before.
- **Not online:** the page says so and nothing is sent. For an account (not a guest) the message can be left in their in-game inbox instead.

## How a message travels

```
admin's phone -> website (admin session, CSRF) -> lobby (admin secret, server side only) -> game server -> pilot's chat
pilot's reply  -> game server -> lobby admin log -> website page
```

1. The site (`site/src/routes/adminChat.ts`) checks the admin's session and CSRF token, then calls the lobby with `LOBBY_ADMIN_SECRET` and the admin's name (`site/src/adminChat.ts`). A browser never has the secret.
2. The lobby (`server-browser/src/adminchat/routes.ts`) checks that name is an admin who isn't banned, checks the pilot is on that server, logs the message, and holds it for the server.
3. The game server asks the lobby every 2 seconds while anyone is on, every 10 when nobody is (`server/src/adminChatLink.ts`, `POST /admin/chat/poll`). The same call tells the lobby who is on, hands over pilots' replies, and reports private messages whose pilot had left. There was no way for the lobby to call a game server, and this needs none.
4. The game server shows it (`server/src/game/AdminChat.ts`) using the chat and private-message messages the client already understands. **The wire protocol is unchanged.**
5. A pilot's private message to a name that isn't in the game normally gets "offline". Now `Social.whisper` first asks whether that name is a website admin who wrote on this server in the last day; if so the message is kept for the lobby and the pilot sees it as sent.

**Worst-case delay:** about 2 seconds from Send to the pilot's chat; about 5 seconds from a pilot's reply to the admin's page (2 for the game server's next ask, 3 for the page's refresh).

A message is handed to the server until the server says it has it, then never again. If the server stops asking for a minute, the message is marked not delivered.

## What is kept, and who can read it

The **admin message log**: every message an admin sent this way, and every private reply to an admin, with the admin, the pilot, the server and the time. Lobby table `admin_messages` (made at lobby start with `CREATE TABLE IF NOT EXISTS`; `data/lobby/admin-messages.json` in local dev). The newest 5000 rows are kept.

Only admins can read it, through the Chat tab. It is separate from the activity feed: private messages are still never in the feed. The privacy page says private messages between a pilot and an admin are kept in an admin message log.

## Limits

- 300 characters a message, each way. Longer is refused, not cut.
- 30 sends a minute per admin (the site and the lobby both count).
- Pilots' replies go through the game's existing private-message limit.
- Names and text are escaped wherever they are shown.

## Join notices without names

The phone notices no longer carry a pilot's name or any account detail: "A pilot joined. 3 online." / "A guest joined. 3 online." (`server/src/auth/pushover.ts`) and "A new account was registered." (`server-browser/src/accounts/pushover.ts`). To see who it was, open `/admin/chat`.

## Not built

- No push to the admin's phone when a pilot replies: the page has to be open.
- A message can't be sent to a pilot on a server other than the one chosen; each server has its own roster.
- Regional game servers that can't reach the lobby's `/admin/` routes can't take part (the same as bans, friends and rankings today).
