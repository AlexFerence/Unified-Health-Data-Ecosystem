import fs from 'fs/promises';
import path from 'path';
import { type Embeddings } from '@langchain/core/embeddings';
import { createEmbeddings, cosineSimilarity } from '../service/embedding-service.js';
import { type IDBAdapter } from './db-adapter.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MealType = 'snack' | 'breakfast' | 'lunch' | 'dinner';

export interface Meal {
    id?: number;
    type: MealType;
    calories: number;
    protein: number;
    name: string;
    description: string;
    /** ISO date string YYYY-MM-DD */
    date: string;
    created_at?: string;
    updated_at?: string;
}

export interface TemplateMeal {
    id?: number;
    type: MealType;
    name: string;
    description: string;
    calories: number;
    protein: number;
    embedding?: number[];
    created_at?: string;
    updated_at?: string;
}

export interface TemplateMealSearchResult extends TemplateMeal {
    similarity: number;
}

// ─── DDL helpers ─────────────────────────────────────────────────────────────

function mealsTableDDL(dialect: 'postgres' | 'sqlite'): string {
    if (dialect === 'postgres') {
        return `
            CREATE TABLE IF NOT EXISTS meals (
                id          SERIAL PRIMARY KEY,
                type        VARCHAR(10)    NOT NULL CHECK (type IN ('snack','breakfast','lunch','dinner')),
                calories    INTEGER        NOT NULL CHECK (calories >= 0),
                protein     NUMERIC(10,2)  NOT NULL CHECK (protein >= 0),
                name        VARCHAR(255)   NOT NULL,
                description TEXT,
                date        DATE           NOT NULL,
                created_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
                updated_at  TIMESTAMP      DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);
            CREATE INDEX IF NOT EXISTS idx_meals_type ON meals(type);
        `;
    }
    return `
        CREATE TABLE IF NOT EXISTS meals (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT    NOT NULL CHECK (type IN ('snack','breakfast','lunch','dinner')),
            calories    INTEGER NOT NULL CHECK (calories >= 0),
            protein     REAL    NOT NULL CHECK (protein >= 0),
            name        TEXT    NOT NULL,
            description TEXT,
            date        TEXT    NOT NULL,
            created_at  TEXT    DEFAULT (datetime('now')),
            updated_at  TEXT    DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);
        CREATE INDEX IF NOT EXISTS idx_meals_type ON meals(type);
    `;
}

// ─── Internal raw row type (as returned by the DB driver) ────────────────────
type MealRow = Record<string, unknown>;

// ─── MealDBService ────────────────────────────────────────────────────────────

export class MealDBService {
    private templateMealsPath: string;
    private templateMealsCache: TemplateMeal[] | null = null;
    private embeddings: Embeddings | null = null;

    constructor(private readonly adapter: IDBAdapter, templateMealsPath?: string) {
        this.templateMealsPath = templateMealsPath
            ?? path.join(process.cwd(), 'data', 'template-meals.json');
        this.embeddings = createEmbeddings();
    }

    async init(): Promise<void> {
        const ddl = mealsTableDDL(this.adapter.dialect);

        // Execute statements one at a time — pg returns an array of results for
        // multi-statement queries (simple query mode), and sqlite requires it too.
        for (const stmt of ddl.split(';').map(s => s.trim()).filter(Boolean)) {
            await this.adapter.execute(stmt);
        }

        // Ensure data directory and template JSON file exist
        await fs.mkdir(path.dirname(this.templateMealsPath), { recursive: true });
        try {
            await fs.access(this.templateMealsPath);
        } catch {
            await this.saveTemplateMeals([]);
        }
    }

    // ─── Template meals (JSON file) ───────────────────────────────────────────

    private async loadTemplateMeals(): Promise<TemplateMeal[]> {
        if (this.templateMealsCache) return this.templateMealsCache;
        try {
            const data = await fs.readFile(this.templateMealsPath, 'utf-8');
            this.templateMealsCache = JSON.parse(data) as TemplateMeal[];
            return this.templateMealsCache;
        } catch {
            return [];
        }
    }

