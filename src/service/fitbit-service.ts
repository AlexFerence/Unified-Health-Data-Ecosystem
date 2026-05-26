
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import * as z from "zod";

const FITBIT_AUTH_URI = "https://www.fitbit.com/oauth2/authorize";
const FITBIT_TOKEN_URI = "https://api.fitbit.com/oauth2/token";
const FITBIT_API_BASE = "https://api.fitbit.com";
const FITBIT_SCOPES = "activity heartrate location nutrition profile settings sleep social weight";
const REDIRECT_URI = "http://localhost:8765/callback";
const CACHE_DIR = path.join(process.cwd(), 'cache');
const TOKEN_FILE = path.join(CACHE_DIR, 'fitbit-tokens.json');

// ─── Token storage ────────────────────────────────────────────────────────────

interface FitbitTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // epoch ms
}

// ─── Response shape interfaces ───────────────────────────────────────────────

export interface FitbitHeartRateSummary {
    "activities-heart": Array<{
        dateTime: string;
        value: {
            restingHeartRate?: number;
            heartRateZones: Array<{
                name: string;
                min: number;
                max: number;
                minutes: number;
                caloriesOut: number;
            }>;
        };
    }>;
}

export interface FitbitHRVSummary {
    hrv: Array<{
        hrv: Array<{
            value: {
                dailyRmssd: number;
                deepRmssd: number;
            };
            dateTime: string;
        }>;
    }>;
}

export interface FitbitSleepSummary {
    sleep: Array<{
        dateOfSleep: string;
        duration: number;
        efficiency: number;
        minutesAsleep: number;
        minutesAwake: number;
        startTime: string;
        endTime: string;
        levels?: {
            summary: {
                deep?: { minutes: number };
                light?: { minutes: number };
                rem?: { minutes: number };
                wake?: { minutes: number };
            };
        };
    }>;
    summary: {
        totalMinutesAsleep: number;
        totalSleepRecords: number;
        totalTimeInBed: number;
    };
}

export interface FitbitActivity {
    activityId: number;
    activityName: string;
    calories: number;
    duration: number;
    startTime: string;
    steps?: number;
    distance?: number;
    activeDuration?: number;
}

export interface FitbitActivityList {
    activities: FitbitActivity[];
    pagination: {
        beforeDate?: string;
        afterDate?: string;
        limit: number;
        next: string;
        offset: number;
        previous: string;
        sort: string;
    };
}

export interface FitbitTimeSeries {
    [key: string]: Array<{ dateTime: string; value: string }>;
}

export type FitbitPeriod = "1d" | "7d" | "30d" | "1w" | "1m" | "3m" | "6m" | "1y" | "max";
export type FitbitActivitySort = "asc" | "desc";

const VALID_FITBIT_PERIODS: FitbitPeriod[] = ["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y", "max"];

/**
 * Validates a period string and returns it as FitbitPeriod.
 * Throws a descriptive error for invalid values so callers get a clear message
 * instead of a cryptic Fitbit API 400.
 */
