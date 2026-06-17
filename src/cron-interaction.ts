
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { type StructuredToolInterface } from "@langchain/core/tools";
import * as z from "zod";
import { add, multiply, divide, getCurrentDate } from "./service/general-tools";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { StateGraph, START, END, StateSchema, MessagesValue, ReducedValue, GraphNode } from "@langchain/langgraph";
import { getAllPerplexityTools } from "./service/perplexity-service";
import { TodoistService, TodoistTask, todoist_create_task_tool, todoist_get_tasks_for_date_tool, todoist_update_task_tool } from "./service/todoist-service";
import { getAllFitbitTools } from "./service/fitbit-service";
import { getAllWithingsTools } from "./service/withings-service";
import { create_line_chart_tool } from "./service/chart-tool";
import { getAllMealTools } from "./service/meal-service";
import { cronSystemMessageContent } from "./util/system-message";

const PROCESSED_LABEL = "processed";

const MessagesState = new StateSchema({
  messages: MessagesValue,
  llmCalls: new ReducedValue(
    z.number().default(0),
    { reducer: (x: number, y: number) => x + y }
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

const toolsByName: Record<string, StructuredToolInterface> = {
  [add.name]: add,
  [multiply.name]: multiply,
  [divide.name]: divide,
  [getCurrentDate.name]: getCurrentDate,
  ...getAllPerplexityTools().tools,
  [todoist_create_task_tool.name]: todoist_create_task_tool,
  [todoist_get_tasks_for_date_tool.name]: todoist_get_tasks_for_date_tool,
  [todoist_update_task_tool.name]: todoist_update_task_tool,
  ...getAllFitbitTools().tools,
  ...getAllWithingsTools().tools,
  [create_line_chart_tool.name]: create_line_chart_tool,
  ...getAllMealTools().tools,
};

const isKnownToolName = (name: string): name is keyof typeof toolsByName => name in toolsByName;

const tools = Object.values(toolsByName);
const modelWithTools = model.bindTools(tools);

type ParsedToolCall = {
  name: string;
  args: Record<string, unknown>;
};

const extractPseudoToolCalls = (content: unknown): ParsedToolCall[] => {
  if (typeof content !== "string") return [];

  const blocks = content.match(/<tool_call>[\s\S]*?<\/tool_call>/g) ?? [];
  const parsed: ParsedToolCall[] = [];

  for (const block of blocks) {
    const functionMatch = block.match(/<function=([^>]+)>/);
    if (!functionMatch) continue;

    const name = functionMatch[1].trim();
    const args: Record<string, unknown> = {};
    const parameterRegex = /<parameter=([^>]+)>\s*([\s\S]*?)\s*<\/parameter>/g;

    for (const parameterMatch of block.matchAll(parameterRegex)) {
      args[parameterMatch[1].trim()] = parameterMatch[2].trim();
    }

    parsed.push({ name, args });
  }

  return parsed;
};

const getTodayPST = (): string =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });

const llmNode: GraphNode<typeof MessagesState> = async (state) => {
  const cronSystemMessage = new SystemMessage(cronSystemMessageContent(getTodayPST()));
  const response = await modelWithTools.invoke([cronSystemMessage, ...state.messages]);
  return { messages: [response], llmCalls: 1 };
};

const toolNode: GraphNode<typeof MessagesState> = async (state) => {
  const lastMessage = state.messages.at(-1);
  if (lastMessage == null || !AIMessage.isInstance(lastMessage)) return { messages: [] };

  const structuredToolCalls = lastMessage.tool_calls ?? [];
  const parsedPseudoToolCalls =
    structuredToolCalls.length === 0 ? extractPseudoToolCalls(lastMessage.content) : [];

  const normalizedToolCalls =
    structuredToolCalls.length > 0
      ? structuredToolCalls.map((tc) => ({ type: "tool_call" as const, id: tc.id, name: tc.name, args: tc.args }))
      : parsedPseudoToolCalls.map((tc, i) => ({ type: "tool_call" as const, id: `pseudo_${Date.now()}_${i}`, name: tc.name, args: tc.args }));

  const result: ToolMessage[] = [];
  for (const toolCall of normalizedToolCalls) {
    if (!isKnownToolName(toolCall.name)) {
      result.push(new ToolMessage({
        content: `Unknown tool: ${toolCall.name}`,
        tool_call_id: toolCall.id ?? `unknown_${Date.now()}`,
        name: toolCall.name,
        status: "error",
      }));
      continue;
    }

    console.log(`  [tool] ${toolCall.name}`);
    const toolInstance = toolsByName[toolCall.name];
    const observation = await toolInstance.invoke(toolCall);
    const content =
      typeof observation.content === "string"
        ? observation.content
        : JSON.stringify(observation.content);

    result.push(new ToolMessage({
      content,
      artifact: observation.artifact,
      metadata: observation.metadata,
      name: observation.name,
      status: observation.status,
      tool_call_id: observation.tool_call_id,
    }));
  }

  return { messages: result };
};

const MAX_LLM_CALLS = 25;

const shouldContinue = (state: typeof MessagesState.State): "toolNode" | typeof END => {
  const lastMessage = state.messages.at(-1);
  if (!lastMessage || !AIMessage.isInstance(lastMessage)) return END;
  if (state.llmCalls >= MAX_LLM_CALLS) {
    console.warn(`[cron] Reached max LLM calls (${MAX_LLM_CALLS}), stopping.`);
    return END;
  }
  if ((lastMessage.tool_calls?.length ?? 0) > 0) return "toolNode";
  if (extractPseudoToolCalls(lastMessage.content).length > 0) return "toolNode";
  return END;
};

const cronAgent = new StateGraph(MessagesState)
  .addNode("llmCall", llmNode)
  .addNode("toolNode", toolNode)
  .addEdge(START, "llmCall")
  .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
  .addEdge("toolNode", "llmCall")
  .compile();

const todoistService = new TodoistService();

export async function processTask(task: TodoistTask): Promise<void> {
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  console.log(`[${timestamp}] Processing task "${task.content}" (id: ${task.id})`);

  try {
    await cronAgent.invoke({
      messages: [
        new HumanMessage(
          `Process this task (ID: ${task.id}): ${task.content}` +
          (task.description ? `\n\nAdditional context: ${task.description}` : "")
        ),
      ],
    });
  } catch (err) {
    console.error(`[cron] Error processing task ${task.id}:`, err);
    // Best-effort: update task description with error details
    try {
      await todoistService.updateTask(task.id, {
        description: `[Error] Failed to process task: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      // Ignore secondary failure
    }
  } finally {
    // Always mark as processed so it isn't retried on next cron run
    const updatedLabels = task.labels.includes(PROCESSED_LABEL)
      ? task.labels
      : [...task.labels, PROCESSED_LABEL];
    await todoistService.updateTask(task.id, { labels: updatedLabels });
    console.log(`[${timestamp}] Marked task ${task.id} as "${PROCESSED_LABEL}"`);
  }
}
