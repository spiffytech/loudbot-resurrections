import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface QuoteRow {
	// Our own uuid7 id (not from Discord).
	id: string;
	// Discord's snowflake message id (theirs).
	message_id: string;
	quote: string;
	said: string;
	channel_id: string;
	guild_id: string | null;
	created_at: string;
	edited_at: string | null;
}

export type IgnoreKind = 'guild' | 'channel';

export interface QuoteStore {
	init(): void;
	total(): number;
	fetchRandom(guildId?: string | null): QuoteRow | null;
	findByQuote(guildId: string, quote: string): QuoteRow | null;
	findByMessageId(messageId: string): QuoteRow | null;
	insert(message: MessageInput): QuoteRow | null;
	updateQuote(messageId: string, quote: string, editedAt: string): boolean;
	deleteByMessageId(messageId: string): boolean;
	search(guildId: string, pattern: string, limit?: number): QuoteRow[];
	addIgnore(kind: IgnoreKind, targetId: string): void;
	removeIgnore(kind: IgnoreKind, targetId: string): boolean;
	isIgnored(kind: IgnoreKind, targetId: string): boolean;
	isChannelIgnored(guildId: string, channelId: string): boolean;
	/** Channels that have quotes with a NULL guild (for repair). */
	nullGuildChannels(): string[];
	/** For repair: assign a guild to every NULL-guild quote in a channel. */
	setGuildByChannel(channelId: string, guildId: string): number;
	close(): void;
}

interface MessageInput {
	message_id: string;
	quote: string;
	said: string;
	channel_id: string;
	guild_id: string | null;
}

// Port of LOUDBOT::DB::search's wildcard translation:
//   hi   -> *hi*   (substring)
//   ^hi  -> hi*    (prefix)
//   hi$  -> *hi    (suffix)
// then upper-cased for case-insensitive matching, `*` becoming LIKE `%`.
function toLikePattern(input: string): string {
	let p = input;
	if (p.startsWith('^')) p = p.slice(1);
	else p = `*${p}`;
	if (p.endsWith('$')) p = p.slice(0, -1);
	else p = `${p}*`;
	p = p.replace(/\*+/g, '*');
	p = p.toUpperCase();
	// Escape LIKE metacharacters first, then translate wildcards.
	p = p.replace(/[\\%_]/g, (ch) => `\\${ch}`).replace(/\*/g, '%');
	return p;
}

const DISCORD_EPOCH = 1420070400000;

