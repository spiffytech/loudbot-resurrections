import { describe, expect, test, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db.ts';
import type { QuoteStore } from '../src/db.ts';

const stores: QuoteStore[] = [];

function freshStore(): QuoteStore {
	const store = openDatabase(':memory:');
	store.init();
	stores.push(store);
	return store;
}

afterAll(() => {
	for (const s of stores) s.close();
});

describe('quotes', () => {
	test('empty store total is 0 and fetchRandom is null', () => {
		const db = freshStore();
		expect(db.total()).toBe(0);
		expect(db.fetchRandom()).toBeNull();
	});

	test('insert stores and fetchRandom returns it', () => {
		const db = freshStore();
		const row = db.insert({
			message_id: 'm1',
			quote: 'THIS IS A LOUD QUOTE',
			said: 'alice',
			channel_id: 'c1',
			guild_id: 'g1',
		});
		expect(row).not.toBeNull();
		expect(db.total()).toBe(1);
		expect(db.fetchRandom('g1')?.quote).toBe('THIS IS A LOUD QUOTE');
	});

	test('deleteById removes a quote by uuid7 id', () => {
		const db = freshStore();
		const row = db.insert({
			message_id: 'del1',
			quote: 'QUOTE TO DELETE BY ID',
			said: 'x',
			channel_id: 'c4',
			guild_id: 'g1',
		});
		expect(row).not.toBeNull();
		expect(db.deleteById(row!.id)).toBe(true);
		expect(db.total()).toBe(0);
		// Second delete is a no-op.
		expect(db.deleteById(row!.id)).toBe(false);
	});

	test('quote dedupes per-guild, not globally', () => {
		const db = freshStore();
		// Same quote in the SAME guild dedupes.
		db.insert({ message_id: 'm1', quote: 'SAME QUOTE', said: 'a', channel_id: 'c1', guild_id: 'g1' });
		const sameGuildDup = db.insert({ message_id: 'm2', quote: 'SAME QUOTE', said: 'b', channel_id: 'c1', guild_id: 'g1' });
		expect(sameGuildDup).toBeNull();
		expect(db.total()).toBe(1);
		// Same quote in a DIFFERENT guild is allowed (per-guild isolation).
		const otherGuild = db.insert({ message_id: 'm3', quote: 'SAME QUOTE', said: 'c', channel_id: 'c2', guild_id: 'g2' });
		expect(otherGuild).not.toBeNull();
		expect(db.total()).toBe(2);
		// Same quote with NULL guild dedupes against NULL guild only.
		const nullGuild = db.insert({ message_id: 'm4', quote: 'SAME QUOTE', said: 'd', channel_id: 'c3', guild_id: null });
		expect(nullGuild).not.toBeNull();
		expect(db.total()).toBe(3);
	});

	test('findByMessageId and deleteByMessageId round-trip', () => {
		const db = freshStore();
		db.insert({ message_id: 'm9', quote: 'LOUD REMOVABLE THING', said: 'x', channel_id: 'c2', guild_id: null });
		expect(db.findByMessageId('m9')).not.toBeNull();
		expect(db.deleteByMessageId('m9')).toBe(true);
		expect(db.findByMessageId('m9')).toBeNull();
		expect(db.total()).toBe(0);
	});

	test('updateQuote changes text', () => {
		const db = freshStore();
		db.insert({ message_id: 'm4', quote: 'OLD LOUD TEXT', said: 'x', channel_id: 'c3', guild_id: null });
		const ok = db.updateQuote('m4', 'NEW LOUD TEXT', '2026-01-01T00:00:00Z');
		expect(ok).toBe(true);
		const row = db.findByMessageId('m4');
		expect(row?.quote).toBe('NEW LOUD TEXT');
		expect(row?.edited_at).toBe('2026-01-01T00:00:00Z');
	});

	test('fetchRandom is strictly guild-scoped, no fallback', () => {
		const db = freshStore();
		// Guild A has a quote; guild B has a quote; another quote is NULL.
		db.insert({ message_id: 'ga1', quote: 'AAA GUILD A LOUD THING', said: 'a', channel_id: 'c1', guild_id: 'g-a' });
		db.insert({ message_id: 'gb1', quote: 'BBB GUILD B LOUD THING', said: 'b', channel_id: 'c2', guild_id: 'g-b' });
		db.insert({ message_id: 'gn1', quote: 'GLOBAL NULL GUILD QUOTE', said: 'n', channel_id: 'c3', guild_id: null });

		// Guild A gets only A's quote.
		expect(db.fetchRandom('g-a')?.guild_id).toBe('g-a');
		expect(db.fetchRandom('g-a')?.quote).toBe('AAA GUILD A LOUD THING');
		// Guild B gets only B's quote.
		expect(db.fetchRandom('g-b')?.quote).toBe('BBB GUILD B LOUD THING');
		// Unknown guild gets NOTHING (no cross-server leak).
		expect(db.fetchRandom('g-unknown')).toBeNull();
		// No guild context gets nothing.
		expect(db.fetchRandom(null)).toBeNull();
		expect(db.fetchRandom(undefined)).toBeNull();
	});

	test('fetchRandom with empty guild pool returns null', () => {
		const db = freshStore();
		expect(db.fetchRandom('g-empty')).toBeNull();
	});

	test('search matches substring wildcards', () => {
		const db = freshStore();
		db.insert({ message_id: 'a1', quote: 'HELLO WORLD LOUD', said: 'a', channel_id: 'c', guild_id: 'g1' });
		db.insert({ message_id: 'a2', quote: 'GOODBYE QUIET THING', said: 'b', channel_id: 'c', guild_id: 'g1' });
		const results = db.search('g1', 'hello');
		expect(results).toHaveLength(1);
		expect(results[0]!.quote).toBe('HELLO WORLD LOUD');
	});

	test('search prefix ^ and suffix $ work', () => {
		const db = freshStore();
		db.insert({ message_id: 'p1', quote: 'ALPHA LOUD WORDS', said: 'a', channel_id: 'c', guild_id: 'g1' });
		db.insert({ message_id: 'p2', quote: 'BETA LOUD WORDS', said: 'b', channel_id: 'c', guild_id: 'g1' });
		expect(db.search('g1', '^ALPHA')).toHaveLength(1);
		expect(db.search('g1', 'WORDS$')).toHaveLength(2);
	});

	test('search is guild-scoped (no cross-server leak)', () => {
		const db = freshStore();
		db.insert({ message_id: 's1', quote: 'SECRET SERVER A QUOTE', said: 'a', channel_id: 'c1', guild_id: 'g-a' });
		db.insert({ message_id: 's2', quote: 'SECRET SERVER A QUOTE', said: 'a', channel_id: 'c2', guild_id: 'g-b' });
		// Searching server B must NOT find server A's copy.
		expect(db.search('g-b', 'SECRET SERVER')).toHaveLength(1);
		expect(db.search('g-b', 'SECRET SERVER')[0]!.guild_id).toBe('g-b');
		// Same text exists in both guilds; scoped lookup returns only ours.
		expect(db.findByQuote('g-b', 'SECRET SERVER A QUOTE')?.guild_id).toBe('g-b');
		expect(db.findByQuote('g-zzz', 'SECRET SERVER A QUOTE')).toBeNull();
	});
});

describe('user prefs', () => {
	test('ignore/user lowercase round-trip', () => {
		const db = freshStore();
		expect(db.isUserIgnored('g1', 'u1')).toBe(false);
		expect(db.wantsLowercaseReplies('g1', 'u1')).toBe(false);

		db.setUserIgnored('g1', 'u1', true);
		expect(db.isUserIgnored('g1', 'u1')).toBe(true);
		// Setting ignore shouldn't clobber lowercase.
		db.setUserLowercase('g1', 'u1', true);
		expect(db.isUserIgnored('g1', 'u1')).toBe(true);
		expect(db.wantsLowercaseReplies('g1', 'u1')).toBe(true);

		// Unset lowercase; ignore stays.
		db.setUserLowercase('g1', 'u1', false);
		expect(db.wantsLowercaseReplies('g1', 'u1')).toBe(false);
		expect(db.isUserIgnored('g1', 'u1')).toBe(true);
	});

	test('user prefs are guild-scoped', () => {
		const db = freshStore();
		db.setUserIgnored('g1', 'u1', true);
		expect(db.isUserIgnored('g1', 'u1')).toBe(true);
		expect(db.isUserIgnored('g2', 'u1')).toBe(false);
	});
});

describe('enable/disable allowlist', () => {
	test('default is none; enable/disable toggles', () => {
		const db = freshStore();
		// Default: nothing enabled.
		expect(db.isChannelEnabled('g9', 'c9')).toBe(false);

		// Enable a channel.
		db.setEnabled('channel', 'c1', true);
		expect(db.isChannelEnabled('g9', 'c1')).toBe(true);
		// Enable a guild.
		db.setEnabled('guild', 'g1', true);
		expect(db.isChannelEnabled('g1', 'c9')).toBe(true);
		// Guild-or-channel: enabled if either matches.
		expect(db.isChannelEnabled('g1', 'c1')).toBe(true);
		// Disable the channel; guild still enables.
		db.setEnabled('channel', 'c1', false);
		expect(db.isChannelEnabled('g9', 'c1')).toBe(false);
		expect(db.isChannelEnabled('g1', 'c1')).toBe(true);
		// Disable the guild.
		db.setEnabled('guild', 'g1', false);
		expect(db.isChannelEnabled('g1', 'c1')).toBe(false);
	});

	test('a legacy ignores table cannot enable anything', () => {
		// Pre-allowlist builds wrote deliberate *ignores* into an `ignores`
		// table. Reusing that table as the allowlist would silently read
		// those channels as enabled, so opening such a DB must drop it.
		const path = join(tmpdir(), `loudbot-legacy-${Bun.randomUUIDv7()}.sqlite`);
		const legacy = new Database(path, { create: true });
		legacy.run(`
			CREATE TABLE ignores (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				target_id TEXT NOT NULL UNIQUE,
				added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			) STRICT;
		`);
		legacy.run(
			"INSERT INTO ignores (id, kind, target_id) VALUES ('i1', 'channel', 'c-ignored')",
		);
		legacy.run(
			"INSERT INTO ignores (id, kind, target_id) VALUES ('i2', 'guild', 'g-ignored')",
		);
		legacy.close();

		const store = openDatabase(path);
		store.init();
		stores.push(store);
		expect(store.isChannelEnabled('g-ignored', 'c-ignored')).toBe(false);
		expect(store.isChannelEnabled('g-ignored', 'c-anything')).toBe(false);
		store.close();
		rmSync(path, { force: true });
		rmSync(`${path}-wal`, { force: true });
		rmSync(`${path}-shm`, { force: true });
	});
});
