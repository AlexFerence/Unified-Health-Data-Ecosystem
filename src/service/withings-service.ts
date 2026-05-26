import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { StructuredToolInterface, tool } from '@langchain/core/tools';
import * as z from 'zod';

const WITHINGS_AUTH_URI = 'https://account.withings.com/oauth2_user/authorize2';
const WITHINGS_TOKEN_URI = `${process.env.WITHINGS_API_ENDPOINT ?? 'https://wbsapi.withings.net'}/v2/oauth2`;
const WITHINGS_API_BASE = process.env.WITHINGS_API_ENDPOINT ?? 'https://wbsapi.withings.net';
const REDIRECT_URI = 'http://localhost:8766/callback';
const CACHE_DIR = path.join(process.cwd(), 'cache');
const TOKEN_FILE = path.join(CACHE_DIR, 'withings-tokens.json');

// Measure type codes relevant to body composition
const BODY_COMP_MEASTYPES = '5,6,8,76,77,88';  // fat-free mass, fat%, fat mass, muscle, hydration, bone
const WEIGHT_MEASTYPE = '1';

// ─── Token storage ─────────────────────────────────────────────────────────────

interface WithingsTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number; // epoch ms
    userid: string;
}

// ─── Response shape interfaces ─────────────────────────────────────────────────

interface WithingsMeasure {
    value: number;
    type: number;
    unit: number;
}

interface WithingsMeasureGroup {
    grpid: number;
    date: number;
    measures: WithingsMeasure[];
}

interface WithingsMeasureResponse {
    measuregrps: WithingsMeasureGroup[];
    more: number;
    offset: number;
}

