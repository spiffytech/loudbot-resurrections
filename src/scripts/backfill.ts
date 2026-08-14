#!/usr/bin/env bun
/**
 * Backfill the quote corpus from a Discord server's message history.
 *
 * Usage:
 *   bun run src/scripts/backfill.ts --guild <guildId>
 *   bun run src/scripts/backfill.ts --channel <channelId> [--channel <channelId> …]
 *   bun run src/scripts/backfill.ts --repair-guilds
 *
 * The bot must have View Channel + Read Message History in each channel.
 * Pages through every text-capable channel (text, announcement, forum,
 * media, and their threads), keeps only messages that pass the loudness
 * filter, and inserts them into the same SQLite corpus the live bot uses
 * (idempotent: UNIQUE(quote) + UNIQUE(message_id) dedupe on re-runs).
 *
 * --repair-guilds fills in guild_id for quotes stored by an older backfill
 * that left it NULL: it resolves each NULL row's channel to its guild via
 * the REST API and updates in place.
 *
 * Rate limits: waits on the Retry-After header when Discord responds 429.
 */
import { db } from '../store.js';
import { rest } from '../rest/client.js';
import { isLoud } from '../lib/filter.js';
import { ChannelType, MessageType } from 'discord-api-types/v10';
import type { APIMessage } from 'discord-api-types/v10';

// Text-capable channel types we page through.
const TEXT_CHANNEL_TYPES = new Set<ChannelType>([
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildForum,
	ChannelType.GuildMedia,
	ChannelType.PublicThread,
	ChannelType.PrivateThread,
	ChannelType.AnnouncementThread,
]);

// Message types that carry real user content worth quoting.
const CONTENT_MESSAGE_TYPES = new Set<MessageType>([
	MessageType.Default,
	MessageType.Reply,
	MessageType.ThreadStarterMessage,
]);

function parseArgs(): {
	guild?: string;
	channels: string[];
	repairGuilds: boolean;
} {
	const args = process.argv.slice(2);
	const channels: string[] = [];
	let guild: string | undefined;
	let repairGuilds = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--guild') {
			guild = args[++i];
			if (!guild) throw new Error('--guild requires a value');
		} else if (arg === '--channel') {
			const id = args[++i];
			if (!id) throw new Error('--channel requires a value');
			channels.push(id);
		} else if (arg === '--repair-guilds') {
			repairGuilds = true;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	if (!guild && channels.length === 0 && !repairGuilds) {
		throw new Error(
			'Provide --guild <id>, --channel <id>, or --repair-guilds',
		);
	}
	return { guild, channels, repairGuilds };
}

function sleepMs(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Fetch one page; on 429, wait out the rate limit and retry. */
async function fetchPage(
	channelId: string,
	before: string | undefined,
): Promise<APIMessage[]> {
	for (;;) {
		try {
			return await rest.getChannelMessages(channelId, { before });
		} catch (error) {
			// rest throws `Discord API 429: …` — detect and retry.
			const message = error instanceof Error ? error.message : String(error);
			if (!/429/.test(message)) throw error;
			const retryAfter = Number(
				/retry-after:\s*(\d+)/i.exec(message)?.[1] ?? '1',
			);
			console.log(`Rate limited; waiting ${retryAfter}s`);
			await sleepMs(retryAfter * 1000);
		}
	}
}

async function backfillChannel(channelId: string, guildId: string | null): Promise<number> {
	let before: string | undefined;
	let inserted = 0;
	let scanned = 0;
	for (;;) {
		const page = await fetchPage(channelId, before);
		if (page.length === 0) break;
		for (const m of page) {
			scanned++;
			if (!CONTENT_MESSAGE_TYPES.has(m.type)) continue;
			const content = m.content ?? '';
			if (!content || !isLoud(content)) continue;
			// REST-fetched messages carry no guild_id; resolve it from the
			// --guild flag or the channel's owning guild.
			const row = db.insert({
				message_id: m.id,
				quote: content,
				said: m.author.username,
				channel_id: m.channel_id,
				guild_id: guildId,
			});
			if (row) inserted++;
		}
		before = page[page.length - 1]!.id;
		if (page.length < 100) break;
	}
	console.log(`Channel ${channelId}: scanned ${scanned}, inserted ${inserted}`);
	return inserted;
}

async function repairGuilds(): Promise<number> {
	// Find every NULL-guild quote, resolve its channel's guild once, and
	// update those rows. Channels may belong to the same guild — batch by
	// channel to avoid one REST call per quote.
	const channels = db.nullGuildChannels();
	let updated = 0;
	for (const channelId of channels) {
		try {
			const channel = await rest.getChannel(channelId);
			const guildId =
				'guild_id' in channel ? (channel.guild_id ?? null) : null;
			if (!guildId) continue;
			updated += db.setGuildByChannel(channelId, guildId);
			console.log(`Channel ${channelId} -> guild ${guildId}`);
		} catch (error) {
			console.error(`Could not resolve guild for channel ${channelId}:`, error);
		}
	}
	return updated;
}

async function main(): Promise<void> {
	const { guild, channels, repairGuilds: doRepair } = parseArgs();
	db.init();

	if (doRepair) {
		const updated = await repairGuilds();
		console.log(`Repair done. Updated ${updated} rows with a guild.`);
		db.close();
		return;
	}

	let targets = channels;
	let guildIdForRows: string | null = guild ?? null;
	if (guild) {
		const guildChannels = await rest.getGuildChannels(guild);
		targets = guildChannels
			.filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
			.map((c) => c.id);
		console.log(`Backfilling ${targets.length} text channels in guild ${guild}`);
	} else {
		// Resolve each channel's guild so stored quotes are scoped. If a
		// channel lookup fails, fall back to null for that channel.
		console.log(`Backfilling ${targets.length} channels`);
	}

	let total = 0;
		for (const id of targets) {
		try {
			if (!guild) {
				const channel = await rest.getChannel(id);
				guildIdForRows = 'guild_id' in channel ? (channel.guild_id ?? null) : null;
			}
			total += await backfillChannel(id, guildIdForRows);
		} catch (error) {
			console.error(`Skipping channel ${id}:`, error);
		}
	}
	console.log(`Done. Inserted ${total} quotes.`);
	db.close();
}

main().catch((error) => {
	console.error('Fatal:', error);
	process.exit(1);
});