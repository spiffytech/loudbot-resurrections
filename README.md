# LoudBot Resurrections

A Discord port of the original IRC loudbot: it replies with a stored quote
whenever someone is loud, and learns every loud message for future quoting.
It only reacts in servers/channels it has been explicitly enabled in.

## Running

```bash
bun install
cp .env.example .env   # fill in discordAppId, discordBotToken
bun run start          # or: bun run dev (watch mode)
```

## Setup

- Create a bot application in the Discord Developer Portal.
- Enable the **Message Content Intent** (Developer Portal → Bot → Privileged
  Gateway Intents). Without it, the gateway delivers every message with empty
  content and the bot can neither learn nor reply.
- Invite the bot with these permissions: `View Channels`, `Send Messages`,
  and `Send Messages in Threads` (permission integer `19456`). It reacts to
  messages **only in guilds/channels it has been explicitly enabled in**
  (default: none). Use `@loudbot enable #channel` / `enable server` to
  invite it into a channel. Thread messages need `Send Messages in Threads`
  for replies; receiving them requires no extra intent.
- Reaction events (the ❌ delete, below) need the `Guild Message Reactions`
  intent, which is not privileged — there is no dashboard toggle. If ❌ does
  nothing in a channel, add `Read Message History` to the invite.

## Behavior

- A message is loud if it passes the ported `LOUDBOT::Filter` heuristics —
  all-caps, few lowercase letters, high caps-or-space density — or is entirely
  uppercase.
- Emoji are tolerated like spaces: `THIS IS AMAZING 🔥🔥` stays loud (the
  emoji are ignored, not counted), but a message with too many — more than
  one emoji per five characters (`WOW 😀😀😀😀`, `🔥🔥🔥🔥🔥`) — does not
  trigger. Emoji never rescue a non-shout (`amazing 🔥🔥` stays quiet).
- Loud messages trigger a reply with a random quote from the corpus.
- React ❌ to one of the bot's quotes to delete that reply and the underlying
  quote from the corpus. The reply→quote link is held in memory, so it only
  works for quotes posted since the last restart.
- Loud messages are also learned: they become future quotes (deduplicated by
  text).
- An empty corpus triggers with `EMPTY_CORPUS_MESSAGE` until the bot has heard
  something loud.

## Commands

Address the bot with `@loudbot` or `loudbot`, and one of:

| Command                                    | Behavior                                                  |
| ------------------------------------------ | --------------------------------------------------------- |
| `source`                                   | Reply with the source repo URL.                           |
| `whosaid`                                  | Who said the last quote shown in this channel, and where. |
| `search <pattern>`                         | Search the corpus (wildcards `*` supported); first match. |
| `next`                                     | Next result from the last `search`.                       |
| `enable #channel` / `enable server`        | Start reacting in a channel / this server.                |
| `disable #channel` / `disable server`      | Stop reacting in a channel / this server.                 |
| `ignore me`                                | Ignore all of your messages here.                         |
| `unignore me`                              | Undo the ignore.                                          |
| `stop yelling at me` / `please yell at me` | Lowercase-ify / restore my replies to you.                |

## Storage

SQLite at `$databasePath` (default `data/db.sqlite`), created on first
run. Schema: `quotes`, `allowlist` (the servers/channels the bot may react
in), and `user_prefs` (per-user ignore / lowercase-reply settings). The
original Redis-backed corpus is not imported; the bot starts empty and
learns.

Databases from before the allowlist existed kept the same data in an `ignores`
table. Those rows are carried into `allowlist` on open, so an already-running
bot keeps reacting in exactly the channels it was reacting in and nothing
changes until you `enable` or `disable` something.

## Backfilling quotes

To pre-populate the corpus from an existing server's message history, the
bot needs `View Channel` + `Read Message History` in the channels (add
`Read Message History` to its invite — permission integer `84992`). Then:

```bash
bun run src/scripts/backfill.ts --guild <guildId>
# or, a specific channel:
bun run src/scripts/backfill.ts --channel <channelId>
```

It pages through every text-capable channel (text, announcement, forum,
media, and their threads) and inserts each loud message. Idempotent —
re-running won't duplicate (quote text and message id are unique). Respects
Discord rate limits on 429.

Quotes are strictly scoped to the guild they came from: the bot only ever
quotes lines from the server the trigger happened in. A server with no
quotes yet gets the empty-corpus message rather than another server's
quotes. `--guild` and `--channel` both stamp `guild_id` on stored quotes.
If you backfilled before scoping existed, fix the existing rows once
(resolves each channel's guild via REST):

```bash
bun run src/scripts/backfill.ts --repair-guilds
```

## Health

`GET /health` on `$PORT` (default `3000`) answers `200 {"status":"ok"}` only
when the Discord gateway is connected and ready, and `503` otherwise —
including when the SQLite file is not writable (read-only mount, wrong
ownership), which it probes with a write transaction. Suitable as the
container healthcheck.

## Development

- `bun test` — unit tests (filter + db).
- `bun run start` — run the bot.
