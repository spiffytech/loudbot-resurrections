import {
	GatewayOpcodes,
	GatewayIntentBits,
} from 'discord-api-types/v10';
import type {
	GatewayHelloData,
	GatewayReadyDispatchData,
	GatewayMessageCreateDispatchData,
	GatewayMessageUpdateDispatchData,
	GatewayMessageDeleteDispatchData,
	GatewayMessageReactionAddDispatchData,
	GatewayReceivePayload,
} from 'discord-api-types/v10';
import { config } from '../config.js';
import {
	receiveMessage,
	handleMessageUpdate,
	handleMessageDelete,
	handleReactionAdd,
	setBotUser,
} from '../handlers/loudbot.js';

let sequence: number | null = null;
let sessionId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let botUserId: string | null = null;
let isIntentionalClose = false;

let gatewayReady = false;

export function getGatewayState(): { connected: boolean; ready: boolean; botUserId: string | null } {
	return {
		connected: ws?.readyState === WebSocket.OPEN && !isIntentionalClose,
		ready: gatewayReady,
		botUserId,
	};
}

const GATEWAY_INTENTS =
	GatewayIntentBits.Guilds |
	GatewayIntentBits.GuildMessages |
	GatewayIntentBits.GuildMessageReactions |
	GatewayIntentBits.MessageContent;

export function connectGateway(): void {
	const url = 'wss://gateway.discord.gg/?v=10&encoding=json';
	console.log('Connecting to Discord Gateway...');
	isIntentionalClose = false;
	ws = new WebSocket(url);

	ws.onopen = () => {
		console.log('Gateway connected');
		reconnectAttempts = 0;
	};

	ws.onmessage = (event) => {
		try {
			const payload = JSON.parse(event.data as string);
			handlePayload(payload);
		} catch (error) {
			console.error('Error handling gateway payload:', error);
		}
	};

	ws.onclose = (event) => {
		console.log(`Gateway closed: ${event.code} ${event.reason}`);
		stopHeartbeat();
		gatewayReady = false;
		if (!isIntentionalClose) scheduleReconnect();
	};

	ws.onerror = (error) => {
		console.error('Gateway error:', error);
	};
}

function handlePayload(payload: GatewayReceivePayload): void {
	if (typeof payload.s === 'number' && payload.s != null) sequence = payload.s;

	switch (payload.op) {
		case GatewayOpcodes.Hello: {
			const hello = payload.d as GatewayHelloData;
			startHeartbeat(hello.heartbeat_interval);
			if (sessionId) {
				resume();
			} else {
				identify();
			}
			break;
		}
		case GatewayOpcodes.Dispatch: {
			switch (payload.t) {
				case 'READY': {
					const ready = payload.d as GatewayReadyDispatchData;
					sessionId = ready.session_id;
					botUserId = ready.user.id;
					gatewayReady = true;
					setBotUser(botUserId);
					console.log(`Ready: ${ready.user.username} (${botUserId})`);
					break;
				}
				case 'MESSAGE_CREATE': {
					const message = payload.d as GatewayMessageCreateDispatchData;
					if (message.author.id !== botUserId) {
						void receiveMessage(message);
					}
					break;
				}
				case 'MESSAGE_UPDATE': {
					const message = payload.d as GatewayMessageUpdateDispatchData;
					// Edits from the bot itself are never learned.
					if (message.author && message.author.id !== botUserId) {
						void handleMessageUpdate(message);
					}
					break;
				}
				case 'MESSAGE_DELETE': {
					const data = payload.d as GatewayMessageDeleteDispatchData;
					handleMessageDelete(data.id);
					break;
				}
				case 'MESSAGE_REACTION_ADD': {
					const data = payload.d as GatewayMessageReactionAddDispatchData;
					handleReactionAdd(data);
					break;
				}
				case 'RESUMED': {
					// A resumed session is just as live as a fresh one. Without
					// this, `gatewayReady` stays false after any reconnect that
					// resumed (onclose cleared it), so /health would 503 forever.
					gatewayReady = true;
					console.log('Session resumed');
					break;
				}
			}
			break;
		}
		case GatewayOpcodes.Heartbeat: {
			sendHeartbeat();
			break;
		}
		case GatewayOpcodes.Reconnect: {
			console.log('Discord requested reconnect');
			reconnect();
			break;
		}
		case GatewayOpcodes.InvalidSession: {
			const resumable = payload.d as boolean;
			console.log(`Invalid session, resumable: ${resumable}`);
			if (resumable && sessionId) {
				setTimeout(resume, 1000);
			} else {
				sessionId = null;
				sequence = null;
				setTimeout(identify, 1000);
			}
			break;
		}
		case GatewayOpcodes.HeartbeatAck: {
			break;
		}
	}
}

function startHeartbeat(interval: number): void {
	stopHeartbeat();
	heartbeatTimer = setInterval(sendHeartbeat, interval);
	sendHeartbeat();
}

function stopHeartbeat(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}
}

function sendHeartbeat(): void {
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ op: GatewayOpcodes.Heartbeat, d: sequence }));
	}
}

function identify(): void {
	ws?.send(
		JSON.stringify({
			op: GatewayOpcodes.Identify,
			d: {
				token: config.discordBotToken,
				intents: GATEWAY_INTENTS,
				properties: { os: 'linux', browser: 'bun', device: 'bun' },
			},
		}),
	);
}

function resume(): void {
	if (!sessionId || sequence === null) {
		identify();
		return;
	}
	ws?.send(
		JSON.stringify({
			op: GatewayOpcodes.Resume,
			d: { token: config.discordBotToken, session_id: sessionId, seq: sequence },
		}),
	);
}

function reconnect(): void {
	isIntentionalClose = false;
	ws?.close(4000, 'Reconnecting');
}

function scheduleReconnect(): void {
	const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000) + Math.random() * 1000;
	reconnectAttempts++;
	console.log(
		`Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`,
	);
	setTimeout(connectGateway, delay);
}

export function disconnect(): void {
	isIntentionalClose = true;
	stopHeartbeat();
	ws?.close(1000, 'Shutting down');
}
