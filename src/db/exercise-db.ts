import { type IDBAdapter } from './db-adapter.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkoutLift {
    id?: number;
    exercise_name: string;
    weight: number;
    sets: number;
    reps: number;
    notes?: string;
    /** ISO date string YYYY-MM-DD */
    date: string;
    created_at?: string;
    updated_at?: string;
}

export interface OneRepMaxResult {
    weight: number;
    reps: number;
    estimated_1rm_epley: number;
    estimated_1rm_brzycki: number;
}

export interface ExerciseOneRepMax extends OneRepMaxResult {
    exercise_name: string;
    date: string;
    lift_id?: number;
}

// ─── DDL helpers ──────────────────────────────────────────────────────────────

function workoutLiftsTableDDL(dialect: 'postgres' | 'sqlite'): string {
    if (dialect === 'postgres') {
        return `
            CREATE TABLE IF NOT EXISTS workout_lifts (
                id            SERIAL PRIMARY KEY,
                exercise_name VARCHAR(255)   NOT NULL,
                weight        NUMERIC(10,2)  NOT NULL CHECK (weight > 0),
                sets          INTEGER        NOT NULL CHECK (sets > 0),
                reps          INTEGER        NOT NULL CHECK (reps > 0),
                notes         TEXT,
                date          DATE           NOT NULL,
                created_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
                updated_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_workout_lifts_date ON workout_lifts(date);
            CREATE INDEX IF NOT EXISTS idx_workout_lifts_exercise ON workout_lifts(exercise_name);
            CREATE INDEX IF NOT EXISTS idx_workout_lifts_exercise_date ON workout_lifts(exercise_name, date);
        `;
    }
    return `
        CREATE TABLE IF NOT EXISTS workout_lifts (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            exercise_name TEXT    NOT NULL,
            weight        REAL    NOT NULL CHECK (weight > 0),
            sets          INTEGER NOT NULL CHECK (sets > 0),
            reps          INTEGER NOT NULL CHECK (reps > 0),
            notes         TEXT,
            date          TEXT    NOT NULL,
            created_at    TEXT    DEFAULT (datetime('now')),
            updated_at    TEXT    DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_workout_lifts_date ON workout_lifts(date);
        CREATE INDEX IF NOT EXISTS idx_workout_lifts_exercise ON workout_lifts(exercise_name);
        CREATE INDEX IF NOT EXISTS idx_workout_lifts_exercise_date ON workout_lifts(exercise_name, date);
    `;
}

// ─── Internal raw row type ────────────────────────────────────────────────────

type LiftRow = Record<string, unknown>;

// ─── ExerciseDBService ────────────────────────────────────────────────────────

export class ExerciseDBService {
    constructor(private readonly adapter: IDBAdapter) { }

    async init(): Promise<void> {
        const ddl = workoutLiftsTableDDL(this.adapter.dialect);
        for (const stmt of ddl.split(';').map(s => s.trim()).filter(Boolean)) {
            await this.adapter.execute(stmt);
        }
    }

    // ─── CRUD ─────────────────────────────────────────────────────────────────

