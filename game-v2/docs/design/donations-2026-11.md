# Donations (November 2026)

Pilots can support the game through PayPal. A donation is recorded against the account that made it, so the owner can see who gave what and may later add cosmetic donator perks. Donations never buy power.

## Where things are

- Strip above the sign-in and join panels: `client/src/ui/join/supportLinks.ts` ("Support the game", and "Discord" once `DISCORD_URL` in that file is set).
- Donation page: `client/support.html` + `client/src/support/` (a second Vite entry, served at `/support.html` on the game's origin).
- Server side: the lobby, `server-browser/src/donations/` (`routes.ts`, `paypal.ts`, the two stores).
- Owner's view: the website's admin panel, Donations tab (`site/src/routes/donations.ts`), owner only.
- A pilot's own history and inbox on the website: `/account/donations`, `/account/inbox` (`site/src/routes/mine.ts`, `site/src/playerLobby.ts`).

## Flow

1. The page asks `POST /donations/config { token? }`: PayPal's public client id, limits, who is signed in and their total so far.
2. The pilot picks an amount ($3, $5, $10, $20 or their own; $1 to $500) and presses a PayPal button.
3. `POST /donations/create { token?, amount }`: the lobby checks the amount, makes a PayPal order (Orders v2, intent CAPTURE, USD) and stores a `CREATED` row with the session's account id (or none for a guest). It answers with the order id only.
4. The pilot approves in PayPal's own window.
5. `POST /donations/capture { orderId }`: the lobby captures the order and, if PayPal says `COMPLETED`, marks the row `COMPLETED` with PayPal's capture id and PayPal's amount.
6. The page says thank you.

## Trust boundary

- Card and PayPal login details are typed into PayPal's frames. They never reach our page's code or our server.
- The browser holds only the public client id. The client secret is read by the lobby from its environment and sent only to PayPal's token endpoint. Errors and logs carry PayPal's status, error name and debug id, nothing else.
- Nothing the browser says about a payment is believed. The amount is checked at create; the amount, currency and status recorded come from PayPal's capture answer; the account comes from the row the lobby wrote at create. The capture call takes an order id and nothing else.
- Capture only works for orders this lobby made. A row already `COMPLETED` is answered without asking PayPal again, and the update refuses to touch a `COMPLETED` row, so a repeat or a double click counts once. `paypal_order_id` and `capture_id` are unique.
- No cookies are used: the session token rides in the request body like every other lobby call, so another site cannot act as a signed-in pilot.
- Limits per address: 40 donation calls a minute, 8 new orders per 10 minutes.

## Data stored

Table `donations` (Postgres, made at lobby start with `CREATE TABLE IF NOT EXISTS`; `data/lobby/donations.json` in local dev): id, user_id (nullable), amount (cents), currency, paypal_order_id, capture_id, status, created_at, completed_at.

No payer name, email, address or PayPal payer id is kept. Deleting an account keeps its rows with user_id cleared. Orders nobody paid are dropped after a week.

For perks: `DonationRoutes.donatedTotal(accountId)` gives an account's completed total in cents.

## Switching it on

Keys: `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`.

- Local dev: in the git-ignored `game-v2/.env` (never `dev.env`, which is tracked). Dev only takes `PAYPAL_ENV=sandbox`.
- Production: `/etc/spacegame/secrets.env`; `deploy/vps/deploy.sh` copies the three lines from `.env`. Production only takes `PAYPAL_ENV=live`, so sandbox keys leave it off.
- No keys, or keys for the wrong side: donations are off. The page says "unavailable", the endpoints answer 503, everything else runs.

## Going live

1. In the PayPal developer dashboard make a Live REST app; take its client id and secret.
2. Put them in `.env` with `PAYPAL_ENV=live` just before deploying (or edit `/etc/spacegame/secrets.env` on the box and restart `spacegame-browser`). Put the sandbox ones back in `.env` afterwards for dev.
3. Deploy: it ships the new nginx routes (`/lobby/donations/`, `/support.html`) and the lobby makes the table.
4. Check the lobby log line `[Donations] on (PayPal live)`.
5. Make one real $1 donation signed in and one signed out. Check the thank-you, the total on the page, the admin Donations tab and the PayPal account. Refund them from PayPal.
6. Also try: cancel in the PayPal window (nothing recorded), a custom amount below $1 (refused), reloading after paying.

## History, thank-you and the website inbox

- **History.** `POST /donations/mine { token }` on the lobby answers with the session's own donations (amount, status, date, PayPal's transaction id as on their receipt) and total. The account comes from the session only; no session is a 401. Unpaid orders are left out. It works while PayPal is off. The website shows it at `/account/donations`, reached from the account page, from the support page ("Your donations") and from the thank-you message.
- **Thank-you.** The inbox lives in the lobby (`server-browser/src/inbox`, table `messages`), the same place donations are recorded. When a capture completes a row, the store says whether this call was the one that completed it (`first`: in Postgres, the `UPDATE ... WHERE status <> 'COMPLETED' RETURNING id` that changed the row). Only that call sends the message, so a replay, a double click or two lobby requests at once never send two. Guests and unfinished payments get none. It is a normal inbox message from "system", not a banner: unread mail in the game's inbox and on the website. If sending fails the donation still stands; the message is not retried (at most once).
- **Website inbox.** `/account/inbox` lists the pilot's messages with unread ones marked; `/account/inbox/:id` shows one and marks it read; there are "Mark all as read" and "Delete". The site calls the lobby's existing `/inbox/list`, `/inbox/read` and `/inbox/delete` with the pilot's own session, so read state and deletes are the same in the game.
- No schema change: the thank-you uses the `messages` table as it is.