function toFitbitPeriod(period: string | undefined, defaultPeriod: FitbitPeriod = "1d"): FitbitPeriod {
    if (!period) return defaultPeriod;
    if ((VALID_FITBIT_PERIODS as string[]).includes(period)) return period as FitbitPeriod;
    throw new Error(
        `Invalid Fitbit period: "${period}". Valid values are: ${VALID_FITBIT_PERIODS.join(", ")}. ` +
        `For ~10 days use "30d", for ~1 week use "7d" or "1w".`
    );
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class FitbitService {
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private readonly clientId: string;
    private readonly clientSecret: string;

    constructor(
        clientId: string = process.env.FITBIT_CLIENT_ID ?? "",
        clientSecret: string = process.env.FITBIT_CLIENT_SECRET ?? ""
    ) {
        if (!clientId || !clientSecret) {
            throw new Error("FITBIT_CLIENT_ID and FITBIT_CLIENT_SECRET must be set.");
        }
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }

    // ── Auth ──────────────────────────────────────────────────────────────────

    /** Returns the Fitbit OAuth authorization URL. Open this in a browser to grant access. */
    getAuthorizationUrl(): string {
        const state = crypto.randomBytes(16).toString('hex');
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.clientId,
            redirect_uri: REDIRECT_URI,
            scope: FITBIT_SCOPES,
            state,
        });
        return `${FITBIT_AUTH_URI}?${params}`;
    }

    /**
     * Starts a local callback server on port 8765, opens the Fitbit authorization URL
     * in the browser, and waits for the user to authorize. Saves tokens to TOKEN_FILE.
     * Returns the authorization URL so callers (e.g. an LLM tool) can surface it directly.
     */
    async startOAuthFlow(): Promise<string> {
        const authUrl = this.getAuthorizationUrl();

        console.log('\nOpen this URL in your browser to authorize Fitbit:\n');
        console.log(authUrl);
        console.log('\nWaiting for authorization on http://localhost:8765/callback ...');

        // Try to open the browser automatically on macOS/Linux
        exec(`open "${authUrl}"`);

        const code = await new Promise<string>((resolve, reject) => {
            const server = http.createServer((req, res) => {
                if (!req.url) return;
                const url = new URL(req.url, 'http://localhost:8765');
                if (url.pathname !== '/callback') return;

                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
                    server.close();
                    reject(new Error(`Fitbit authorization denied: ${error}`));
                    return;
                }

                if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end('<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>', () => {
                        server.close();
                        resolve(code);
                    });
                }
            });

            server.listen(8765, '127.0.0.1');
            server.on('error', reject);
        });

        await this.exchangeCode(code);
        console.log('Fitbit authorization complete. Tokens saved.');
        return authUrl;
    }

    /**
     * Loads stored tokens if valid, refreshes if expired, or runs the full OAuth flow.
     * Returns the authorization URL when a full OAuth flow is triggered (token missing/unrefreshable),
     * so callers can surface it to the user. Returns undefined when tokens were already valid.
     */
    async authenticate(): Promise<string | undefined> {
        const stored = this.loadTokens();
        if (stored) {
            if (Date.now() < stored.expires_at - 60_000) {
                this.accessToken = stored.access_token;
                this.refreshToken = stored.refresh_token;
                return undefined;
            }
            try {
                await this.refreshAccessToken(stored.refresh_token);
                return undefined;
            } catch {
                // Refresh failed — fall through to full OAuth flow
            }
        }
        return this.startOAuthFlow();
    }

    private async exchangeCode(code: string): Promise<void> {
        const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT_URI,
        });

        const response = await fetch(FITBIT_TOKEN_URI, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });

        if (!response.ok) {
            throw new Error(`Fitbit token exchange failed: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        this.saveTokens({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + data.expires_in * 1000,
        });
    }

    private async refreshAccessToken(refreshToken: string): Promise<void> {
        const auth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });

        const response = await fetch(FITBIT_TOKEN_URI, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });

        if (!response.ok) {
            throw new Error(`Fitbit token refresh failed: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        this.saveTokens({
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            expires_at: Date.now() + data.expires_in * 1000,
        });
    }

    private saveTokens(tokens: FitbitTokens): void {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
    }

    private loadTokens(): FitbitTokens | null {
        try {
            const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
            return JSON.parse(raw) as FitbitTokens;
        } catch {
            return null;
        }
    }

    // ── Heart Rate ────────────────────────────────────────────────────────────

    /** Daily heart rate summary including resting heart rate. */
    async getHeartRate(date: string, period: FitbitPeriod | string = "1d"): Promise<FitbitHeartRateSummary> {
        const p = toFitbitPeriod(period as string);
        return this.get(`/1/user/-/activities/heart/date/${date}/${p}.json`);
    }

    /** HRV (rmssd) summary for the main sleep on a given date. */
    async getHRV(date: string): Promise<FitbitHRVSummary> {
        return this.get(`/1/user/-/hrv/date/${date}.json`);
    }

    /** Intraday HRV by interval for a date range. */
    async getHRVRange(startDate: string, endDate: string): Promise<FitbitHRVSummary> {
        return this.get(`/1/user/-/hrv/date/${startDate}/${endDate}/all.json`);
    }

    // ── Sleep ─────────────────────────────────────────────────────────────────

    /** Detailed sleep log for a single date (stages: deep, light, REM, wake). */
    async getSleep(date: string): Promise<FitbitSleepSummary> {
        return this.get(`/1.2/user/-/sleep/date/${date}.json`);
    }

    /** Sleep time series over a period. */
    async getSleepRange(date: string, period: FitbitPeriod | string): Promise<FitbitSleepSummary> {
        const p = toFitbitPeriod(period as string, "1d");
        // Fitbit sleep API only supports a single date or a date range (no period shorthand).
        if (p === "1d") {
            return this.get(`/1.2/user/-/sleep/date/${date}.json`);
        }

        // Map period to number of days to subtract from endDate
        const periodDays: Record<FitbitPeriod, number> = {
            "1d": 1,
            "7d": 7,
            "1w": 7,
            "30d": 30,
            "1m": 30,
            "3m": 90,
            "6m": 180,
            "1y": 365,
            "max": 365,
        };

        const days = periodDays[p] ?? 30;
        const end = new Date(date);
        const start = new Date(end);
        start.setDate(end.getDate() - (days - 1));

        const fmt = (d: Date) => d.toISOString().slice(0, 10);
        return this.get(`/1.2/user/-/sleep/date/${fmt(start)}/${fmt(end)}.json`);
    }

    // ── Activity ──────────────────────────────────────────────────────────────

    /** List logged activity/workout entries. */
    async getActivities(options: {
        beforeDate?: string;
        afterDate?: string;
        sort?: FitbitActivitySort;
        limit?: number;
        offset?: number;
    } = {}): Promise<FitbitActivityList> {
        const params = new URLSearchParams();
        if (options.beforeDate) params.set("beforeDate", options.beforeDate);
        else if (options.afterDate) params.set("afterDate", options.afterDate);
        else params.set("beforeDate", new Date().toISOString().slice(0, 10));
        params.set("sort", options.sort ?? "desc");
        params.set("limit", String(Math.min(options.limit ?? 20, 100)));
        params.set("offset", String(options.offset ?? 0));
        return this.get(`/1/user/-/activities/list.json?${params}`);
    }

    // ── Calories ──────────────────────────────────────────────────────────────

    /** Calories burned time series. */
    async getCalories(date: string, period: FitbitPeriod | string = "1d"): Promise<FitbitTimeSeries> {
        const p = toFitbitPeriod(period as string);
        return this.get(`/1/user/-/activities/calories/date/${date}/${p}.json`);
    }

    /** Daily activity summary (includes calories, steps, distance, etc.). */
    async getDailyActivitySummary(date: string): Promise<Record<string, unknown>> {
        return this.get(`/1/user/-/activities.json?date=${date}`);
    }

    // ── Steps ─────────────────────────────────────────────────────────────────

    /** Steps time series. */
    async getSteps(date: string, period: FitbitPeriod | string = "1d"): Promise<FitbitTimeSeries> {
        const p = toFitbitPeriod(period as string);
        return this.get(`/1/user/-/activities/steps/date/${date}/${p}.json`);
    }

    // ── Body Metrics ──────────────────────────────────────────────────────────

    /** Weight logs/trends. */
    async getWeight(date: string, period: FitbitPeriod | string = "1d"): Promise<FitbitTimeSeries> {
        const p = toFitbitPeriod(period as string);
        return this.get(`/1/user/-/body/weight/date/${date}/${p}.json`);
    }

    /** Body fat percentage logs/trends. */
    async getBodyFat(date: string, period: FitbitPeriod | string = "1d"): Promise<FitbitTimeSeries> {
        const p = toFitbitPeriod(period as string);
        return this.get(`/1/user/-/body/fat/date/${date}/${p}.json`);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private async get<T>(path: string): Promise<T> {
        if (!this.accessToken) {
            await this.authenticate();
        }

        const response = await fetch(`${FITBIT_API_BASE}${path}`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
        });

        if (response.status === 401) {
            // Token expired; try refresh first, then full re-auth
            if (this.refreshToken) {
                await this.refreshAccessToken(this.refreshToken);
            } else {
                await this.authenticate();
            }
            const retry = await fetch(`${FITBIT_API_BASE}${path}`, {
                headers: { Authorization: `Bearer ${this.accessToken}` },
            });
            if (!retry.ok) throw new Error(`Fitbit API error: ${retry.status} ${await retry.text()}`);
            return retry.json() as Promise<T>;
        }

        if (!response.ok) {
            throw new Error(`Fitbit API error: ${response.status} ${await response.text()}`);
        }

        return response.json() as Promise<T>;
    }
}

