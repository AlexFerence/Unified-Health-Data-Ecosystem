import { tool } from '@langchain/core/tools';
import { type StructuredToolInterface } from '@langchain/core/tools';
import * as z from 'zod';
import { getDB } from '../db/db-factory.js';
import { MealDBService, type MealType } from '../db/meal-db.js';

// ─── Lazy singleton for the service ──────────────────────────────────────────

let _service: MealDBService | null = null;

async function getService(): Promise<MealDBService> {
    if (_service) return _service;
    const adapter = await getDB();
    _service = new MealDBService(adapter);
    await _service.init();
    return _service;
}

// ─── Shared schemas ───────────────────────────────────────────────────────────

const MealTypeSchema = z.enum(['snack', 'breakfast', 'lunch', 'dinner']);

// ─── Tools ───────────────────────────────────────────────────────────────────

export const meal_log_tool = tool(
    async ({ type, name, description, calories, protein, date }) => {
        const svc = await getService();
        const meal = await svc.createMeal({ type: type as MealType, name, description, calories, protein, date });
        return JSON.stringify(meal);
    },
    {
        name: 'meal_log',
        description: 'Log an actual meal that was eaten. Returns the saved meal record with its id.',
        schema: z.object({
            type: MealTypeSchema.describe("Meal type: 'snack', 'breakfast', 'lunch', or 'dinner'"),
            name: z.string().describe('Short name of the meal, e.g. "Chicken salad"'),
            description: z.string().describe('Ingredients or details about the meal'),
            calories: z.number().int().min(0).describe('Total calories'),
            protein: z.number().min(0).describe('Total protein in grams'),
            date: z.string().describe('Date eaten in YYYY-MM-DD format in PST/Vancouver time. Always call get_current_date to determine today\'s date — never assume.'),
        }),
    },
);

export const meal_get_by_date_tool = tool(
    async ({ date }) => {
        const svc = await getService();
        const meals = await svc.getMealsByDate(date);
        return JSON.stringify(meals);
    },
    {
        name: 'meal_get_by_date',
        description: 'Get all logged meals for a specific date. Always call get_current_date first to determine today\'s date in PST/Vancouver time.',
        schema: z.object({
            date: z.string().describe('Date in YYYY-MM-DD format (PST/Vancouver time)'),
        }),
    },
);

export const meal_get_totals_tool = tool(
    async ({ date }) => {
        const svc = await getService();
        const [calories, protein] = await Promise.all([
            svc.getTotalCaloriesByDate(date),
            svc.getTotalProteinByDate(date),
        ]);
        return JSON.stringify({ date, totalCalories: calories, totalProteinG: protein });
    },
    {
        name: 'meal_get_totals',
        description: 'Get total calories and protein consumed on a specific date. Always call get_current_date first to determine today\'s date in PST/Vancouver time.',
        schema: z.object({
            date: z.string().describe('Date in YYYY-MM-DD format (PST/Vancouver time)'),
        }),
    },
);

export const meal_get_range_tool = tool(
    async ({ startDate, endDate }) => {
        const svc = await getService();
        const meals = await svc.getMealsByDateRange(startDate, endDate);
        return JSON.stringify(meals);
    },
    {
        name: 'meal_get_range',
        description: 'Get all logged meals between two dates (inclusive).',
        schema: z.object({
            startDate: z.string().describe('Start date in YYYY-MM-DD format (inclusive, PST/Vancouver time)'),
            endDate: z.string().describe('End date in YYYY-MM-DD format (inclusive, PST/Vancouver time)'),
        }),
    },
);

export const meal_update_tool = tool(
    async ({ id, type, name, description, calories, protein, date }) => {
        const svc = await getService();
        const updated = await svc.updateMeal(id, {
            ...(type !== undefined && { type: type as MealType }),
            ...(name !== undefined && { name }),
            ...(description !== undefined && { description }),
            ...(calories !== undefined && { calories }),
            ...(protein !== undefined && { protein }),
            ...(date !== undefined && { date }),
        });
        if (!updated) return JSON.stringify({ error: `Meal ${id} not found` });
        return JSON.stringify(updated);
    },
    {
        name: 'meal_update',
        description: 'Update one or more fields of a logged meal by its id.',
        schema: z.object({
            id: z.number().int().describe('The id of the meal to update'),
            type: MealTypeSchema.optional().describe("Meal type: 'snack', 'breakfast', 'lunch', or 'dinner'"),
            name: z.string().optional().describe('Short name of the meal'),
            description: z.string().optional().describe('Ingredients or details'),
            calories: z.number().int().min(0).optional().describe('Total calories'),
            protein: z.number().min(0).optional().describe('Total protein in grams'),
            date: z.string().optional().describe('Date in YYYY-MM-DD format (PST/Vancouver time)'),
        }),
    },
);