## Contributor rank by donating

An account whose completed donations add up to $10 or more (`CONTRIBUTOR_AT = 1000` cents, in `server-browser/src/donations/routes.ts`) has the contributor rank: the map notes tools, F6 in the game.

- **Where the rank is.** On each game server, as before: `data/contributor/contributors.json`, kept by `server/src/game/ContributorNotes.ts` (an admin's `/contributor name on|off` and `/rank` write the same list). The lobby does not keep a rank. It only says who qualifies, from the donation records.
- **How the game server learns.** Two ways, both on channels that already existed:
  - At sign-in. The lobby's answer to a session check (`/auth/validate`) carries `donorContributor: true` for an account at or past the line. The game server then grants the rank before reading it (`contributorAtSignIn` in `server/src/net/auth.ts`, calling `ContributorNotes.grantDonor`). This is also the self-heal: whatever was missed, the next sign-in fixes.
  - While online. The lobby's heartbeat answer to each game server (every 10 s) carries `newContributors`, the account ids that reached the line in the last minute. A pilot who is on gets the rank then, with the usual chat line ("You are a contributor: F6 opens the contributor notes."), without signing in again. Opening the support page while signed in with a qualifying total tells the servers again, which heals a grant lost to a restart.
- **Once.** The grant is a no-op for an account that already has the rank, so repeats do nothing. The thank-you message gains a paragraph about the rank only for the one donation that took the total across the line. An account's completions run one at a time in the lobby, so two donations finishing together cannot both be "the crossing one".
- **Never taken away automatically.** Nothing in the donation code removes the rank. An admin-granted contributor with no donations is untouched. If an admin takes the rank from someone, their account id goes in `revoked` in `contributors.json`, and donating does not hand it back; an admin granting it again clears that.
- **Guests.** A donation made signed out is linked to no account, so it never counts.
- **What the pilot sees.** The support page and `/account/donations` show "You have the contributor rank." or, below the line, nothing more than the page's own words on what earns it, worked out from the total. An admin-granted contributor who has donated less than $10 sees the second line: the lobby does not know about ranks granted in game.

## What we tell people

The website's `/refunds` ("Donations and refunds") and `/privacy` pages say this in plain words (`site/src/views/legal.ts`): donations are gifts, refunds are discretionary, the contributor rank may be removed or given freely, and PayPal gets only the amount. To keep that last one true, an order carries the amount and a fixed description and nothing else: no `custom_id`, no account id. The support page, the site footer and the sign-up forms link to both pages. Change that text and the code together.

## Not built

- PayPal webhooks. Capture on return is the only source of truth. Webhooks would add: refunds and disputes (today a refunded donation still counts in the total; fix the row by hand), and finishing a payment PayPal held as `PENDING` (today it stays `PENDING` and uncounted unless capture is asked again).
- Donator perks.
