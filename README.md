# LoudBot Resurrections

A Discord port of the original IRC loudbot: it listens to every channel it has
access to, replies with a stored quote whenever someone is loud, and learns
every loud message for future quoting.

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
  messages in every guild/channel/thread it can see. Thread messages need
  `Send Messages in Threads` for replies; receiving them requires no extra
  intent.

## Behavior

- A message is loud if it passes the ported `LOUDBOT::Filter` heuristics —
  all-caps, few lowercase letters, high caps-or-space density — or is entirely
  uppercase.
- Loud messages trigger a reply with a random quote from the corpus.
- Loud messages are also learned: they become future quotes (deduplicated by
  text).
- An empty corpus triggers with `EMPTY_CORPUS_MESSAGE` until the bot has heard
  something loud.

## Commands

Address the bot with `@loudbot` or `loudbot`, and one of:

| Command | Behavior |
|---|---|
| `source` | Reply with the source repo URL. |
| `whosaid` | Who said the last quote shown in this channel, and where. |
| `search <pattern>` | Search the corpus (wildcards `*` supported); first match. |
| `next` | Next result from the last `search`. |
| `ignore #channel` | Stop listening/replying in that channel. |
| `ignore server` | Stop listening/replying in this server. |
| `unignore #channel` / `unignore server` | Re-enable. |

## Storage

SQLite at `$databasePath` (default `data/db.sqlite`), created on first
run. Schema: `quotes`, `ignores`. The original Redis-backed corpus is not
imported; the bot starts empty and learns.

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

## Development

- `bun test` — unit tests (filter + db).
- `bun run start` — run the bot.