export const meal_delete_tool = tool(
    async ({ id }) => {
        const svc = await getService();
        const deleted = await svc.deleteMeal(id);
        return JSON.stringify({ deleted, id });
    },
    {
        name: 'meal_delete',
        description: 'Delete a logged meal by its id.',
        schema: z.object({
            id: z.number().int().describe('The id of the meal to delete'),
        }),
    },
);

export const meal_template_delete_tool = tool(
    async ({ id }) => {
        const svc = await getService();
        const deleted = await svc.deleteTemplateMeal(id);
        if (!deleted) return JSON.stringify({ error: `Template meal ${id} not found` });
        return JSON.stringify({ deleted: true, id });
    },
    {
        name: 'template_meal_delete',
        description: 'Delete a meal from the template library by its id.',
        schema: z.object({
            id: z.number().int().describe('The id of the template meal to delete'),
        }),
    },
);

export const meal_template_create_tool = tool(
    async ({ type, name, description, calories, protein }) => {
        const svc = await getService();
        const template = await svc.createTemplateMeal({ type: type as MealType, name, description, calories, protein });
        const { embedding: _, ...rest } = template;
        return JSON.stringify(rest);
    },
    {
        name: 'template_meal_create',
        description: 'Add a meal to the reusable template library. Templates are used as a reference when logging future meals.',
        schema: z.object({
            type: MealTypeSchema.describe("Meal type: 'snack', 'breakfast', 'lunch', or 'dinner'"),
            name: z.string().describe('Short name of the meal, e.g. "Overnight oats"'),
            description: z.string().describe('Ingredients or details'),
            calories: z.number().int().min(0).describe('Total calories'),
            protein: z.number().min(0).describe('Total protein in grams'),
        }),
    },
);

export const meal_template_list_tool = tool(
    async () => {
        const svc = await getService();
        const templates = await svc.getAllTemplateMeals();
        return JSON.stringify(templates.map(({ embedding: _, ...t }) => t));
    },
    {
        name: 'template_meal_list',
        description: 'List all meals in the template library (sorted by name).',
        schema: z.object({}),
    },
);

export const meal_template_search_tool = tool(
    async ({ query, limit }) => {
        const svc = await getService();
        const results = await svc.searchTemplateMeals(query, limit ?? 3);
        return JSON.stringify(results.map(({ embedding: _, ...r }) => r));
    },
    {
        name: 'template_meal_search',
        description: 'Search the meal template library by description or ingredients using semantic similarity. Returns the most relevant templates.',
        schema: z.object({
            query: z.string().describe('Natural language description to search for, e.g. "high protein breakfast"'),
            limit: z.number().int().min(1).max(10).optional().describe('Max results to return (default 3)'),
        }),
    },
);

// ─── Export all tools ─────────────────────────────────────────────────────────

export function getAllMealTools() {
    return {
        tools: {
            [meal_log_tool.name]: meal_log_tool,
            [meal_get_by_date_tool.name]: meal_get_by_date_tool,
            [meal_get_totals_tool.name]: meal_get_totals_tool,
            [meal_get_range_tool.name]: meal_get_range_tool,
            [meal_update_tool.name]: meal_update_tool,
            [meal_delete_tool.name]: meal_delete_tool,
            [meal_template_create_tool.name]: meal_template_create_tool,
            [meal_template_list_tool.name]: meal_template_list_tool,
            [meal_template_search_tool.name]: meal_template_search_tool,
            [meal_template_delete_tool.name]: meal_template_delete_tool,
        },
        requiredEnvVars: [] as string[],
    };
}
