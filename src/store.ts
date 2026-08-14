import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { openDatabase } from './db.js';

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = openDatabase(config.databasePath);
