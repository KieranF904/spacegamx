# Contributor notes

Contributors (and admins, who are contributors by right) pin notes and shapes to a system's map in game: "place a large water planet here, the size of this circle". The notes are for whoever builds the game next, and that can be an assistant working in this repo.

## The rank

- An admin grants it in chat: `/contributor <name> on`, takes it away with `/contributor <name> off`, and lists who has it with `/contributors`. A name that isn't online is kept and applies when that account next signs in. Guests can't have the rank.
- The rank is stored on the game server in `data/contributor/contributors.json` (account id and username). It isn't stored in the lobby's account store, because the lobby has no way for a game server to change an account.
- The admin panel (F2) Players tab shows a `contrib` tag next to anyone who has it.
- The client learns its rank from `authResult.isContributor`. If the rank changes while someone is signed in, they get a `contribRank` message.

## In game

- **F6** opens the panel and turns the overlay on. **Shift+F6** turns the overlay on or off without the panel. The **✎ NOTES** button at the bottom left does the same.
- **Quick note:** the box at the top of the panel pins whatever you type to where your ship is (Ctrl+Enter or the button). Meant for jotting while playtesting. On the dev server everyone, guests included, gets the panel.
- **Placing a note:**
  1. Pick a shape: pin, circle, ring, rectangle, line, arrow or polygon.
  2. Click in space, or on the system map (M), to place it. Drag to size it. To make a polygon, click each corner, then right-click or press Enter to close it. Esc cancels.
  3. Choose how it moves:
     - fixed in place;
     - orbiting the system centre;
     - orbiting the nearest planet or moon;
     - attached to the nearest body (planet, moon, station, nest or lodestone).

     The panel suggests one based on where you clicked. **Match** sets the period to that of the body at that spot.
  4. Add a title, the note, an optional size hint and a colour, then save.
- **The list** shows every contributor's notes, in this system or in every system. You can filter it by author (Everyone's, Mine, or one person) and by status, and sort it newest first or most liked first (thumbs up minus thumbs down). Each row shows the author, when it was made, an "edited" mark, and its counts of thumbs up, thumbs down and comments. Each note has these buttons:
  - **Open**: the detail view (clicking the row does the same).
  - **Fly**: the autopilot takes you there.
  - **Look**: the camera moves to the note. Esc brings it back. Only for notes in the system you're in.
  - **Warp**: a dev tool (the owner, or anyone on a dev server).
  - **Edit**, **Delete** and **status** (open, done, won't do): on your own notes only. Admins can use them on any note.
- Notes are drawn only while the overlay is on. Notes marked done or won't do are drawn dimmed and dashed. Your own notes have a white dot in the pin and "you" under it. Other people's show their name, and the note's score when it has one.

## Other people's notes: votes and comments

- **Who sees what.** Every contributor (and admin) sees every contributor's notes, with the author's name and the time. Players without the rank see nothing and are sent nothing, as before.
- **The detail view.** Click a row in the list, or click someone else's note in space while the panel is open. It shows the note in full, who wrote it and when, whether it was edited (when, and by whom if that wasn't the author), its votes and its comments. **← Notes** goes back to the list.
- **Editing.** You can edit and delete your own notes: the text, title, colour, shape, where it is and how it moves. An edited note is marked "edited" with the time. Its comments and votes stay with it.
- **Votes.** A thumbs up or a thumbs down on anyone's note but your own. One vote per account per note. Pressing the other thumb changes it, pressing the same thumb takes it back. Everyone sees the counts. Nobody is shown who voted.
- **Comments.** Any contributor can comment on any note, their own included. The thread is flat, oldest first, with each comment's author and time. Ctrl+Enter posts. You can delete your own comments.
- **Admins** can edit and delete any note, set any note's status and delete any comment, from the same panel. Those buttons are only shown to admins. An admin's edit of someone else's note is marked "edited ... by <admin>". On the dev server guests are admins, so they get the same buttons there.
- Changes reach every contributor with the overlay on straight away.

| | Your own note | Someone else's note | As an admin, any note |
|---|---|---|---|
| See it | yes | yes | yes |
| Edit, delete, set status | yes | no | yes |
| Thumbs up or down | no | yes | yes (not on your own) |
| Comment | yes | yes | yes |
| Delete a comment | your own comments | your own comments | any comment |

## Fetching them from the terminal

