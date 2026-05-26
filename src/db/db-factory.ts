import { type IDBAdapter } from './db-adapter.js';
import { PostgresAdapter } from './postgres-adapter.js';
import { SQLiteAdapter } from './sqlite-adapter.js';

let _instance: IDBAdapter | null = null;

/**
 * Returns the singleton DB adapter, creating and initialising it on first call.
 * The backend is chosen from the `DB_TYPE` environment variable:
 *   - `"postgres"` → PostgresAdapter (reads DB_POSTGRES_* env vars)
 *   - `"sqlite"`   → SQLiteAdapter   (reads DB_SQLITE_PATH env var)
 *
 * Call `await getDB()` once at startup; subsequent calls return the same
 * adapter without re-initialising.
 */
export async function getDB(): Promise<IDBAdapter> {
    if (_instance) return _instance;

    const dbType = (process.env.DB_TYPE ?? 'sqlite').toLowerCase();

    if (dbType === 'postgres') {
        const user = process.env.DB_POSTGRES_USER || process.env.USER || undefined;
        _instance = new PostgresAdapter({
            host: process.env.DB_POSTGRES_HOST ?? 'localhost',
            port: Number(process.env.DB_POSTGRES_PORT ?? 5432),
            database: process.env.DB_POSTGRES_DATABASE ?? 'agentdb',
            user,
            password: process.env.DB_POSTGRES_PASSWORD || undefined,
        });
    } else if (dbType === 'sqlite') {
        const filePath = process.env.DB_SQLITE_PATH ?? './data/agent.db';
        _instance = new SQLiteAdapter(filePath);
    } else {
        throw new Error(`Unknown DB_TYPE "${dbType}". Set DB_TYPE to "postgres" or "sqlite".`);
    }

    await _instance.init();
    return _instance;
}

/** Reset the singleton — useful for testing. */
export function resetDB(): void {
    _instance = null;
}