// ─── Module-level singleton ───────────────────────────────────────────────────
export const fitbitService = new FitbitService();

/**
 * Normalize any date input to YYYY-MM-DD (Pacific Time).
 * Handles: already-correct YYYY-MM-DD, natural language like "today" / "yesterday",
 * locale-formatted strings like "May 9, 2026", and ISO timestamps.
 * Falls back to today if parsing fails.
 */
function toFitbitDate(input: string): string {
    const trimmed = input.trim();

    // Already YYYY-MM-DD — return as-is
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

    const todayPST = (): string =>
        new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Los_Angeles",
            year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date());

    const lower = trimmed.toLowerCase();
    if (lower === "today") return todayPST();
    if (lower === "yesterday") {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Los_Angeles",
            year: "numeric", month: "2-digit", day: "2-digit",
        }).format(d);
    }

    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: "America/Los_Angeles",
            year: "numeric", month: "2-digit", day: "2-digit",
        }).format(parsed);
    }

    // Fallback
    return todayPST();
}

export const fitbit_get_heart_rate_tool = tool(
    async ({ date, period }: { date: string, period?: FitbitPeriod }) => {
        return fitbitService.getHeartRate(toFitbitDate(date), period);
    },
    {
        name: "fitbit_get_heart_rate",
        description: "Get heart rate summary for a date, including resting heart rate and zones.",
        schema: z.object({
            date: z.string().describe("The date to get heart rate data for, in YYYY-MM-DD format"),
            period: z.enum(["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y", "max"]).optional().describe("The period to get heart rate data for. Valid values: '1d', '7d', '30d', '1w', '1m', '3m', '6m', '1y', 'max'. Defaults to '1d'.")
        })
    }
);

