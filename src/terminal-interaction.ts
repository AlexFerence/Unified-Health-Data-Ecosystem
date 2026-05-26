import * as readline from "readline";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { agent } from "./orchestration-agent";

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
});

const prompt = (question: string): Promise<string> =>
    new Promise((resolve) => rl.question(question, resolve));

const printResponse = (content: unknown): void => {
    if (typeof content === "string") {
        console.log(`\nCoach: ${content}\n`);
    } else if (Array.isArray(content)) {
        const text = content
            .filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && "type" in c && c.type === "text")
            .map((c) => c.text)
            .join("");
        console.log(`\nCoach: ${text || JSON.stringify(content, null, 2)}\n`);
    } else {
        console.log(`\nCoach: ${JSON.stringify(content, null, 2)}\n`);
    }
};

const main = async () => {
    console.log("=== Fitness & Health Coach ===");
    console.log("Type your message and press Enter. Type 'exit' or 'quit' to stop.\n");

    let messages: BaseMessage[] = [];

    while (true) {
        let input: string;
        try {
            input = await prompt("You: ");
        } catch {
            // readline closed (e.g. Ctrl+D)
            break;
        }

        const trimmed = input.trim();
        if (!trimmed) continue;

        if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
            console.log("\nGoodbye! Keep up the great work!");
            break;
        }

        messages.push(new HumanMessage(trimmed));

        try {
            process.stdout.write("Coach: [thinking...]\r");
            const result = await agent.invoke({ messages });

            // Update history with full result (includes tool messages for context)
            messages = result.messages as BaseMessage[];

            // Find and print the last AI message
            const lastAI = [...messages].reverse().find((m) => AIMessage.isInstance(m));
            if (lastAI) {
                process.stdout.write("                    \r"); // clear the thinking line
                printResponse(lastAI.content);
            }
        } catch (err) {
            process.stdout.write("                    \r");
            console.error("[error]", err instanceof Error ? err.message : err);
        }
    }

    rl.close();
};

main();
