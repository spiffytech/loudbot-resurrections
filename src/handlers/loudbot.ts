import { rest } from '../rest/client.js';
import type {
	GatewayMessageCreateDispatchData,
	GatewayMessageUpdateDispatchData,
} from 'discord-api-types/v10';
import type { QuoteRow } from '../db.js';
import { db } from '../store.js';
import { isLoud } from '../lib/filter.js';

type MessageEvent = GatewayMessageCreateDispatchData;

/** Reply posted when something triggers a quote but the corpus is empty. */
export const EMPTY_CORPUS_MESSAGE = 'Corpus is empty — say something loud!';

export const SOURCE_REPLY = 'https://github.com/spiffytech/loudbot-resurrections';

const COMMAND_PREFIX_RE = /^loudbot\s*[:,]?\s+/i;

// Per-channel state (mirrors the original IRC "heap").
const lastQuotePerChannel = new Map<string, string>();
const searchResultsPerChannel = new Map<string, QuoteRow[]>();

let botUserId: string | null = null;

export const setBotUser = (id: string): void => {
	botUserId = id;
};

/**
 * Handle a message that is not from the bot itself.
 * Addressed messages dispatch to commands; every other message is a
 * candidate for the loudness trigger + learning.
 */
export const receiveMessage = async (
	message: GatewayMessageCreateDispatchData,
): Promise<void> => {
	const content = message.content ?? '';
	if (!content) return;

	if (isIgnored(message)) return;

	const commandRest = stripCommandPrefix(content);
	if (commandRest !== null) {
		const handled = await handleCommand(message, commandRest);
		// An addressed-but-unhandled loud line still triggers and learns,
		// matching "respond to literally any all-caps text".
		if (!handled) triggerAndLearn(message, content);
		return;
	}

	triggerAndLearn(message, content);
};

/**
 * Reply with a random quote when the line is loud; learn it when it is
 * DB-loud. Mirrors the original msg/public "trigger" handler.
 */
const triggerAndLearn = (message: MessageEvent, content: string): void => {
	const loud = isLoud(content);

	// Reply with a random quote when the line is loud.
	if (loud) {
		const quote = db.fetchRandom(message.guild_id ?? null);
		void replyWithQuote(message.channel_id, quote?.quote ?? EMPTY_CORPUS_MESSAGE);
	}

	// Learn-on-the-fly: any message loud enough to reply to is also
	// remembered as a future quote. This lets a fresh corpus bootstrap;
	// the original's stricter DB-only criteria never apply when the
	// reply gate already guarantees the line is shouting.
	if (loud) {
		const inserted = db.insert({
			message_id: message.id,
			quote: content,
			said: message.author.username,
			channel_id: message.channel_id,
			guild_id: message.guild_id ?? null,
		});
		if (inserted) {
			console.log(
				`Learned from ${message.author.username} in ${message.channel_id}: ${content}`,
			);
		}
	}
};

/**
 * Returns the text after an address prefix ("loudbot", "loudbot:" or a
 * Discord mention of the bot), or null when the message isn't addressed.
 */
const stripCommandPrefix = (content: string): string | null => {
	const mention = /^<@!?(\d+)>\s*[:,]?\s*/i.exec(content);
	if (mention) {
		if (botUserId !== null && mention[1] !== botUserId) return null;
		return content.slice(mention[0].length).trim();
	}
	if (COMMAND_PREFIX_RE.test(content)) {
		return content.replace(COMMAND_PREFIX_RE, '').trim();
	}
	return null;
};

/** Dispatch an addressed command; returns true when a command matched. */
const handleCommand = async (
	message: MessageEvent,
	command: string,
): Promise<boolean> => {
	const lower = command.toLowerCase();

	if (lower === 'source') {
		await rest.sendMessage(message.channel_id, SOURCE_REPLY);
		return true;
	}
	if (lower === 'help' || lower === 'commands' || lower === '?') {
		await handleHelp(message);
		return true;
	}
	if (lower === 'whosaid') {
		await handleWhosaid(message);
		return true;
	}
	if (lower === 'next') {
		await handleNext(message);
		return true;
	}
	const searchMatch = /^search\s+(.+)$/i.exec(command);
	if (searchMatch) {
		await handleSearch(message, searchMatch[1]!);
		return true;
	}
	const ignoreMatch = /^(un)?ignore(?:\s+(.+))?$/i.exec(command);
	if (ignoreMatch) {
		await handleIgnore(message, ignoreMatch[1] === undefined, ignoreMatch[2]?.trim() ?? '');
		return true;
	}
	return false;
};

const replyWithQuote = async (channelId: string, quote: string): Promise<void> => {
	try {
		await rest.sendMessage(channelId, quote);
	} catch (error) {
		console.error(`Failed to send quote to ${channelId}:`, error);
	}
};

const handleHelp = async (message: MessageEvent): Promise<void> => {
	const help = [
		'LoudBot commands — address me with `@loudbot` or `loudbot:`, or just shout loudly.',
		'',
		'`source` — where the source code lives',
		'`search <pattern>` — find a quote (wildcards `*` allowed)',
		'`next` — show the next search result',
		'`whosaid` — who said the last quote shown here',
		'`ignore #channel` / `ignore server` — stop listening in a channel or this server',
		'`unignore #channel` / `unignore server` — start again',
		'`help` — this message',
	].join('\n');
	await rest.sendMessage(message.channel_id, help);
};

