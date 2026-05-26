import { tool } from '@langchain/core/tools';
import { type StructuredToolInterface } from '@langchain/core/tools';
import * as z from 'zod';
import { getExerciseDB } from '../db/exercise-db.js';

// ─── Lazy singleton for the service ──────────────────────────────────────────

import { type ExerciseDBService } from '../db/exercise-db.js';

let _service: ExerciseDBService | null = null;

async function getService(): Promise<ExerciseDBService> {
    if (_service) return _service;
    _service = await getExerciseDB();
    return _service;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const KG_TO_LBS = 2.20462;

export const exercise_log_lift_tool = tool(
    async ({ exercise_name, weight, unit, sets, reps, notes, date }) => {
        const weightLbs = unit === 'kg' ? Math.round(weight * KG_TO_LBS * 100) / 100 : weight;
        const svc = await getService();
        const lift = await svc.createWorkoutLift({ exercise_name, weight: weightLbs, sets, reps, notes, date });
        return JSON.stringify({ ...lift, note: unit === 'kg' ? `Weight converted from ${weight} kg to ${weightLbs} lbs` : undefined });
    },
    {
        name: 'exercise_log_lift',
        description: 'Log a strength training lift. Weight is always stored in lbs — pass the unit so conversion happens automatically.',
        schema: z.object({
            exercise_name: z.string().describe('Name of the exercise, e.g. "Bench Press", "Squat"'),
            weight: z.number().positive().describe('Weight lifted (in the unit specified by the unit field)'),
            unit: z.enum(['lbs', 'kg']).default('lbs').describe('Unit of the weight value: "lbs" or "kg". Defaults to lbs. If the user says kg, pass "kg" and the conversion is handled automatically.'),
            sets: z.number().int().positive().describe('Number of sets performed'),
            reps: z.number().int().positive().describe('Number of reps per set'),
            notes: z.string().optional().describe('Optional notes, e.g. "felt strong", "paused reps"'),
            date: z.string().describe('Date of the lift in YYYY-MM-DD format (PST/Vancouver time).'),
        }),
    },
);

export const exercise_get_by_date_tool = tool(
    async ({ date }) => {
        const svc = await getService();
        const lifts = await svc.getWorkoutLiftsByDate(date);
        return JSON.stringify(lifts);
    },
    {
        name: 'exercise_get_by_date',
        description: 'Get all logged workout lifts for a specific date. Returned weight values are in lbs.',
        schema: z.object({
            date: z.string().describe('Date in YYYY-MM-DD format (PST/Vancouver time)'),
        }),
    },
);

export const exercise_get_by_exercise_tool = tool(
    async ({ exercise_name, start_date, end_date }) => {
        const svc = await getService();
        const lifts = start_date && end_date
            ? await svc.getWorkoutLiftsByExerciseAndDateRange(exercise_name, start_date, end_date)
            : await svc.getWorkoutLiftsByExercise(exercise_name);
        return JSON.stringify(lifts);
    },
    {
        name: 'exercise_get_by_exercise',
        description: 'Get all logged lifts for a specific exercise, optionally filtered by date range. Returned weight values are in lbs.',
        schema: z.object({
            exercise_name: z.string().describe('Name of the exercise to look up'),
            start_date: z.string().optional().describe('Start date in YYYY-MM-DD format (inclusive)'),
            end_date: z.string().optional().describe('End date in YYYY-MM-DD format (inclusive)'),
        }),
    },
);

export const exercise_get_by_date_range_tool = tool(
    async ({ start_date, end_date }) => {
        const svc = await getService();
        const lifts = await svc.getWorkoutLiftsByDateRange(start_date, end_date);
        return JSON.stringify(lifts);
    },
    {
        name: 'exercise_get_by_date_range',
        description: 'Get all logged lifts between two dates (inclusive). Returned weight values are in lbs.',
        schema: z.object({
            start_date: z.string().describe('Start date in YYYY-MM-DD format (inclusive, PST/Vancouver time)'),
            end_date: z.string().describe('End date in YYYY-MM-DD format (inclusive, PST/Vancouver time)'),
        }),
    },
);

export const exercise_update_lift_tool = tool(
    async ({ id, exercise_name, weight, unit, sets, reps, notes, date }) => {
        const weightLbs = weight !== undefined
            ? (unit === 'kg' ? Math.round(weight * KG_TO_LBS * 100) / 100 : weight)
            : undefined;
        const svc = await getService();
        const updated = await svc.updateWorkoutLift(id, {
            ...(exercise_name !== undefined && { exercise_name }),
            ...(weightLbs !== undefined && { weight: weightLbs }),
            ...(sets !== undefined && { sets }),
            ...(reps !== undefined && { reps }),
            ...(notes !== undefined && { notes }),
            ...(date !== undefined && { date }),
        });
        if (!updated) return JSON.stringify({ error: `Lift ${id} not found` });
        return JSON.stringify({ ...updated, note: unit === 'kg' && weight !== undefined ? `Weight converted from ${weight} kg to ${weightLbs} lbs` : undefined });
    },
    {
        name: 'exercise_update_lift',
        description: 'Update one or more fields of a logged lift by its id. Weight is always stored in lbs.',
        schema: z.object({
            id: z.number().int().describe('The id of the lift to update'),
            exercise_name: z.string().optional().describe('Name of the exercise'),
            weight: z.number().positive().optional().describe('Weight lifted (in the unit specified by the unit field)'),
            unit: z.enum(['lbs', 'kg']).default('lbs').optional().describe('Unit of the weight value: "lbs" or "kg". Defaults to lbs.'),
            sets: z.number().int().positive().optional().describe('Number of sets'),
            reps: z.number().int().positive().optional().describe('Number of reps per set'),
            notes: z.string().optional().describe('Optional notes'),
            date: z.string().optional().describe('Date in YYYY-MM-DD format (PST/Vancouver time)'),
        }),
    },
);

export const exercise_delete_lift_tool = tool(
    async ({ id }) => {
        const svc = await getService();
        const deleted = await svc.deleteWorkoutLift(id);
        return JSON.stringify({ deleted, id });
    },
    {
        name: 'exercise_delete_lift',
        description: 'Delete a logged lift by its id.',
        schema: z.object({
            id: z.number().int().describe('The id of the lift to delete'),
        }),
    },
);

export const exercise_get_max_weight_tool = tool(
    async ({ exercise_name }) => {
        const svc = await getService();
        const result = await svc.getMaxWeightByExercise(exercise_name);
        if (!result) return JSON.stringify({ error: `No lifts found for "${exercise_name}"` });
        return JSON.stringify({ exercise_name, ...result });
    },
    {
        name: 'exercise_get_max_weight',
        description: 'Get the heaviest weight ever logged for a specific exercise, along with the date it was lifted. Returned weight is in lbs.',
        schema: z.object({
            exercise_name: z.string().describe('Name of the exercise'),
        }),
    },
);

export const exercise_get_volume_tool = tool(
    async ({ exercise_name, start_date, end_date }) => {
        const svc = await getService();
        const rows = await svc.getTotalVolumeByExerciseAndDateRange(exercise_name, start_date, end_date);
        const grandTotal = rows.reduce((sum, r) => sum + r.total_volume, 0);
        return JSON.stringify({ exercise_name, start_date, end_date, by_date: rows, grand_total_volume: grandTotal });
    },
    {
        name: 'exercise_get_volume',
        description: 'Get the total training volume (sets × reps × weight) for an exercise over a date range, broken down by day. Weight values and volume are in lbs.',
        schema: z.object({
            exercise_name: z.string().describe('Name of the exercise'),
            start_date: z.string().describe('Start date in YYYY-MM-DD format (inclusive, PST/Vancouver time)'),
            end_date: z.string().describe('End date in YYYY-MM-DD format (inclusive, PST/Vancouver time)'),
        }),
    },
);

export const exercise_get_1rm_tool = tool(
    async ({ exercise_name }) => {
        const svc = await getService();
        const result = await svc.getEstimatedOneRepMaxByExercise(exercise_name);
        if (!result) return JSON.stringify({ error: `No lifts found for "${exercise_name}"` });
        return JSON.stringify(result);
    },
    {
        name: 'exercise_get_1rm',
        description: 'Get the estimated one-rep max (1RM) for an exercise using both the Epley and Brzycki formulas, based on the best recorded lift. Returned values are in lbs.',
        schema: z.object({
            exercise_name: z.string().describe('Name of the exercise'),
        }),
    },
);

export const exercise_get_exercises_tool = tool(
    async () => {
        const svc = await getService();
        const exercises = await svc.getDistinctExercises();
        return JSON.stringify(exercises);
    },
    {
        name: 'exercise_get_exercises',
        description: 'List all distinct exercise names that have been logged.',
        schema: z.object({}),
    },
);

// ─── Export all tools ─────────────────────────────────────────────────────────

export function getAllExerciseTools() {
    return {
        tools: {
            [exercise_log_lift_tool.name]: exercise_log_lift_tool,
            [exercise_get_by_date_tool.name]: exercise_get_by_date_tool,
            [exercise_get_by_exercise_tool.name]: exercise_get_by_exercise_tool,
            [exercise_get_by_date_range_tool.name]: exercise_get_by_date_range_tool,
            [exercise_update_lift_tool.name]: exercise_update_lift_tool,
            [exercise_delete_lift_tool.name]: exercise_delete_lift_tool,
            [exercise_get_max_weight_tool.name]: exercise_get_max_weight_tool,
            [exercise_get_volume_tool.name]: exercise_get_volume_tool,
            [exercise_get_1rm_tool.name]: exercise_get_1rm_tool,
            [exercise_get_exercises_tool.name]: exercise_get_exercises_tool,
        },
        requiredEnvVars: [] as string[],
    };
}
