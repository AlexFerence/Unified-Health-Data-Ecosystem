/**
 * Generic database adapter interface.
 * All SQL should use `?` positional placeholders — adapters normalize them
 * for their underlying engine (Postgres converts `?` → `$1, $2, …`).
 */

export interface ExecuteResult {
    rowsAffected: number;
    lastInsertId?: number;
}

export interface IDBAdapter {
    /** The underlying SQL dialect, used for dialect-specific DDL. */
    readonly dialect: 'postgres' | 'sqlite';

    /** Connect to / verify the database. Must be called once before any queries. */
    init(): Promise<void>;

    /**
     * Run a SELECT (or any statement that returns rows).
     * Use `?` as positional placeholders.
     */
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

    /**
     * Run an INSERT / UPDATE / DELETE.
     * Use `?` as positional placeholders.
     * Returns rows-affected count and, for INSERT, the last inserted row id.
     */
    execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

    /** Gracefully close the connection / pool. */
    close(): Promise<void>;
}