const handleWhosaid = async (message: MessageEvent): Promise<void> => {
	const quote = lastQuotePerChannel.get(message.channel_id);
	if (!quote) {
		await rest.sendMessage(message.channel_id, 'No quote shown in this channel yet.');
		return;
	}
	const guildId = message.guild_id ?? null;
	if (!guildId) {
		await rest.sendMessage(message.channel_id, 'whosaid isn’t available in DMs.');
		return;
	}
	const row = db.findByQuote(guildId, quote);
	if (!row) {
		await rest.sendMessage(message.channel_id, 'That quote is no longer in the corpus.');
		return;
	}
	const when = row.edited_at ?? row.created_at;
	const location = row.guild_id ? ` in server ${row.guild_id}` : ' in a DM';
	await rest.sendMessage(
		message.channel_id,
		`${row.said} said it in ${row.channel_id}${location} at ${when} (UTC)`,
	);
};

const handleSearch = async (message: MessageEvent, pattern: string): Promise<void> => {
	const guildId = message.guild_id ?? null;
	if (!guildId) {
		await rest.sendMessage(message.channel_id, 'Search isn’t available in DMs.');
		return;
	}
	const results = db.search(guildId, pattern, 100);
	if (results.length === 0) {
		await rest.sendMessage(message.channel_id, `No matches for "${pattern}".`);
		return;
	}
	searchResultsPerChannel.set(message.channel_id, results);
	const [first, ...more] = results;
	lastQuotePerChannel.set(message.channel_id, first!.quote);
	const countNote = more.length > 0 ? ` (${more.length} more — say "@loudbot next")` : '';
	await rest.sendMessage(message.channel_id, `${first!.quote} — ${first!.said}${countNote}`);
};

const handleNext = async (message: MessageEvent): Promise<void> => {
	const results = searchResultsPerChannel.get(message.channel_id);
	if (!results || results.length === 0) {
		await rest.sendMessage(message.channel_id, 'No search results to page through.');
		return;
	}
	const [next, ...more] = results;
	searchResultsPerChannel.set(message.channel_id, more);
	lastQuotePerChannel.set(message.channel_id, next!.quote);
	const countNote = more.length > 0 ? ` (${more.length} more)` : '';
	await rest.sendMessage(message.channel_id, `${next!.quote} — ${next!.said}${countNote}`);
};

const handleIgnore = async (
	message: MessageEvent,
	ignore: boolean,
	arg: string,
): Promise<void> => {
	const action = ignore ? 'ignore' : 'unignore';
	if (!arg) {
		await rest.sendMessage(
			message.channel_id,
			`Usage: @loudbot ${action} #channel — or: @loudbot ${action} server`,
		);
		return;
	}
	const channelMatch = /^<#(\d+)>$/.exec(arg);
	if (channelMatch?.[1]) {
		if (ignore) db.addIgnore('channel', channelMatch[1]);
		else db.removeIgnore('channel', channelMatch[1]);
		await rest.sendMessage(
			message.channel_id,
			ignore ? 'Ignoring that channel.' : 'Unignored that channel.',
		);
		return;
	}
	if (/^(server|guild)$/i.test(arg) && message.guild_id) {
		if (ignore) db.addIgnore('guild', message.guild_id);
		else db.removeIgnore('guild', message.guild_id);
		await rest.sendMessage(
			message.channel_id,
			ignore ? 'Ignoring this server.' : 'Unignored this server.',
		);
		return;
	}
	await rest.sendMessage(
		message.channel_id,
		`Invalid ignore target. Use @loudbot ${action} #channel or @loudbot ${action} server.`,
	);
};

const isIgnored = (message: MessageEvent): boolean => {
	return db.isChannelIgnored(message.guild_id ?? '', message.channel_id);
};

/**
 * A message edit. When the edited content is still DB-loud, keep or
 * refresh the learned quote (upsert); otherwise drop it.
 */
export const handleMessageUpdate = async (
	message: GatewayMessageUpdateDispatchData,
): Promise<void> => {
	const content = message.content ?? '';
	// Without the Message Content intent, edits arrive with content === "".
	if (content === '' || !message.edited_timestamp) return;
	if (isIgnored(message)) return;

	const existing = db.findByMessageId(message.id);

	if (!isLoud(content)) {
		if (existing && db.deleteByMessageId(message.id)) {
			console.log(`Removed learned quote for edited message ${message.id}`);
		}
		return;
	}

	if (existing) {
		if (db.updateQuote(message.id, content, message.edited_timestamp)) {
			console.log(`Updated learned quote for message ${message.id}`);
		}
	} else {
		const inserted = db.insert({
			message_id: message.id,
			quote: content,
			said: message.author.username,
			channel_id: message.channel_id,
			guild_id: message.guild_id ?? null,
		});
		if (inserted) {
			console.log(
			`Learned edited message ${message.id} from ${message.author.username}`,
			);
		}
	}
};

/** A message was deleted; remove any learned quote attached to it. */
export const handleMessageDelete = (messageId: string): void => {
	if (db.deleteByMessageId(messageId)) {
		console.log(`Removed learned quote for deleted message ${messageId}`);
	}
};
