import { config } from '../config.js';
import type { APIMessage, APIChannel } from 'discord-api-types/v10';
import { RouteBases, Routes } from 'discord-api-types/v10';

const USER_AGENT = `DiscordBot (${config.discordAppId}, 1.0.0)`;

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
	const response = await fetch(`${RouteBases.api}${endpoint}`, {
		...options,
		headers: {
			Authorization: `Bot ${config.discordBotToken}`,
			'Content-Type': 'application/json',
			'User-Agent': USER_AGENT,
		},
	});

	if (!response.ok) {
		const retryAfter = response.headers.get('retry-after');
		const text = await response.text();
		const suffix = retryAfter ? ` retry-after: ${retryAfter}` : '';
		throw new Error(`Discord API ${response.status}: ${text}${suffix}`);
	}

	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

export const rest = {
	async sendMessage(channelId: string, content: string): Promise<APIMessage> {
		return request<APIMessage>(Routes.channelMessages(channelId), {
			method: 'POST',
			body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
		});
	},

	/** Delete a message the bot sent (returns 204). */
	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		await request<void>(`${Routes.channelMessages(channelId)}/${messageId}`, {
			method: 'DELETE',
		});
	},

	/** All channels in a guild (categories, text, voice, forum…). */
	async getGuildChannels(guildId: string): Promise<APIChannel[]> {
		return request<APIChannel[]>(Routes.guildChannels(guildId));
	},

	/** A single channel (e.g. to resolve its guild for backfill). */
	async getChannel(channelId: string): Promise<APIChannel> {
		return request<APIChannel>(Routes.channel(channelId));
	},

	/**
	 * Page through a channel's message history. Returns up to `limit`
	 * messages strictly older than `before` (newest first, per Discord).
	 */
	async getChannelMessages(
		channelId: string,
		{ before, limit = 100 }: { before?: string; limit?: number } = {},
	): Promise<APIMessage[]> {
		const query = new URLSearchParams();
		query.set('limit', String(Math.min(limit, 100)));
		if (before) query.set('before', before);
		return request<APIMessage[]>(`${Routes.channelMessages(channelId)}?${query}`);
	},
};
