# Context: server-browser (the lobby)

Read first:
- docs/areas/web-accounts.md (accounts, sessions, JSON/Postgres stores, deleted accounts, rate limits, admin secret)
- docs/ops/postgres-migration.md for the Postgres store and switch-over; docs/areas/ops-tools.md for deploy
- Changing the UserStore interface means updating JsonUserStore, PostgresUserStore and server/src/auth/LobbyAccounts.ts.
