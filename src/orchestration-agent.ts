import pLimit from "p-limit";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { LocalEmbeddings, cosineSimilarity } from "./service/embedding-service.js";
import { type StructuredToolInterface } from "@langchain/core/tools";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import * as z from "zod";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, START, END } from "@langchain/langgraph";
import {
  StateSchema,
  MessagesValue,
  ReducedValue,
  GraphNode,
} from "@langchain/langgraph";
import { systemMessageContent } from "./util/system-message";
import { toolsByName } from "./tool-registerer";

const MessagesState = new StateSchema({
  messages: MessagesValue,
  llmCalls: new ReducedValue(
    z.number().default(0),
    { reducer: (x, y) => x + y }
  ),
});

function createModel() {
  if (process.env.ANTHROPIC_API_KEY) {
    return new ChatAnthropic({
      model: "claude-sonnet-4-6",
      temperature: 0,
    });
  }
  if (process.env.LOCAL_LLM_MODEL && process.env.LOCAL_LLM_URL) {
    return new ChatOpenAI({
      model: process.env.LOCAL_LLM_MODEL,
      temperature: 0,
      configuration: {
        baseURL: process.env.LOCAL_LLM_URL,
      },
    });
  }
  throw new Error(
    "No LLM configured: set ANTHROPIC_API_KEY, or both LOCAL_LLM_MODEL and LOCAL_LLM_URL."
  );
}

const model = createModel();

// Augment the LLM with tools
const isKnownToolName = (name: string): name is keyof typeof toolsByName => name in toolsByName;

// Per-service concurrency limiters for rate-limited external APIs.
// Rate limit context:
//   Fitbit:     undocumented; enforced via fitbit-rate-limit-* headers → conservative limit of 1
//   Withings:   120 req/min → limit of 2 is well within budget
//   Todoist:    100 req/min per token → limit of 2 is well within budget
//   Perplexity: plan-dependent, not publicly fixed → conservative limit of 1
const serviceLimiters: Record<string, ReturnType<typeof pLimit>> = {
  fitbit: pLimit(1),
  withings: pLimit(2),
  todoist: pLimit(2),
  perplexity: pLimit(1),
};

function getLimiterForTool(toolName: string): ReturnType<typeof pLimit> | null {
  for (const [prefix, limiter] of Object.entries(serviceLimiters)) {
    if (toolName === prefix || toolName.startsWith(prefix + "_")) {
      return limiter;
    }
  }
  return null; // local / compute tools run without a limiter
}

const tools = Object.values(toolsByName);

// When using a local LLM, small context windows can't fit all tool schemas.
// Set LOCAL_LLM_TOOLS to a comma-separated list of tool names to whitelist
// (e.g. "get_current_date,perplexity_web_search"). Unrecognized names are ignored.
// Anthropic always gets the full tool list.
const activeTools: StructuredToolInterface[] =
  !(model instanceof ChatAnthropic) && process.env.LOCAL_LLM_TOOLS
    ? tools.filter(t =>
      new Set(process.env.LOCAL_LLM_TOOLS!.split(',').map(s => s.trim())).has(t.name)
    )
    : tools;

// ─── Semantic tool selection (local LLM only) ────────────────────────────────
const TOOL_SELECTION_TOP_K = Math.max(1, parseInt(process.env.LOCAL_LLM_TOOL_TOP_K ?? '5', 10));

type ToolSelectionState = {
  embedder: { embedQuery: (text: string) => Promise<number[]> };
  items: Array<{ tool: StructuredToolInterface; embedding: number[] }>;
} | null;

async function precomputeToolEmbeddings(): Promise<ToolSelectionState> {
  if (model instanceof ChatAnthropic) return null;
  if (!process.env.LOCAL_EMBEDDING_MODEL) return null;
  try {
    const embedder = new LocalEmbeddings();
    const texts = activeTools.map(t => `${t.name}: ${t.description ?? ''}`);
    const vecs = await embedder.embedDocuments(texts);
    console.log(`[tool-selection] Pre-computed embeddings for ${activeTools.length} tools.`);
    return { embedder, items: activeTools.map((tool, i) => ({ tool, embedding: vecs[i] })) };
  } catch (err) {
    console.warn('[tool-selection] Embedding pre-computation failed, using full tool list.', err);
    return null;
  }
}

const toolSelectionReady = precomputeToolEmbeddings();

