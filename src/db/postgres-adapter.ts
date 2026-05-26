import { Pool, type PoolConfig } from 'pg';
import { type IDBAdapter, type ExecuteResult } from './db-adapter.js';

/**
 * PostgreSQL adapter.
 * Accepts `?` placeholders in SQL and converts them to `$1, $2, …` before
 * handing off to the `pg` driver.
 */
export class PostgresAdapter implements IDBAdapter {
    readonly dialect = 'postgres' as const;
    private pool: Pool;

    constructor(config: PoolConfig) {
        this.pool = new Pool(config);
    }

    async init(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('SELECT 1');
        } finally {
            client.release();
        }
    }

    /** Replace `?` placeholders with `$1`, `$2`, … */
    private normalizePlaceholders(sql: string): string {
        let index = 0;
        return sql.replace(/\?/g, () => `$${++index}`);
    }

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        const normalized = this.normalizePlaceholders(sql);
        const result = await this.pool.query(normalized, params);
        return result.rows as T[];
    }

    async execute(sql: string, params: unknown[] = []): Promise<ExecuteResult> {
        const normalized = this.normalizePlaceholders(sql);
        const result = await this.pool.query(normalized, params);
        return {
            rowsAffected: result.rowCount ?? 0,
            lastInsertId: result.rows[0]?.id as number | undefined,
        };
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}
