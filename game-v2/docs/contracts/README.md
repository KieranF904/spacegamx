# Contracts

A contract is a short header at the top of a file that says, before you open the file, what it owns, what it may use, what must stay true and where to add a case. The index of all of them is [registry.md](registry.md) (generated; [registry.json](registry.json) has the same data).

## The header

A JSDoc block at the very top of the file (after any shebang). First line `@contract <id>`, with a short kebab or dot id that is unique across the repo (`server.chat`, `protocol.trade`, `client.ship.prediction`). Then one field per line, each starting ` * <field>:`; continuation lines are indented three or more spaces.

```ts
/**
 * @contract server.chat
 * owns:       chat commands and channel routing for GameServer
 * needs:      ChatHost (send, tell, pilotsIn), common/network/chatProtocol
 * events:     (optional) hooks it fires or handles
 * invariants: slash commands never reach other pilots — server/src/game/chat.test.ts
 *             message order per channel is kept — none pinned
 * extend:     a new slash command is one entry in COMMANDS below
 */
```

- `owns`: what the file is responsible for. One or two lines, no history.
- `needs`: the modules, capabilities and host members it may use. Name every npm package it imports (the check warns when one is missing).
- `events`: optional. Hooks it fires or handles.
- `invariants`: one per line, each ending with ` — <test file relative to game-v2>`, or a golden in `server/src/golden` (`tickOrder.json`), or `none pinned`. Name a test only if it really pins the line.
- `extend`: the one place to add a new case.

## Which files get one

Files that are contract-shaped and mostly mechanical: hub entry points and the per-area modules split out of a hub, protocol message files, row kinds, tables, registries, feature index files. Not experimental code, and not prose-heavy code where the header would only repeat the design doc. Generated files (`features/registry.ts`, the server and client `features/index.ts`) take no header: the generator would erase it.

## Regenerate and check

```
npm run contracts:gen      rewrite docs/contracts/registry.md and registry.json
npm run contracts:check    fail if the registry is stale or a header is broken
```

The registry adds what the code already knows: line count, exports, section ranges (top-level declarations with their lines) and a list of executable contracts (feature `contract.test.ts` suites, `server/src/golden` pins, `satisfies Record<...>` tables). Never edit it by hand. A vitest (`scripts/contracts/registry.test.ts`) runs the check in the normal suite.

The check fails on: a stale registry, a header without `owns`, `needs`, `invariants` or `extend`, a duplicated id, an invariant naming a test that does not exist. It warns (does not fail) on a contracted file over 800 lines ("split candidate") and on an npm package the file imports that its `needs` line does not mention.

## The rule

Any change to what a file owns or needs updates its header in the same commit. Any change to a contracted file's size or exports changes the registry, so run `npm run contracts:gen` and commit the result with it.