async function selectToolsForQuery(query: string): Promise<StructuredToolInterface[]> {
  const sel = await toolSelectionReady;
  if (!sel) return activeTools;
  const qVec = await sel.embedder.embedQuery(query);
  return sel.items
    .map(({ tool, embedding }) => ({ tool, score: cosineSimilarity(qVec, embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOOL_SELECTION_TOP_K)
    .map(s => s.tool);
}

// For Anthropic: use input_schema format with prompt caching on the last tool.
// For OpenAI-compatible (local LLM): binding is done dynamically per call in
// llmNode using selectToolsForQuery, so this is only used for Anthropic.
const modelWithTools = model instanceof ChatAnthropic
  ? model.bindTools(
    activeTools.map((tool, i) => {
      const oai = convertToOpenAITool(tool);
      return {
        name: oai.function.name,
        description: oai.function.description ?? "",
        input_schema: (oai.function.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
        ...(i === activeTools.length - 1 ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}),
      };
    })
  )
  : model.bindTools(activeTools);

type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

const extractPseudoToolCalls = (content: unknown): ParsedToolCall[] => {
  if (typeof content !== "string") {
    return [];
  }

  const blocks = content.match(/<tool_call>[\s\S]*?<\/tool_call>/g) ?? [];
  const parsed: ParsedToolCall[] = [];

  for (const block of blocks) {
    const functionMatch = block.match(/<function=([^>]+)>/);
    if (!functionMatch) {
      continue;
    }

    const name = functionMatch[1].trim();
    const args: Record<string, unknown> = {};
    const parameterRegex = /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g;

    for (const parameterMatch of block.matchAll(parameterRegex)) {
      const key = parameterMatch[1].trim();
      const value = parameterMatch[2].trim();
      args[key] = value;
    }

    parsed.push({ name, args });
  }

  return parsed;
};

const getTodayPST = (): string =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });

const TOOL_RESULT_TRIM_CHARS = 300;

const llmNode: GraphNode<typeof MessagesState> = async (state) => {
  // Trim large tool results that have already been processed to save input tokens.
  // Keep the last 3 messages untrimmed so the model has full context on recent results.
  const trimmedMessages = state.messages.map((m, i) => {
    if (
      ToolMessage.isInstance(m) &&
      i < state.messages.length - 3 &&
      typeof m.content === "string" &&
      m.content.length > TOOL_RESULT_TRIM_CHARS
    ) {
      return new ToolMessage({
        ...m,
        content: m.content.slice(0, TOOL_RESULT_TRIM_CHARS) + "…[trimmed]",
      });
    }
    return m;
  });

  // Anthropic supports prompt caching on the system message; for local LLMs
  // (OpenAI-compatible) use a plain string to avoid unsupported field errors.
  const systemMessage = model instanceof ChatAnthropic
    ? new SystemMessage({
      content: [
        {
          type: "text",
          text: systemMessageContent(getTodayPST()),
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
    })
    : new SystemMessage(systemMessageContent(getTodayPST()));

  // For local LLMs, dynamically narrow to the top-K semantically relevant
  // tools for this query so we stay within the model's context window.
  let modelForCall = modelWithTools;
  if (!(model instanceof ChatAnthropic)) {
    const lastUserMsg = [...state.messages].reverse().find(m => HumanMessage.isInstance(m));
    const queryText = typeof lastUserMsg?.content === 'string'
      ? lastUserMsg.content
      : Array.isArray(lastUserMsg?.content)
        ? (lastUserMsg.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === 'text').map(c => c.text ?? '').join(' ')
        : '';
    const selectedTools = await selectToolsForQuery(queryText);
    console.log(`[tool-selection] ${selectedTools.length} tools selected: ${selectedTools.map(t => t.name).join(', ')}`);
    modelForCall = model.bindTools(selectedTools);
  }

  const response = await modelForCall.invoke([
    systemMessage,
    ...trimmedMessages,
  ]);
  return {
    messages: [response],
    llmCalls: 1,
  };
};

// Tool Node
const toolNode: GraphNode<typeof MessagesState> = async (state) => {
  const lastMessage = state.messages.at(-1);

  if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
    return { messages: [] };
  }

  const structuredToolCalls = lastMessage.tool_calls ?? [];
  const parsedPseudoToolCalls =
    structuredToolCalls.length === 0 ? extractPseudoToolCalls(lastMessage.content) : [];

  const normalizedToolCalls =
    structuredToolCalls.length > 0
      ? structuredToolCalls.map((toolCall) => ({
        type: "tool_call" as const,
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
      }))
      : parsedPseudoToolCalls.map((toolCall, index) => ({
        type: "tool_call" as const,
        id: `pseudo_${Date.now()}_${index}`,
        name: toolCall.name,
        args: toolCall.args,
      }));

  const settled = await Promise.allSettled(
    normalizedToolCalls.map(async (toolCall) => {
      if (!isKnownToolName(toolCall.name)) {
        return new ToolMessage({
          content: `Unknown tool: ${toolCall.name}`,
          tool_call_id: toolCall.id ?? `unknown_${Date.now()}`,
          name: toolCall.name,
          status: "error",
        });
      }

      console.log(`[tool-call] ${toolCall.name}`);

      const tool = toolsByName[toolCall.name];
      const limiter = getLimiterForTool(toolCall.name);
      const observation = limiter
        ? await limiter(() => tool.invoke(toolCall))
        : await tool.invoke(toolCall);

      const content =
        typeof observation.content === "string"
          ? observation.content
          : JSON.stringify(observation.content);

      return new ToolMessage({
        content,
        artifact: observation.artifact,
        metadata: observation.metadata,
        name: observation.name,
        status: observation.status,
        tool_call_id: observation.tool_call_id,
      });
    })
  );

  const result: ToolMessage[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const toolCall = normalizedToolCalls[i];
    return new ToolMessage({
      content: `Tool error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
      tool_call_id: toolCall.id ?? `error_${Date.now()}`,
      name: toolCall.name,
      status: "error",
    });
  });

  return { messages: result };
};

const MAX_LLM_CALLS = 25;

const shouldContinue = (state: typeof MessagesState.State): "toolNode" | typeof END => {
  const lastMessage = state.messages.at(-1);

  // Check if it's an AIMessage before accessing tool_calls
  if (!lastMessage || !AIMessage.isInstance(lastMessage)) {
    return END;
  }

  // Guard against infinite loops
  if (state.llmCalls >= MAX_LLM_CALLS) {
    console.warn(`[shouldContinue] Reached max LLM calls (${MAX_LLM_CALLS}), stopping.`);
    return END;
  }

  // If the LLM makes a tool call, then perform an action
  if ((lastMessage.tool_calls?.length ?? 0) > 0) {
    return "toolNode";
  }

  if (extractPseudoToolCalls(lastMessage.content).length > 0) {
    return "toolNode";
  }

  // Otherwise, we stop (reply to the user)
  return END;
};

export const agent = new StateGraph(MessagesState)
  .addNode("llmCall", llmNode)
  .addNode("toolNode", toolNode)
  .addEdge(START, "llmCall")
  .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
  .addEdge("toolNode", "llmCall")
  .compile();

export type ChatCallbacks = {
  onLog?: (level: string, message: string) => void;
  onToolUse?: (toolName: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, output: string) => void;
};

export async function chat(
  messages: import("@langchain/core/messages").BaseMessage[],
  callbacks: ChatCallbacks = {}
): Promise<string> {
  const { onLog, onToolUse, onToolResult } = callbacks;

  const stream = agent.streamEvents(
    { messages },
    { version: "v2" }
  );

  let finalContent = "";

  for await (const event of stream) {
    if (event.event === "on_tool_start") {
      const name: string = event.name ?? "";
      const args = (event.data?.input ?? {}) as Record<string, unknown>;
      onLog?.("tool", `Calling tool: ${name}`);
      onToolUse?.(name, args);
    } else if (event.event === "on_tool_end") {
      const name: string = event.name ?? "";
      const rawOutput = event.data?.output;
      // event.data.output may be a raw string or a ToolMessage-like object;
      // prefer .content so we get the tool's return value, not the serialized wrapper
      const output = typeof rawOutput === "string"
        ? rawOutput
        : typeof rawOutput?.content === "string"
          ? rawOutput.content
          : JSON.stringify(rawOutput ?? "");
      onToolResult?.(name, output);
    } else if (event.event === "on_chain_end" && event.name === "LangGraph") {
      // Final graph output — extract last AI message
      const outputMessages = event.data?.output?.messages as
        | import("@langchain/core/messages").BaseMessage[]
        | undefined;
      if (outputMessages) {
        const lastAI = [...outputMessages].reverse().find((m) => AIMessage.isInstance(m));
        if (lastAI) {
          const content = lastAI.content;
          if (typeof content === "string") {
            finalContent = content;
          } else if (Array.isArray(content)) {
            finalContent = content
              .filter((c): c is { type: string; text: string } =>
                typeof c === "object" && c !== null && "type" in c &&
                (c as { type: string }).type === "text"
              )
              .map((c) => c.text)
              .join("");
          }
        }
      }
    }
  }

  return finalContent;
}

const main = async () => {
  // One-shot example invocation
  const result = await agent.invoke({
    messages: [
      new HumanMessage("Who did the oilers play today, and what tasks do I have due tomorrow? Use the tools if you need, you are a tool using agent"),
    ],
  });

  for (const message of result.messages) {
    if (message.type === "tool") {
      continue;
    }
    console.log(`[${message.type}]: ${JSON.stringify(message.content, null, 2)}`);
  }
};

if (require.main === module) {
  main();
}