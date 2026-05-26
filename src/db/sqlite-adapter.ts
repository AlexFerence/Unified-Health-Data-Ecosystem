import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { type IDBAdapter, type ExecuteResult } from './db-adapter.js';

/**
 * SQLite adapter backed by `better-sqlite3`.
 * The library is synchronous; we wrap calls in `Promise.resolve()` to satisfy
 * the async `IDBAdapter` contract without introducing event-loop overhead.
 */
export class SQLiteAdapter implements IDBAdapter {
    readonly dialect = 'sqlite' as const;
    private db!: Database.Database;
    private filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    async init(): Promise<void> {
        // Ensure the directory exists before opening the file
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });

        this.db = new Database(this.filePath);
        // WAL mode gives much better concurrent read performance
        this.db.pragma('journal_mode = WAL');
        // Enforce foreign keys
        this.db.pragma('foreign_keys = ON');
    }

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        const stmt = this.db.prepare(sql);
        return Promise.resolve(stmt.all(...params) as T[]);
    }

    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
        const stmt = this.db.prepare(sql);
        const info = stmt.run(...params);
        return Promise.resolve({
            rowsAffected: info.changes,
            lastInsertId: Number(info.lastInsertRowid),
        });
    }

    async close(): Promise<void> {
        this.db.close();
    }
}