    async createWorkoutLift(lift: Omit<WorkoutLift, 'id' | 'created_at' | 'updated_at'>): Promise<WorkoutLift> {
        if (this.adapter.dialect === 'postgres') {
            const rows = await this.adapter.query<LiftRow>(
                `INSERT INTO workout_lifts (exercise_name, weight, sets, reps, notes, date)
                 VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING *`,
                [lift.exercise_name, lift.weight, lift.sets, lift.reps, lift.notes ?? null, lift.date],
            );
            return this.mapRow(rows[0]);
        } else {
            const result = await this.adapter.execute(
                `INSERT INTO workout_lifts (exercise_name, weight, sets, reps, notes, date)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [lift.exercise_name, lift.weight, lift.sets, lift.reps, lift.notes ?? null, lift.date],
            );
            const rows = await this.adapter.query<LiftRow>(
                'SELECT * FROM workout_lifts WHERE id = ?',
                [result.lastInsertId],
            );
            return this.mapRow(rows[0]);
        }
    }

    async getWorkoutLiftById(id: number): Promise<WorkoutLift | null> {
        const rows = await this.adapter.query<LiftRow>(
            'SELECT * FROM workout_lifts WHERE id = ?',
            [id],
        );
        return rows[0] ? this.mapRow(rows[0]) : null;
    }

    async updateWorkoutLift(
        id: number,
        lift: Partial<Omit<WorkoutLift, 'id' | 'created_at' | 'updated_at'>>,
    ): Promise<WorkoutLift | null> {
        const fields: string[] = [];
        const values: unknown[] = [];

        if (lift.exercise_name !== undefined) { fields.push('exercise_name = ?'); values.push(lift.exercise_name); }
        if (lift.weight !== undefined) { fields.push('weight = ?'); values.push(lift.weight); }
        if (lift.sets !== undefined) { fields.push('sets = ?'); values.push(lift.sets); }
        if (lift.reps !== undefined) { fields.push('reps = ?'); values.push(lift.reps); }
        if (lift.notes !== undefined) { fields.push('notes = ?'); values.push(lift.notes); }
        if (lift.date !== undefined) { fields.push('date = ?'); values.push(lift.date); }

        if (fields.length === 0) return this.getWorkoutLiftById(id);

        const tsField = this.adapter.dialect === 'postgres'
            ? 'updated_at = CURRENT_TIMESTAMP'
            : "updated_at = datetime('now')";
        fields.push(tsField);
        values.push(id);

        if (this.adapter.dialect === 'postgres') {
            const rows = await this.adapter.query<LiftRow>(
                `UPDATE workout_lifts SET ${fields.join(', ')} WHERE id = ? RETURNING *`,
                values,
            );
            return rows[0] ? this.mapRow(rows[0]) : null;
        } else {
            await this.adapter.execute(
                `UPDATE workout_lifts SET ${fields.join(', ')} WHERE id = ?`,
                values,
            );
            return this.getWorkoutLiftById(id);
        }
    }

    async deleteWorkoutLift(id: number): Promise<boolean> {
        const result = await this.adapter.execute(
            'DELETE FROM workout_lifts WHERE id = ?',
            [id],
        );
        return result.rowsAffected > 0;
    }

    // ─── Queries ──────────────────────────────────────────────────────────────

    async getWorkoutLiftsByDate(date: string): Promise<WorkoutLift[]> {
        const rows = await this.adapter.query<LiftRow>(
            'SELECT * FROM workout_lifts WHERE date = ? ORDER BY created_at',
            [date],
        );
        return rows.map(r => this.mapRow(r));
    }

    async getWorkoutLiftsByExercise(exerciseName: string): Promise<WorkoutLift[]> {
        const rows = await this.adapter.query<LiftRow>(
            'SELECT * FROM workout_lifts WHERE exercise_name = ? ORDER BY date DESC, created_at DESC',
            [exerciseName],
        );
        return rows.map(r => this.mapRow(r));
    }

    async getWorkoutLiftsByExerciseAndDateRange(
        exerciseName: string,
        startDate: string,
        endDate: string,
    ): Promise<WorkoutLift[]> {
        const rows = await this.adapter.query<LiftRow>(
            `SELECT * FROM workout_lifts
             WHERE exercise_name = ? AND date >= ? AND date <= ?
             ORDER BY date DESC, created_at DESC`,
            [exerciseName, startDate, endDate],
        );
        return rows.map(r => this.mapRow(r));
    }

    async getWorkoutLiftsByDateRange(startDate: string, endDate: string): Promise<WorkoutLift[]> {
        const rows = await this.adapter.query<LiftRow>(
            `SELECT * FROM workout_lifts
             WHERE date >= ? AND date <= ?
             ORDER BY date DESC, created_at DESC`,
            [startDate, endDate],
        );
        return rows.map(r => this.mapRow(r));
    }

    // ─── Analytics ────────────────────────────────────────────────────────────

    async getMaxWeightByExercise(
        exerciseName: string,
    ): Promise<{ max_weight: number; date: string } | null> {
        const rows = await this.adapter.query<{ max_weight: unknown; date: unknown }>(
            `SELECT weight AS max_weight, date
             FROM workout_lifts
             WHERE exercise_name = ?
             ORDER BY weight DESC, date DESC
             LIMIT 1`,
            [exerciseName],
        );
        if (!rows[0]) return null;
        return {
            max_weight: Number(rows[0].max_weight),
            date: rows[0].date as string,
        };
    }

    async getTotalVolumeByExerciseAndDateRange(
        exerciseName: string,
        startDate: string,
        endDate: string,
    ): Promise<{ date: string; total_volume: number }[]> {
        const rows = await this.adapter.query<{ date: unknown; total_volume: unknown }>(
            `SELECT date, SUM(sets * reps * weight) AS total_volume
             FROM workout_lifts
             WHERE exercise_name = ? AND date >= ? AND date <= ?
             GROUP BY date
             ORDER BY date`,
            [exerciseName, startDate, endDate],
        );
        return rows.map(r => ({
            date: r.date as string,
            total_volume: Number(r.total_volume),
        }));
    }

    async getDistinctExercises(): Promise<string[]> {
        const rows = await this.adapter.query<{ exercise_name: unknown }>(
            'SELECT DISTINCT exercise_name FROM workout_lifts ORDER BY exercise_name',
            [],
        );
        return rows.map(r => r.exercise_name as string);
    }

    // ─── 1RM calculations ─────────────────────────────────────────────────────

    /** Epley formula: 1RM = w × (1 + 0.0333 × r) */
    calculateOneRepMaxEpley(weight: number, reps: number): number {
        if (reps === 1) return weight;
        return weight * (1 + 0.0333 * reps);
    }

    /** Brzycki formula: 1RM = w × 36 / (37 - r) */
    calculateOneRepMaxBrzycki(weight: number, reps: number): number {
        if (reps === 1) return weight;
        if (reps >= 37) throw new Error('Brzycki formula is not valid for 37+ reps');
        return weight * (36 / (37 - reps));
    }

    async getEstimatedOneRepMaxByExercise(exerciseName: string): Promise<ExerciseOneRepMax | null> {
        const rows = await this.adapter.query<LiftRow>(
            `SELECT id, exercise_name, weight, reps, date
             FROM workout_lifts
             WHERE exercise_name = ?
             ORDER BY (weight * (1 + 0.0333 * reps)) DESC
             LIMIT 1`,
            [exerciseName],
        );
        if (!rows[0]) return null;

        const weight = Number(rows[0].weight);
        const reps = Number(rows[0].reps);

        return {
            exercise_name: rows[0].exercise_name as string,
            weight,
            reps,
            estimated_1rm_epley: this.calculateOneRepMaxEpley(weight, reps),
            estimated_1rm_brzycki: this.calculateOneRepMaxBrzycki(weight, reps),
            date: rows[0].date as string,
            lift_id: rows[0].id as number,
        };
    }

    // ─── Row mapper ───────────────────────────────────────────────────────────

    private mapRow(row: LiftRow): WorkoutLift {
        return {
            id: row.id as number,
            exercise_name: row.exercise_name as string,
            weight: Number(row.weight),
            sets: Number(row.sets),
            reps: Number(row.reps),
            notes: row.notes as string | undefined,
            date: row.date as string,
            created_at: row.created_at as string | undefined,
            updated_at: row.updated_at as string | undefined,
        };
    }
}

// ─── Singleton factory ────────────────────────────────────────────────────────

import { getDB } from './db-factory.js';

let _instance: ExerciseDBService | null = null;

export async function getExerciseDB(): Promise<ExerciseDBService> {
    if (_instance) return _instance;
    const adapter = await getDB();
    _instance = new ExerciseDBService(adapter);
    await _instance.init();
    return _instance;
}

export function resetExerciseDB(): void {
    _instance = null;
}
