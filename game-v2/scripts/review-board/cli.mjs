// Claude's side of the review board (see server.mjs). Works on the file directly; the server need not be running.
//   node scripts/review-board/cli.mjs post <batch.json>   add a batch: { "title": "...", "items": [{ "title", "body"?, "options"?: [] }] }
//   node scripts/review-board/cli.mjs new                 answers not read yet (and marks them read)
//   node scripts/review-board/cli.mjs list [batchId]      every item with its answer, by batch
//   node scripts/review-board/cli.mjs archive <id|batchId>...   take settled items off the phone's list
import fs from 'fs';
import { load, update, newId, now } from './store.mjs';

const [cmd, ...args] = process.argv.slice(2);

const line = (it) => {
  const a = it.answer;
  const ans = a ? [a.choice && `[${a.choice}]`, a.text].filter(Boolean).join(' ') : '(no answer)';
  return `- ${it.id} ${it.title}\n    -> ${ans.replace(/\n/g, '\n       ')}`;
};

if (cmd === 'post') {
  const spec = JSON.parse(fs.readFileSync(args[0], 'utf-8'));
  if (!spec.title || !Array.isArray(spec.items) || !spec.items.length) throw new Error('a batch needs a title and items');
  const out = update((board) => {
    const batch = { id: newId(), title: String(spec.title), created: now() };
    board.batches.push(batch);
    const items = spec.items.map((s) => ({
      id: newId(), batch: batch.id, title: String(s.title), ...(s.body ? { body: String(s.body) } : {}),
      ...(Array.isArray(s.options) && s.options.length ? { options: s.options.map(String) } : {}), created: now(),
    }));
    board.items.push(...items);
    return { batch, n: items.length };
  });
  console.log(`posted "${out.batch.title}" (${out.batch.id}): ${out.n} items`);
} else if (cmd === 'new') {
  const fresh = update((board) => {
    const list = board.items.filter((i) => i.answer && !i.seen && !i.archived);
    for (const i of list) i.seen = now();
    return list.map((i) => ({ ...i, batchTitle: board.batches.find((b) => b.id === i.batch)?.title }));
  });
  if (!fresh.length) console.log('no new answers');
  let last = '';
  for (const it of fresh) {
    if (it.batchTitle !== last) { console.log(`\n## ${it.batchTitle}`); last = it.batchTitle; }
    console.log(line(it));
  }
} else if (cmd === 'list') {
  const board = load();
  for (const b of board.batches) {
    if (args[0] && b.id !== args[0]) continue;
    const items = board.items.filter((i) => i.batch === b.id);
    const open = items.filter((i) => !i.answer && !i.archived).length;
    console.log(`\n## ${b.title} (${b.id}) — ${items.length} items, ${open} unanswered`);
    for (const it of items) console.log(line(it) + (it.archived ? '  (archived)' : ''));
  }
} else if (cmd === 'archive') {
  const n = update((board) => {
    let c = 0;
    for (const i of board.items) if (!i.archived && (args.includes(i.id) || args.includes(i.batch))) { i.archived = now(); c++; }
    return c;
  });
  console.log(`archived ${n}`);
} else {
  console.log('usage: cli.mjs post <batch.json> | new | list [batchId] | archive <id|batchId>...');
}
