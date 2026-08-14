import { config } from './config.js';
import { db } from './store.js';
import { connectGateway, disconnect } from './gateway/client.js';

db.init();

async function main() {
	console.log(
		`Starting LoudBot (${config.discordAppId}) with database ${config.databasePath}`,
	);
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