    private async saveTemplateMeals(meals: TemplateMeal[]): Promise<void> {
        await fs.writeFile(this.templateMealsPath, JSON.stringify(meals, null, 2), 'utf-8');
        this.templateMealsCache = meals;
    }

    private getNextTemplateId(meals: TemplateMeal[]): number {
        if (meals.length === 0) return 1;
        return Math.max(...meals.map(m => m.id ?? 0)) + 1;
    }

    // ─── Meals CRUD ───────────────────────────────────────────────────────────

    async createMeal(meal: Omit<Meal, 'id' | 'created_at' | 'updated_at'>): Promise<Meal> {
        if (this.adapter.dialect === 'postgres') {
            const sql = `
                INSERT INTO meals (type, calories, protein, name, description, date)
                VALUES (?, ?, ?, ?, ?, ?)
                RETURNING *
            `;
            const rows = await this.adapter.query<MealRow>(sql, [
                meal.type, meal.calories, meal.protein, meal.name, meal.description, meal.date,
            ]);
            return this.mapRow(rows[0]);
        } else {
            const sql = `
                INSERT INTO meals (type, calories, protein, name, description, date)
                VALUES (?, ?, ?, ?, ?, ?)
            `;
            const result = await this.adapter.execute(sql, [
                meal.type, meal.calories, meal.protein, meal.name, meal.description, meal.date,
            ]);
            const rows = await this.adapter.query<MealRow>(
                'SELECT * FROM meals WHERE id = ?',
                [result.lastInsertId],
            );
            return this.mapRow(rows[0]);
        }
    }

    async getMealById(id: number): Promise<Meal | null> {
        const rows = await this.adapter.query<MealRow>('SELECT * FROM meals WHERE id = ?', [id]);
        return rows[0] ? this.mapRow(rows[0]) : null;
    }

    async getMealsByDate(date: string): Promise<Meal[]> {
        const rows = await this.adapter.query<MealRow>(
            'SELECT * FROM meals WHERE date = ? ORDER BY created_at',
            [date],
        );
        return rows.map(r => this.mapRow(r));
    }

    async getMealsByDateRange(startDate: string, endDate: string): Promise<Meal[]> {
        const rows = await this.adapter.query<MealRow>(
            'SELECT * FROM meals WHERE date >= ? AND date <= ? ORDER BY date, created_at',
            [startDate, endDate],
        );
        return rows.map(r => this.mapRow(r));
    }

    async updateMeal(id: number, meal: Partial<Omit<Meal, 'id' | 'created_at' | 'updated_at'>>): Promise<Meal | null> {
        const fields: string[] = [];
        const values: unknown[] = [];

        if (meal.type !== undefined) { fields.push('type = ?'); values.push(meal.type); }
        if (meal.calories !== undefined) { fields.push('calories = ?'); values.push(meal.calories); }
        if (meal.protein !== undefined) { fields.push('protein = ?'); values.push(meal.protein); }
        if (meal.name !== undefined) { fields.push('name = ?'); values.push(meal.name); }
        if (meal.description !== undefined) { fields.push('description = ?'); values.push(meal.description); }
        if (meal.date !== undefined) { fields.push('date = ?'); values.push(meal.date); }

        if (fields.length === 0) return this.getMealById(id);

        const tsField = this.adapter.dialect === 'postgres'
            ? 'updated_at = CURRENT_TIMESTAMP'
            : "updated_at = datetime('now')";
        fields.push(tsField);
        values.push(id);

        if (this.adapter.dialect === 'postgres') {
            const rows = await this.adapter.query<MealRow>(
                `UPDATE meals SET ${fields.join(', ')} WHERE id = ? RETURNING *`,
                values,
            );
            return rows[0] ? this.mapRow(rows[0]) : null;
        } else {
            await this.adapter.execute(
                `UPDATE meals SET ${fields.join(', ')} WHERE id = ?`,
                values,
            );
            return this.getMealById(id);
        }
    }

