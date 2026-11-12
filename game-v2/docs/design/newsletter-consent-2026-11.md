# Newsletter consent (November 2026)

We will start sending a development newsletter by email when the game updates. Before that, every account is asked whether it wants it. This records the answers. **Nothing is sent yet: there is no newsletter system, no export of addresses.**

## What is kept

One row per account that has answered, in the lobby (`server-browser/src/newsletter/`): Postgres table `newsletter_consent`, or `data/lobby/newsletter.json` in local dev.

| Field | Meaning |
|---|---|
| `user_id` | the account (the row goes when the account is deleted) |
| `newsletter` | they want the newsletter |
| `newsletter_asked` | they have been asked |
| `newsletter_at` | when the answer last changed (epoch ms) |
| `newsletter_via` | where: `signup`, `prompt` or `settings` |

An account with **no row** has not been asked and has not consented. That is every account from before this existed, with no migration of the `users` table: the table is added with `CREATE TABLE IF NOT EXISTS` at lobby start (and in `server-browser/schema.sql`), nothing else changes.

Guests have no account and no email: they are never asked and never consent.

## What counts as asked

An account is asked only when a person gave an explicit yes or no:

- choosing in a sign-up form,
- pressing Yes or No thanks on the website's one-time question,
- changing the setting on the account page.

Nothing else marks an account as asked. Seeing the question and moving on, pressing "Ask me later", or signing in does not.

## Sign-up: a choice, not a default

Every form that makes an account asks "Email newsletter: development news, updates, etc." with two options, "Yes, sign me up" and "No thanks". Neither is picked to begin with, and the account cannot be made until one is. There is no checkbox and no default to flip. Without a choice the form says "Choose yes or no for the newsletter".

The three forms:

- The game's sign-in screen, Create Account tab (`client/src/ui/LoginUI.ts`).
- A guest registering from inside the game (`client/src/ui/guest/guestBanner.ts`). The account is made at the lobby the same way, so this is a sign-up like the others.
- The website's `/register` (`site/src/views/pages.ts`, checked again in `site/src/app.ts`).

The game's two forms share one radio group (`client/src/ui/join/newsletterChoice.ts`) and one call (`lobbyRegister` in `client/src/network/lobby.ts`), which takes the answer as a required boolean. The website has the same group in `site/src/views/newsletter.ts`. It is a `<fieldset>` with a `<legend>` and two radio inputs, so it works from the keyboard and reads as one question to a screen reader.

The lobby records what `/auth/register` carried: `newsletter: true` or `false` is the answer (asked, via `signup`). If the field is missing or is not a boolean (an old cached client), the account is still made, with no row: not asked, not consenting. The website then asks them. Neither answer is ever assumed.

## Existing accounts: the one-time question

A signed-in visitor whose account was never asked sees a small panel at the top of every website page: the same sentence with **Yes, sign me up** and **No thanks**, and an "Ask me later" button. Nothing is preselected.

- Yes or No: recorded (via `prompt`), and the panel is gone for good.
- Ask me later: hidden until the browser is closed (a session cookie, `nl_later`). Nothing is recorded.
- Ignoring it: nothing is recorded; it is there on the next page.

The website knows who to ask because the lobby's session check (`/auth/validate`) now says `newsletterAsked`.

## The setting

The `/account` page has an "Email newsletter" panel: what it is, On or Off, and one button to change it (via `settings`). It can be changed any time.

## Endpoints

Lobby (token in the body; the account is always the session's own):

- `POST /newsletter/get { token }` → `{ newsletter, asked, at, via }`
- `POST /newsletter/set { token, newsletter: true|false, via: 'prompt'|'settings' }`
- `POST /admin/newsletter` (behind `LOBBY_ADMIN_SECRET`) → `{ accounts, consented, declined, notAsked }`: counts only.
- `/auth/register` takes `newsletter`; `/auth/validate` adds `newsletterAsked`; `/auth/account` adds `newsletter` and `newsletterAsked`.

nginx does not expose `/newsletter/`: the website calls it from its own server, and the game only sends the answer inside `/auth/register`.

Website (all POST, all behind the site's CSRF check): `/account/newsletter/answer`, `/account/newsletter/later`, `/account/newsletter/set`.

The owner sees the counts on the admin panel's "Pilots & bans" page.

## Before the first newsletter is sent

Not built, and needed first: a way to send, an unsubscribe link in every email (it can call the same setting), an export of the addresses of accounts with `newsletter = true`, and a privacy note on the site saying what the address is used for.

## What we tell people

The website's `/privacy` page says the newsletter is only sent to those who said yes and can be turned off on the account page (`site/src/views/legal.ts`). Each sign-up form and the one-time question link to it.