/** Deterministic uuid7 from a Discord snowflake's embed timestamp. */
export function uuid7FromSnowflake(snowflake: string): string {
	const id = BigInt(snowflake);
	const ms = Number(id >> 22n) + DISCORD_EPOCH;
	// Seed a PRNG deterministically from the snowflake so the rest of the
	// id is stable across migrations/re-runs.
	let x = Number(id & 0xffffffn) || 1;
	const rand = () => {
		x = (x * 1103515245 + 12345) % 0x7fffffff;
		return x / 0x7fffffff;
	};
	const randBytes = (n: number) => {
		const out = new Uint8Array(n);
		for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
		return out;
	};

	// uuid7 layout: 48-bit ms timestamp big-endian in bytes 0-5, version
	// (7) in the high nibble of byte 6, variant (10) in byte 8's high bits.
	const bytes = new Uint8Array(16);
	bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
	bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
	bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
	bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
	bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
	bytes[5] = ms & 0xff;
	bytes[6] = (randBytes(1)[0]! & 0x0f) | 0x70; // version 7 + low random
	bytes[7] = randBytes(1)[0]!;
	bytes[8] = (randBytes(1)[0]! & 0x3f) | 0x80; // variant 10
	bytes[9] = randBytes(1)[0]!;
	bytes[10] = randBytes(1)[0]!;
	bytes[11] = randBytes(1)[0]!;
	bytes[12] = randBytes(1)[0]!;
	bytes[13] = randBytes(1)[0]!;
	bytes[14] = randBytes(1)[0]!;
	bytes[15] = randBytes(1)[0]!;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function openDatabase(filename: string): QuoteStore {
	const db = new Database(filename, { create: true });
	applyPragmas(db);
	applySchema(db);

	const insertStmt = db.query(`
		INSERT INTO quotes (id, message_id, quote, said, channel_id, guild_id)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT DO NOTHING
	`);
	const byMessageIdStmt = db.query(
		'SELECT * FROM quotes WHERE message_id = ?',
	);
	const byQuoteStmt = db.query(
		'SELECT * FROM quotes WHERE guild_id = ? AND quote = ?',
	);
	const updateStmt = db.query(
		`UPDATE quotes SET quote = ?, edited_at = ?
		 WHERE message_id = ?`,
	);
	const deleteStmt = db.query('DELETE FROM quotes WHERE message_id = ?');
	const randomByGuildStmt = db.query(
		'SELECT * FROM quotes WHERE guild_id = ? ORDER BY RANDOM() LIMIT 1',
	);
	const totalStmt = db.query('SELECT COUNT(*) AS n FROM quotes');
	const searchStmt = db.query(
		`SELECT * FROM quotes
		 WHERE guild_id = ? AND UPPER(quote) LIKE ? ESCAPE '\\'
		 ORDER BY RANDOM() LIMIT ?`,
	);
	const ignoreGetStmt = db.query(
		'SELECT 1 AS ok FROM ignores WHERE kind = ? AND target_id = ?',
	);
	const ignoreInsertStmt = db.query(
		'INSERT OR IGNORE INTO ignores (id, kind, target_id) VALUES (?, ?, ?)',
	);
	const ignoreDeleteStmt = db.query(
		'DELETE FROM ignores WHERE kind = ? AND target_id = ?',
	);

	return {
		init() {
			applyPragmas(db);
			applySchema(db);
		},

		total() {
			return (getOne<{ n: number }>(totalStmt) as { n: number } | null)?.n ?? 0;
		},

		// Strict guild scoping: a quote only ever comes from the triggering
		// server. Empty pool -> null (caller replies with the empty-corpus
		// message); no cross-server quotes, ever.
		fetchRandom(guildId?: string | null) {
			if (!guildId) return null;
			return getOne<QuoteRow>(randomByGuildStmt, guildId);
		},

		findByQuote(guildId: string, quote: string) {
			return getOne<QuoteRow>(byQuoteStmt, guildId, quote);
		},

		findByMessageId(messageId: string) {
			return getOne<QuoteRow>(byMessageIdStmt, messageId);
		},

		insert(message) {
			const result = insertStmt.run(
				Bun.randomUUIDv7(),
				message.message_id,
				message.quote,
				message.said,
				message.channel_id,
				message.guild_id,
			);
			if (Number(result.changes) === 0) return null;
			return getOne<QuoteRow>(byMessageIdStmt, message.message_id);
		},

		updateQuote(messageId: string, quote: string, editedAt: string) {
			try {
				const result = updateStmt.run(quote, editedAt, messageId);
				return Number(result.changes) > 0;
			} catch {
				return false;
			}
		},

		deleteByMessageId(messageId: string) {
			const result = deleteStmt.run(messageId);
			return Number(result.changes) > 0;
		},

		search(guildId: string, pattern: string, limit = 100) {
			return searchStmt.all(
				guildId,
				toLikePattern(pattern),
				limit,
			) as QuoteRow[];
		},

		addIgnore(kind: IgnoreKind, targetId: string) {
			ignoreInsertStmt.run(Bun.randomUUIDv7(), kind, targetId);
		},

		removeIgnore(kind: IgnoreKind, targetId: string) {
			const result = ignoreDeleteStmt.run(kind, targetId);
			return Number(result.changes) > 0;
		},

		isIgnored(kind: IgnoreKind, targetId: string) {
			return getOne<{ ok: number }>(ignoreGetStmt, kind, targetId) !== null;
		},

		isChannelIgnored(guildId: string, channelId: string) {
			return this.isIgnored('guild', guildId) || this.isIgnored('channel', channelId);
		},

		nullGuildChannels() {
			return (
				db
					.query('SELECT DISTINCT channel_id FROM quotes WHERE guild_id IS NULL')
					.all() as { channel_id: string }[]
			).map((r) => r.channel_id);
		},

		setGuildByChannel(channelId: string, guildId: string) {
			const result = db
				.query(
					'UPDATE quotes SET guild_id = ? WHERE channel_id = ? AND guild_id IS NULL',
				)
				.run(guildId, channelId);
			return Number(result.changes);
		},

		close() {
			db.close(false);
		},
	};
}

function applyPragmas(db: Database): void {
	for (const [pragma, value] of [
		['journal_mode', 'WAL'],
		['synchronous', 'NORMAL'],
		['foreign_keys', 'ON'],
		['temp_store', 'MEMORY'],
		['cache_size', '-64000'],
		['mmap_size', '536870912'],
		['page_size', '32768'],
		['busy_timeout', '5000'],
		['wal_autocheckpoint', '10000'],
	] as const) {
		db.run(`PRAGMA ${pragma} = ${value};`);
	}
}

function applySchema(db: Database): void {
	// Rebuild the quotes table when it's missing the current schema:
	// either legacy (non-STRICT, INTEGER ids) or the older STRICT form
	// that had a global UNIQUE(quote) instead of per-guild
	// UNIQUE(guild_id, quote).
	const quotesRow = db
		.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='quotes'`)
		.get() as { sql: string } | null;
	const quotesIsLegacy =
		quotesRow !== null &&
		(!quotesRow.sql.includes('STRICT') ||
			!quotesRow.sql.includes('UNIQUE (guild_id, quote)'));

	if (quotesIsLegacy) {
		interface LegacyQuote {
			id: number | string;
			message_id: string;
			quote: string;
			said: string;
			channel_id: string;
			guild_id: string | null;
			created_at: string | null;
			edited_at: string | null;
		}
		interface LegacyIgnore {
			kind: string;
			target_id: string;
			added_at: string | null;
		}

		db.transaction(() => {
			db.run(`
				ALTER TABLE quotes RENAME TO quotes_legacy;
				ALTER TABLE ignores RENAME TO ignores_legacy;
			`);
			createTables(db);
			// Migrate quotes: derive deterministic uuid7 ids from each
			// row's message-id timestamp (preserving backfilled data),
			// and cast numeric ids to text keys.
			const oldRows = db
				.query('SELECT * FROM quotes_legacy')
				.all() as LegacyQuote[];
			const insertQuote = db.query(
				`INSERT INTO quotes (id, message_id, quote, said, channel_id, guild_id, created_at, edited_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const r of oldRows) {
				insertQuote.run(
					uuid7FromSnowflake(r.message_id),
					r.message_id,
					r.quote,
					r.said,
					r.channel_id,
					r.guild_id,
					r.created_at,
					r.edited_at,
				);
			}
			db.run('DROP TABLE quotes_legacy');
			// ignores have no message-id timestamp; assign fresh uuid7.
			const oldIgnores = db
				.query('SELECT * FROM ignores_legacy')
				.all() as LegacyIgnore[];
			const insertIgnore = db.query(
				`INSERT INTO ignores (id, kind, target_id, added_at)
				 VALUES (?, ?, ?, ?)`,
			);
			for (const r of oldIgnores) {
				insertIgnore.run(Bun.randomUUIDv7(), r.kind, r.target_id, r.added_at);
			}
			db.run('DROP TABLE ignores_legacy');
		})();
		return;
	}

	createTables(db);
}

function createTables(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS quotes (
			id TEXT PRIMARY KEY,
			message_id TEXT UNIQUE NOT NULL,
			quote TEXT NOT NULL,
			said TEXT NOT NULL,
			channel_id TEXT NOT NULL,
			guild_id TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			edited_at TEXT,
			UNIQUE (guild_id, quote)
		) STRICT;
		CREATE TABLE IF NOT EXISTS ignores (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK (kind IN ('guild', 'channel')),
			target_id TEXT NOT NULL UNIQUE,
			added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		) STRICT;
	`);
}

function getOne<T>(stmt: StatementLike, ...params: SQLQueryBindings[]): T | null {
	return (stmt.get(...params) as T | null) ?? null;
}

type StatementLike = {
	get(...params: SQLQueryBindings[]): unknown;
};