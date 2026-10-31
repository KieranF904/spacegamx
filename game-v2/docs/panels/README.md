# Before/after panels: adding one

1. Put the images in `<date>/<category>/` as `<topic>-before.png`, `<topic>-after.png` and `<topic>.png`; nothing is drawn on them.
2. Add one file `entries/<date>-<category>-<topic>.md`: front matter (`date`, `category`, `topic`, `files`, optional `numbers` and `status`), then the one-line description as the body.
3. From `game-v2/`, run `npm run panels:index` to regenerate `index.md`; never edit `index.md` by hand.
4. Skipped items go in `entries/<date>-skipped-<topic>.md` with `status: skipped` and the reason as the body; prose that fits no row goes in `entries/<date>-notes-<topic>.md` with `category: notes`.
5. Items marked after only, awaiting review or prototype take that status in front matter, and the table shows it.
