import { tool } from '@langchain/core/tools';
import Perplexity from '@perplexity-ai/perplexity_ai';
import * as z from "zod";

export interface PerplexitySearchOptions {
    country?: string | null;
    lastUpdatedAfter?: string | null;
    lastUpdatedBefore?: string | null;
    maxResults?: number;
}

export interface PerplexitySearchResult {
    snippet: string;
    title: string;
    url: string;
    date?: string | null;
    last_updated?: string | null;
}

export interface PerplexitySearchResponse {
    id: string;
    results: PerplexitySearchResult[];
    server_time?: string | null;
}

export class PerplexityService {
    private readonly client: Perplexity;

    constructor(apiKey: string = process.env.PERPLEXITY_API_KEY ?? '') {
        if (!apiKey) {
            throw new Error('PERPLEXITY_API_KEY is not set.');
        }

        this.client = new Perplexity({ apiKey });
    }

    async search(query: string, options: PerplexitySearchOptions = {
        country: "CA",
        maxResults: 5
    }): Promise<PerplexitySearchResponse> {
        const normalizedQuery = query.trim();

        if (!normalizedQuery) {
            throw new Error('Query must not be empty.');
        }

        return this.createSearch(normalizedQuery, options);
    }

    async searchMany(queries: string[], options: PerplexitySearchOptions = {
        country: "CA",
        maxResults: 5
    }): Promise<PerplexitySearchResponse> {
        const normalizedQueries = queries.map((query) => query.trim()).filter(Boolean);

        if (normalizedQueries.length === 0) {
            throw new Error('At least one query is required.');
        }

        return this.createSearch(normalizedQueries, options);
    }

    private async createSearch(
        query: string | string[],
        options: PerplexitySearchOptions
    ): Promise<PerplexitySearchResponse> {
        return this.client.search.create({
            query,
            max_results: options.maxResults
        });
    }
}

export const perplexity_web_search_tool = tool(
    async ({ query }) => {
        const response = await new PerplexityService().search(query);
        return JSON.stringify(response.results);
    },
    {
        name: "perplexity_web_search",
        description: "Perform a web search using the Perplexity API",
        schema: z.object({
            query: z.string().describe("The search query")
        })
    }
);

export const getAllPerplexityTools = () => ({
    tools: {
        [perplexity_web_search_tool.name]: perplexity_web_search_tool,
    },
    requiredEnvVars: ["PERPLEXITY_API_KEY"],
});
