import * as http from "http";
import * as path from "path";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { HumanMessage, AIMessage, type BaseMessage } from "@langchain/core/messages";
import { chat } from "./orchestration-agent";

const PORT = 3000;

const app = express();

// Serve the frontend/ folder as static files (two levels up from build/src/)
app.use(express.static(path.join(__dirname, "../../frontend")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Per-connection conversation history (excludes system message — chat() prepends it)
const histories = new Map<WebSocket, BaseMessage[]>();

function safeSend(ws: WebSocket, payload: object): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

wss.on("connection", (ws) => {
    histories.set(ws, []);
    safeSend(ws, { type: "log", level: "success", message: "Agent ready" });

    ws.on("message", async (raw) => {
        let parsed: { type: string; message?: string };
        try {
            parsed = JSON.parse(raw.toString());
        } catch {
            safeSend(ws, { type: "error", message: "Invalid JSON" });
            return;
        }

        if (parsed.type !== "chat" || !parsed.message?.trim()) return;

        const userText = parsed.message.trim();
        const history = histories.get(ws) ?? [];

        safeSend(ws, { type: "log", level: "info", message: `User: ${userText}` });
        safeSend(ws, { type: "agent_thinking" });

        history.push(new HumanMessage(userText));

        let responseText = "";
        try {
            responseText = await chat(history, {
                onLog: (level, message) => safeSend(ws, { type: "log", level, message }),
                onToolUse: (toolName, args) =>
                    safeSend(ws, { type: "tool_use", tool: toolName, args }),
                onToolResult: (toolName, output) => {
                    // Forward chart data immediately when detected in a tool result
                    if (output.includes("chartData")) {
                        try {
                            // Find the JSON object containing chartData
                            const match = output.match(/\{[\s\S]*"chartData"[\s\S]*\}/);
                            if (match) {
                                const parsed = JSON.parse(match[0]) as { chartData: unknown };
                                safeSend(ws, { type: "chart", data: parsed.chartData });
                            }
                        } catch {
                            // Not valid JSON — ignore
                        }
                    }
                    safeSend(ws, {
                        type: "log",
                        level: "info",
                        message: `Tool result [${toolName}]: ${output.slice(0, 200)}${output.length > 200 ? "…" : ""}`,
                    });
                },
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            safeSend(ws, { type: "error", message: `Agent error: ${msg}` });
            return;
        }

        // Fallback: scan the response text for embedded {"chartData": ...} JSON
        if (responseText.includes("chartData")) {
            try {
                const match = responseText.match(/\{[\s\S]*"chartData"[\s\S]*\}/);
                if (match) {
                    const embeddedChart = JSON.parse(match[0]) as { chartData: unknown };
                    safeSend(ws, { type: "chart", data: embeddedChart.chartData });
                }
            } catch {
                // Not valid JSON — ignore
            }
        }

        history.push(new AIMessage(responseText));

        // Cap history to last 10 messages to bound input token usage.
        const MAX_HISTORY_MESSAGES = 10;
        histories.set(ws, history.slice(-MAX_HISTORY_MESSAGES));

        safeSend(ws, { type: "agent_response", message: responseText });
    });

    ws.on("close", () => {
        histories.delete(ws);
    });
});

server.listen(PORT, () => {
    console.log(`[server] Listening on http://localhost:${PORT}`);
});
