interface Config {
	discordAppId: string;
	discordBotToken: string;
	/** Path to the SQLite quotes/allowlist/user-prefs database file. */
	databasePath: string;
}

function requiredEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export const config: Config = {
	discordAppId: requiredEnv('discordAppId'),
	discordBotToken: requiredEnv('discordBotToken'),
	databasePath: Bun.env.databasePath ?? 'data/db.sqlite',
};
