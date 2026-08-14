FROM oven/bun:1.3.14

WORKDIR /app
# Fixes writes into the container (mirrors the cockpit image)
RUN chown -R bun:bun /app

# /data is the SQLite mount point; pre-create so bun can write into a
# bind-mounted volume. (Named volumes still populate root-owned; mount as
# `-v name:/data` with host ownership, or use a bind mount.)
RUN mkdir -p /data && chown -R bun:bun /data

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --no-save

COPY --chown=bun:bun . .

# The SQLite corpus lives here; mount a persistent volume at /data.
# e.g. docker run -v loudbot-data:/data -e discordAppId=… -e discordBotToken=…
ENV databasePath=/data/db.sqlite

USER bun
CMD ["bun", "run", "src/index.ts"]