export const fitbit_get_sleep_tool = tool(
    async ({ date, period }: { date: string, period?: FitbitPeriod }) => {
        return fitbitService.getSleepRange(toFitbitDate(date), period ?? "1d");
    },
    {
        name: "fitbit_get_sleep",
        description: "Get sleep summary for a date, including duration, efficiency, and stages.",
        schema: z.object({
            date: z.string().describe("The date to get sleep data for, in YYYY-MM-DD format"),
            period: z.enum(["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y", "max"]).optional().describe("The period to get sleep data for. Valid values: '1d', '7d', '30d', '1w', '1m', '3m', '6m', '1y', 'max'. Defaults to '1d'.")
        })
    }
);

export const fitbit_get_weight_tool = tool(
    async ({ date, period }: { date: string, period?: FitbitPeriod }) => {
        return fitbitService.getWeight(toFitbitDate(date), period);
    },
    {
        name: "fitbit_get_weight",
        description: "Get weight logs for a date, including trends over a period.",
        schema: z.object({
            date: z.string().describe("The date to get weight data for, in YYYY-MM-DD format"),
            period: z.enum(["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y", "max"]).optional().describe("The period to get weight data for. Valid values: '1d', '7d', '30d', '1w', '1m', '3m', '6m', '1y', 'max'. Defaults to '1d'.")
        })
    }
);

