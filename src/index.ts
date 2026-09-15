import { Database } from 'bun:sqlite';
import { config } from './config.js';
import { db } from './store.js';
import { connectGateway, disconnect, getGatewayState } from './gateway/client.js';

db.init();

// Health HTTP server — probes the real SQLite file (catches read-only mounts /
// bad container permissions) and reports gateway connection state.
// Port is overridable; empty or unparseable values fall back to 3000
// rather than to Bun's ephemeral-port behaviour for 0.
const HEALTH_PORT = Number(Bun.env.PORT) || 3000;
Bun.serve({
	port: HEALTH_PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname !== '/health') {
			return new Response('Not found', { status: 404 });
		}

		try {
			// BEGIN IMMEDIATE acquires the write lock and forces a WAL append; on a
			// read-only mount or unowned file it throws SQLITE_READONLY/CANTOPEN.
			// We roll back, so nothing is persisted.
			const probe = new Database(config.databasePath);
			probe.run('PRAGMA busy_timeout = 5000');
			probe.exec('BEGIN IMMEDIATE; ROLLBACK;');
			probe.close();

			const gateway = getGatewayState();
			if (!gateway.connected || !gateway.ready) {
				return new Response(
					JSON.stringify({ status: 'unhealthy', reason: 'discord gateway not ready' }),
					{
						status: 503,
						headers: { 'content-type': 'application/json' },
					},
				);
			}

			return new Response(JSON.stringify({ status: 'ok' }), {
				headers: { 'content-type': 'application/json' },
			});
		} catch (e) {
			return new Response(JSON.stringify({ status: 'unhealthy', reason: String(e) }), {
				status: 503,
				headers: { 'content-type': 'application/json' },
			});
		}
	},
});

async function main() {
	console.log(`Starting LoudBot (${config.discordAppId}) with database ${config.databasePath}`);
	connectGateway();

	const shutdown = (sig: string) => {
		console.log(`\n${sig}, shutting down...`);
		disconnect();
		db.close();
		process.exit(0);
	};

	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});