    async deleteMeal(id: number): Promise<boolean> {
        const result = await this.adapter.execute('DELETE FROM meals WHERE id = ?', [id]);
        return result.rowsAffected > 0;
    }

    async getAllMeals(limit = 100, offset = 0): Promise<Meal[]> {
        const rows = await this.adapter.query<MealRow>(
            'SELECT * FROM meals ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?',
            [limit, offset],
        );
        return rows.map(r => this.mapRow(r));
    }

    async getTotalCaloriesByDate(date: string): Promise<number> {
        const rows = await this.adapter.query<{ total: string | number }>(
            'SELECT COALESCE(SUM(calories), 0) AS total FROM meals WHERE date = ?',
            [date],
        );
        return Number(rows[0]?.total ?? 0);
    }

    async getTotalProteinByDate(date: string): Promise<number> {
        const rows = await this.adapter.query<{ total: string | number }>(
            'SELECT COALESCE(SUM(protein), 0) AS total FROM meals WHERE date = ?',
            [date],
        );
        return Number(rows[0]?.total ?? 0);
    }

    private mapRow(row: Record<string, unknown>): Meal {
        return {
            id: row.id as number,
            type: row.type as MealType,
            calories: Number(row.calories),
            protein: Number(row.protein),
            name: row.name as string,
            description: row.description as string,
            date: row.date as string,
            created_at: row.created_at as string | undefined,
            updated_at: row.updated_at as string | undefined,
        };
    }

    // ─── Template meals ───────────────────────────────────────────────────────

    async createTemplateMeal(
        meal: Omit<TemplateMeal, 'id' | 'embedding' | 'created_at' | 'updated_at'>,
    ): Promise<TemplateMeal> {
        const meals = await this.loadTemplateMeals();

        let embedding: number[] | undefined;
        if (this.embeddings) {
            try {
                embedding = await this.embeddings.embedQuery(`${meal.name} ${meal.description}`);
            } catch {
                // embedding optional — continue without it
            }
        }

        const newMeal: TemplateMeal = {
            id: this.getNextTemplateId(meals),
            type: meal.type,
            calories: meal.calories,
            protein: meal.protein,
            name: meal.name,
            description: meal.description,
            embedding,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };

        meals.push(newMeal);
        await this.saveTemplateMeals(meals);
        return newMeal;
    }

    async getAllTemplateMeals(): Promise<TemplateMeal[]> {
        const meals = await this.loadTemplateMeals();
        return meals.sort((a, b) => a.name.localeCompare(b.name));
    }

    async getTemplateMealById(id: number): Promise<TemplateMeal | null> {
        const meals = await this.loadTemplateMeals();
        return meals.find(m => m.id === id) ?? null;
    }

    async deleteTemplateMeal(id: number): Promise<boolean> {
        const meals = await this.loadTemplateMeals();
        const filtered = meals.filter(m => m.id !== id);
        if (filtered.length === meals.length) return false;
        await this.saveTemplateMeals(filtered);
        return true;
    }

    async searchTemplateMeals(query: string, limit = 3): Promise<TemplateMealSearchResult[]> {
        const meals = await this.loadTemplateMeals();
        const withEmbeddings = meals.filter(m => m.embedding && m.embedding.length > 0);

        if (withEmbeddings.length === 0 || !this.embeddings) {
            // Fall back to simple name/description text search
            const q = query.toLowerCase();
            return meals
                .filter(m => m.name.toLowerCase().includes(q) || m.description?.toLowerCase().includes(q))
                .slice(0, limit)
                .map(m => ({ ...m, similarity: 1 }));
        }

        const queryEmbedding = await this.embeddings.embedQuery(query);

        return withEmbeddings
            .map(m => ({ ...m, similarity: cosineSimilarity(queryEmbedding, m.embedding!) }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, limit);
    }

    async close(): Promise<void> {
        await this.adapter.close();
    }
}