export const fitbit_get_body_fat_tool = tool(
    async ({ date, period }: { date: string, period?: FitbitPeriod }) => {
        return fitbitService.getBodyFat(toFitbitDate(date), period);
    },
    {
        name: "fitbit_get_body_fat",
        description: "Get body fat percentage logs for a date, including trends over a period.",
        schema: z.object({
            date: z.string().describe("The date to get body fat data for, in YYYY-MM-DD format"),
            period: z.enum(["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y", "max"]).optional().describe("The period to get body fat data for. Valid values: '1d', '7d', '30d', '1w', '1m', '3m', '6m', '1y', 'max'. Defaults to '1d'.")
        })
    }
);

export const fitbit_get_calories_tool = tool(
    async ({ date, period }: { date: string, period?: FitbitPeriod }) => {
        return fitbitService.getCalories(toFitbitDate(date), period);
    },
    {
        name: "fitbit_get_calories",
        description: "Get calories burned per day as a time series. Use period '1d' for a single day or '7d', '30d', '1m', etc. for a range. Returns one entry per day with date and total calories burned.",
        schema: z.object({
            date: z.string().describe("The end date for the period, in YYYY-MM-DD format. Always call get_current_date first."),
            period: z.enum(["1d", "7d", "30d", "1w", "1m", "3m", "6m", "1y", "max"]).optional().describe("Period length. Valid values: '1d', '7d', '30d', '1w', '1m', '3m', '6m', '1y', 'max'. Defaults to '1d'. NOTE: values like '10d', '2w', etc. are NOT valid — choose the nearest valid period.")
        })
    }
);

export const fitbit_get_activities_tool = tool(
    async ({ beforeDate, afterDate, limit }: {
        beforeDate?: string;
        afterDate?: string;
        limit?: number;
    }) => {
        return fitbitService.getActivities({
            beforeDate: beforeDate ? toFitbitDate(beforeDate) : undefined,
            afterDate: afterDate ? toFitbitDate(afterDate) : undefined,
            limit,
        });
    },
    {
        name: "fitbit_get_activities",
        description: "Get activities for a date range, including runs, bikes, swims, and walks.",
        schema: z.object({
            beforeDate: z.string().optional().describe("Return activities before this date (YYYY-MM-DD). Defaults to today if neither beforeDate nor afterDate is provided."),
            afterDate: z.string().optional().describe("Return activities after this date (YYYY-MM-DD). Mutually exclusive with beforeDate."),
            limit: z.number().optional().describe("Max number of activities to return (1–100). Defaults to 20.")
        })
    }
);

export const fitbit_authenticate_tool = tool(
    async () => {
        const authUrl = await fitbitService.authenticate();
        if (authUrl) {
            // startOAuthFlow() fully awaits the browser callback AND token exchange before
            // returning, so by the time we reach here the tokens are already saved.
            return 'Fitbit authorization complete. Tokens have been saved — you can now call any Fitbit data tool.';
        }
        return 'Fitbit authentication successful. Valid tokens are already in place.';
    },
    {
        name: "fitbit_authenticate",
        description: "Authenticate with Fitbit. Call this if any Fitbit tool returns a 401 or authentication error. If a full OAuth flow is needed, the tool returns a URL the user must open in their browser.",
        schema: z.object({})
    }
);

export const getAllFitbitTools = () => ({
    tools: {
        [fitbit_authenticate_tool.name]: fitbit_authenticate_tool,
        [fitbit_get_heart_rate_tool.name]: fitbit_get_heart_rate_tool,
        [fitbit_get_sleep_tool.name]: fitbit_get_sleep_tool,
        [fitbit_get_weight_tool.name]: fitbit_get_weight_tool,
        [fitbit_get_body_fat_tool.name]: fitbit_get_body_fat_tool,
        [fitbit_get_calories_tool.name]: fitbit_get_calories_tool,
        [fitbit_get_activities_tool.name]: fitbit_get_activities_tool,
    },
    requiredEnvVars: ["FITBIT_CLIENT_ID", "FITBIT_CLIENT_SECRET"],
});
