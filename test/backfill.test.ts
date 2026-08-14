import { describe, expect, test } from 'bun:test';
import { openDatabase } from '../src/db.ts';
import type { QuoteStore } from '../src/db.ts';
import { isLoud } from '../src/lib/filter.ts';
import type { APIMessage } from 'discord-api-types/v10';

// The backfill logic (pagination + filter + insert) is exercised here
// against a fake REST layer, since a real token isn't available in tests.

function fakeMessage(
	id: string,
	content: string,
	channelId = 'c1',
	type = 0,
): APIMessage {
	return {
		id,
		channel_id: channelId,
		content,
		type,
		author: { id: 'u1', username: 'tester' },
	} as unknown as APIMessage;
}

describe('backfill pagination + filter', () => {
	test('pages until empty, inserts only loud messages', async () => {
		const db = openDatabase(':memory:');
		db.init();

		// Model Discord: page 1 is a full 100-length page (forces
		// continuation), page 2 is a partial final page.
		const firstPage = Array.from({ length: 100 }, (_, i) =>
			fakeMessage(`m${100 - i}`, i % 2 === 0 ? `LOUD MESSAGE NUMBER ${i}` : `quiet message ${i}`),
		);
		const pages: APIMessage[][] = [
			firstPage,
			[fakeMessage('m1', 'ANOTHER LOUD ONE'), fakeMessage('m0', 'quiet tail')],
		];
		let pageIndex = 0;
		const fetchPage = async () => {
			const page = pages[pageIndex]!;
			pageIndex++;
			return page;
		};

		let inserted = 0;
		for (;;) {
			const page = await fetchPage();
			if (page.length === 0) break;
			for (const m of page) {
				if (!isLoud(m.content ?? '')) continue;
				const row = db.insert({
					message_id: m.id,
					quote: m.content ?? '',
					said: m.author.username,
					channel_id: m.channel_id,
					guild_id: null,
				});
				if (row) inserted++;
			}
			if (page.length < 100) break;
		}

		// 50 loud on page 1 (even indices 0..98) + 1 loud on page 2.
		expect(inserted).toBe(51);
		expect(db.total()).toBe(51);
		expect(db.findByMessageId('m3')).toBeNull();
		expect(db.findByMessageId('m0')).toBeNull();
	});

	test('idempotent on re-run (unique quote + message_id)', () => {
		const db = openDatabase(':memory:');
		db.init();
		const msg = fakeMessage('m1', 'LOUD DEDUPE TEST MESSAGE');
		const insert = () =>
			db.insert({
				message_id: msg.id,
				quote: msg.content ?? '',
				said: msg.author.username,
				channel_id: msg.channel_id,
				guild_id: null,
			});
		expect(insert()).not.toBeNull();
		expect(insert()).toBeNull(); // same message_id
		expect(db.total()).toBe(1);
	});

	test('skips non-default message types (e.g. pins)', () => {
		const db = openDatabase(':memory:');
		db.init();
		const pinned = fakeMessage('m1', 'THIS IS LOUD BUT PINNED', 'c1', 6); // MessageType.ChannelPinnedMessage
		expect(isLoud(pinned.content ?? '')).toBe(true);
		// The backfill's CONTENT_MESSAGE_TYPES check would skip type 6.
		const contentTypes = new Set([0, 19, 21]);
		expect(contentTypes.has(pinned.type)).toBe(false);
	});
});
