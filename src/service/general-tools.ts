import { tool } from "@langchain/core/tools";
import * as z from "zod";

const twoNumbers = z.object({
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
});

export const add = tool(({ a, b }) => a + b, {
    name: "add",
    description: "Add two numbers",
    schema: twoNumbers,
});

export const subtract = tool(({ a, b }) => a - b, {
    name: "subtract",
    description: "Subtract b from a",
    schema: twoNumbers,
});

export const multiply = tool(({ a, b }) => a * b, {
    name: "multiply",
    description: "Multiply two numbers",
    schema: twoNumbers,
});

export const divide = tool(({ a, b }) => a / b, {
    name: "divide",
    description: "Divide a by b",
    schema: twoNumbers,
});


export const getAllGeneralTools = () => ({
    tools: {
        [add.name]: add,
        [subtract.name]: subtract,
        [multiply.name]: multiply,
        [divide.name]: divide,
        [getCurrentDate.name]: getCurrentDate,
        [getLocation.name]: getLocation,
    },
    requiredEnvVars: [] as string[],
});

export const getCurrentDate = tool(() => {
    const now = new Date();
    const dateFormatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Vancouver",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const timeFormatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Vancouver",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    const date = dateFormatter.format(now);
    const time = timeFormatter.format(now);
    return `${date} ${time} PST (Vancouver)`;
}, {
    name: "get_current_date",
    description: "Get the current date and time in PST (America/Vancouver). ALWAYS call this tool before logging meals, referencing 'today', 'yesterday', or any relative date. Returns YYYY-MM-DD HH:MM:SS PST (Vancouver).",
    schema: z.object({}),
});

// Just return a string saying I am located in Vancouver
export const getLocation = tool(() => {
    return "I am located in Vancouver, Canada.";
}, {
    name: "get_location",
    description: "Get the current location of the agent",
    schema: z.object({}),
});