```
node scripts/contributor-notes.mjs                         # open notes, every author
node scripts/contributor-notes.mjs --author brotherk3d     # case-insensitive
node scripts/contributor-notes.mjs --system sol --status all
node scripts/contributor-notes.mjs --json                  # the same, as JSON, with positionNow
node scripts/contributor-notes.mjs --mark-done n_ab12cd34ef --note "Added Halcyon II to sol (systems.json)"
node scripts/contributor-notes.mjs --mark-wontdo <id> --note "why"   |   --reopen <id>
```

- The script reads `/opt/spacegame/data/contributor/notes.json` and `clock.json` over ssh, the same way the deploy connects (`root@brotherk3d.com`, `~/.ssh/bk3d_deploy`). Nothing is served over HTTP.
- Other sources: `--local [dir]` reads a local `data/contributor` folder, and `--file <notes.json>` reads a single file. Common must be built first (`npm run build:common`).
- For each note it prints:
  - the author, system, title and full text;
  - the shape, with sizes in world units;
  - how it moves: the orbit's radius, what it goes round, its period, direction and phase, written out as a ready-to-use `systems.json` orbit (`{radius, phase (radians), period (minutes, negative = the other way)}`), or the body it's attached to and the offset from it;
  - its position now;
  - its status and dates, with the edit time if it was edited;
  - its votes (thumbs up, thumbs down and the score);
  - its comments, each with its author and time.
- `--json` adds `positionNow` and the `votes` counts to each note, and leaves out who voted.
- **Marking a note** writes an op to the server's `data/contributor/inbox/`. The server applies it within about five seconds (or when it next starts) and tells contributors who have the overlay on.

## How positions work

- Orbits use the same maths as planets and nests (`common/src/world/planets.ts`, `nests.ts`): `angle = phase + 2π · tick / (period · 3600)`, round the centre, a planet or one of its moons. Attached notes follow the body: `planetPosition`, `moonOffset`, the station's Kepler orbit, `nestPosition`, or a lodestone's orbit.
- `phaseDeg` is the angle at tick 0, as in `systems.json`. The server tick starts at 0 when the server starts, so a note keeps its place relative to the planets across restarts.
- The script estimates the current tick from `clock.json`, which the server rewrites every 30 s. If that clock is stale, the script says so.

## Files and limits

- Code:
  - `common/src/world/contributorNotes.ts`: the model, validation, positions and the terminal format;
  - `common/src/world/contributorFeedback.ts`: who may edit, delete, vote and comment; comments, the vote tally, what a viewer is sent, the sort;
  - `common/src/network/contributorProtocol.ts`: the messages;
  - `server/src/game/ContributorNotes.ts`: the server side;
  - `client/src/ui/ContributorPanel.ts`: the panel;
  - `client/src/ui/contributorModel.ts`: the list's filter and sort, which controls a viewer gets, the detail view's markup;
  - `client/src/rendering/contributorDraw.ts`: drawing the notes.
- Data lives in `data/contributor/` (`notes.json`, `contributors.json`, `clock.json`, `inbox/`). Files are written atomically. Deploys leave the folder alone, the same as `data/telemetry`.
- Storage: comments and votes are kept on the note in `notes.json`, in three optional fields. The file's `version` is still 1. A note saved before these fields existed loads unchanged and reads as no comments and no votes.
  - `editedAt` (and `editedBy` when an admin edited someone else's note);
  - `comments`: a list of `{ id, author, authorId, at, text }`, oldest first;
  - `voters`: `{ "u<account id>": 1 or -1 }` (a guest on a dev server is keyed `n:<name>`). This field never leaves the server: a client gets `votes: { up, down, mine }` instead.
- Messages: the `contrib` client message has three more ops, `comment`, `commentDelete` and `vote`. There are no new message types. A change to a note's comments or votes goes out as the `contribNote` message that edits already use.
- Limits:
  - text lengths: a title up to 80 characters, a note up to 2000, a size hint up to 120, a resolution up to 500 and a comment up to 500;
  - up to 50 comments on one note;
  - up to 200 notes per contributor (1000 for an admin) and 5000 in all;
  - a polygon has at most 32 corners;
  - every number must be finite and within ±5,000,000 world units;
  - the system and any body a note refers to must exist;
  - 20 changes (comments count as changes), 60 votes and 40 lists per minute for each connection.