export interface WithingsBodyComposition {
    date: string;                    // ISO date string
    weightKg?: number;
    fatRatioPercent?: number;
    fatMassKg?: number;
    fatFreeMassKg?: number;
    muscleMassKg?: number;
    boneMassKg?: number;
    hydrationKg?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Scale a raw Withings value by its unit exponent. */
function scaleValue(value: number, unit: number): number {
    return value * Math.pow(10, unit);
}

/** Convert a YYYY-MM-DD date string to a Unix timestamp (start of day UTC). */
function dateToEpoch(date: string): number {
    return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

/** Convert a Unix timestamp to a YYYY-MM-DD string. */
function epochToDate(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(0, 10);
}

// Meastype code → field name mapping
const MEASTYPE_MAP: Record<number, keyof WithingsBodyComposition> = {
    1: 'weightKg',
    5: 'fatFreeMassKg',
    6: 'fatRatioPercent',
    8: 'fatMassKg',
    76: 'muscleMassKg',
    77: 'hydrationKg',
    88: 'boneMassKg',
};

/** Group raw measure groups into per-date body composition records. */
function parseMeasureGroups(groups: WithingsMeasureGroup[]): WithingsBodyComposition[] {
    const byDate: Record<string, WithingsBodyComposition> = {};

    for (const grp of groups) {
        const date = epochToDate(grp.date);
        if (!byDate[date]) byDate[date] = { date };

        for (const m of grp.measures) {
            const field = MEASTYPE_MAP[m.type];
            if (field) {
                byDate[date][field] = scaleValue(m.value, m.unit) as never;
            }
        }
    }

    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Service ───────────────────────────────────────────────────────────────────

export class WithingsService {
    private accessToken: string | null = null;
    private refreshToken: string | null = null;
    private readonly clientId: string;
    private readonly clientSecret: string;

    constructor(
        clientId: string = process.env.WITHINGS_CLIENT_ID ?? '',
        clientSecret: string = process.env.WITHINGS_CLIENT_SECRET ?? ''
    ) {
        if (!clientId || !clientSecret) {
            throw new Error('WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET must be set.');
        }
        this.clientId = clientId;
        this.clientSecret = clientSecret;
    }

    // ── Auth ───────────────────────────────────────────────────────────────────

    getAuthorizationUrl(): string {
        const state = crypto.randomBytes(16).toString('hex');
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.clientId,
            scope: 'user.info,user.metrics',
            redirect_uri: REDIRECT_URI,
            state,
        });
        return `${WITHINGS_AUTH_URI}?${params}`;
    }

    async startOAuthFlow(): Promise<string> {
        const authUrl = this.getAuthorizationUrl();

        console.log('\nOpen this URL in your browser to authorize Withings:\n');
        console.log(authUrl);
        console.log('\nWaiting for authorization on http://localhost:8766/callback ...');

        exec(`open "${authUrl}"`);

        const code = await new Promise<string>((resolve, reject) => {
            const server = http.createServer((req, res) => {
                if (!req.url) return;
                const url = new URL(req.url, 'http://localhost:8766');
                if (url.pathname !== '/callback') return;

                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end('<h1>Authorization failed</h1><p>You can close this tab.</p>');
                    server.close();
                    reject(new Error(`Withings authorization denied: ${error}`));
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

            server.listen(8766, '127.0.0.1');
            server.on('error', reject);
        });

        await this.exchangeCode(code);
        console.log('Withings authorization complete. Tokens saved.');
        return authUrl;
    }

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
        const body = new URLSearchParams({
            action: 'requesttoken',
            grant_type: 'authorization_code',
            client_id: this.clientId,
            client_secret: this.clientSecret,
            code,
            redirect_uri: REDIRECT_URI,
        });

        const response = await fetch(WITHINGS_TOKEN_URI, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });

        if (!response.ok) {
            throw new Error(`Withings token exchange failed: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { status: number; body: { access_token: string; refresh_token: string; expires_in: number; userid: string } };
        if (data.status !== 0) throw new Error(`Withings token exchange error: status ${data.status}`);

        this.accessToken = data.body.access_token;
        this.refreshToken = data.body.refresh_token;
        this.saveTokens({
            access_token: data.body.access_token,
            refresh_token: data.body.refresh_token,
            expires_at: Date.now() + data.body.expires_in * 1000,
            userid: data.body.userid,
        });
    }

    private async refreshAccessToken(refreshToken: string): Promise<void> {
        const body = new URLSearchParams({
            action: 'requesttoken',
            grant_type: 'refresh_token',
            client_id: this.clientId,
            client_secret: this.clientSecret,
            refresh_token: refreshToken,
        });

        const response = await fetch(WITHINGS_TOKEN_URI, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });

        if (!response.ok) {
            throw new Error(`Withings token refresh failed: ${response.status} ${await response.text()}`);
        }

        const data = await response.json() as { status: number; body: { access_token: string; refresh_token: string; expires_in: number; userid: string } };
        if (data.status !== 0) throw new Error(`Withings token refresh error: status ${data.status}`);

        this.accessToken = data.body.access_token;
        this.refreshToken = data.body.refresh_token;
        this.saveTokens({
            access_token: data.body.access_token,
            refresh_token: data.body.refresh_token,
            expires_at: Date.now() + data.body.expires_in * 1000,
            userid: data.body.userid,
        });
    }

    private saveTokens(tokens: WithingsTokens): void {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), 'utf-8');
    }

    private loadTokens(): WithingsTokens | null {
        try {
            const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
            return JSON.parse(raw) as WithingsTokens;
        } catch {
            return null;
        }
    }

    // ── Body Composition ───────────────────────────────────────────────────────

    /**
     * Retrieve body composition metrics (fat%, fat mass, fat-free mass, muscle mass,
     * bone mass, hydration) for a date range.
     */
    async getBodyComposition(startDate: string, endDate: string): Promise<WithingsBodyComposition[]> {
        const groups = await this.getMeasureGroups(BODY_COMP_MEASTYPES, startDate, endDate);
        return parseMeasureGroups(groups);
    }

    /**
     * Retrieve weight measurements for a date range.
     */
    async getWeight(startDate: string, endDate: string): Promise<WithingsBodyComposition[]> {
        const groups = await this.getMeasureGroups(WEIGHT_MEASTYPE, startDate, endDate);
        return parseMeasureGroups(groups);
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    private async getMeasureGroups(
        meastypes: string,
        startDate: string,
        endDate: string
    ): Promise<WithingsMeasureGroup[]> {
        if (!this.accessToken) await this.authenticate();

        const allGroups: WithingsMeasureGroup[] = [];
        let offset = 0;

        do {
            const body = new URLSearchParams({
                action: 'getmeas',
                meastypes,
                category: '1',
                startdate: String(dateToEpoch(startDate)),
                enddate: String(dateToEpoch(endDate) + 86400), // include full end day
                offset: String(offset),
            });

            const response = await fetch(`${WITHINGS_API_BASE}/measure`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body,
            });

            if (response.status === 401) {
                if (this.refreshToken) await this.refreshAccessToken(this.refreshToken);
                else await this.authenticate();
                // Retry once after re-auth
                const retry = await fetch(`${WITHINGS_API_BASE}/measure`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body,
                });
                if (!retry.ok) throw new Error(`Withings API error: ${retry.status} ${await retry.text()}`);
                const retryData = await retry.json() as { status: number; body: WithingsMeasureResponse };
                if (retryData.status !== 0) throw new Error(`Withings API error: status ${retryData.status}`);
                allGroups.push(...retryData.body.measuregrps);
                break;
            }

            if (!response.ok) throw new Error(`Withings API error: ${response.status} ${await response.text()}`);

            const data = await response.json() as { status: number; body: WithingsMeasureResponse };
            if (data.status !== 0) throw new Error(`Withings API error: status ${data.status}`);

            allGroups.push(...data.body.measuregrps);
            offset = data.body.more ? data.body.offset : 0;
        } while (offset > 0);

        return allGroups;
    }
}

// ─── Module-level singleton ────────────────────────────────────────────────────

export const withingsService = new WithingsService();

// ─── Tools ────────────────────────────────────────────────────────────────────

export const withings_authenticate_tool = tool(
    async () => {
        const authUrl = await withingsService.authenticate();
        if (authUrl) {
            return 'Withings authorization complete. Tokens have been saved — you can now call any Withings data tool.';
        }
        return 'Withings authentication successful. Valid tokens are already in place.';
    },
    {
        name: 'withings_authenticate',
        description: 'Authenticate with Withings. Call this if any Withings tool returns a 401 or authentication error. If a full OAuth flow is needed, the tool opens a browser for the user to authorize.',
        schema: z.object({}),
    }
);

export const withings_get_body_composition_tool = tool(
    async ({ startDate, endDate }: { startDate: string; endDate: string }) => {
        return withingsService.getBodyComposition(startDate, endDate);
    },
    {
        name: 'withings_get_body_composition',
        description: 'Get body composition measurements from Withings for a date range. Returns fat percentage, fat mass (kg), fat-free mass (kg), muscle mass (kg), bone mass (kg), and hydration (kg) per measurement date.',
        schema: z.object({
            startDate: z.string().describe('Start date in YYYY-MM-DD format'),
            endDate: z.string().describe('End date in YYYY-MM-DD format'),
        }),
    }
);

export const withings_get_weight_tool = tool(
    async ({ startDate, endDate }: { startDate: string; endDate: string }) => {
        return withingsService.getWeight(startDate, endDate);
    },
    {
        name: 'withings_get_weight',
        description: 'Get weight measurements (in kg) from Withings for a date range.',
        schema: z.object({
            startDate: z.string().describe('Start date in YYYY-MM-DD format'),
            endDate: z.string().describe('End date in YYYY-MM-DD format'),
        }),
    }
);

export const getAllWithingsTools = () => ({
    tools: {
        [withings_authenticate_tool.name]: withings_authenticate_tool,
        [withings_get_body_composition_tool.name]: withings_get_body_composition_tool,
        [withings_get_weight_tool.name]: withings_get_weight_tool,
    },
    requiredEnvVars: ["WITHINGS_CLIENT_ID", "WITHINGS_CLIENT_SECRET"],
});
