import { tool } from "@langchain/core/tools";
import * as z from "zod";

const colorMap: Record<string, string> = {
    blue: "#3b82f6",
    purple: "#8b5cf6",
    green: "#22c55e",
    orange: "#f97316",
    pink: "#ec4899",
    yellow: "#eab308",
    red: "#ef4444",
    teal: "#14b8a6",
};

function linearRegression(values: number[]): number[] {
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
        numerator += (i - xMean) * (values[i] - yMean);
        denominator += (i - xMean) ** 2;
    }

    const slope = denominator === 0 ? 0 : numerator / denominator;
    const intercept = yMean - slope * xMean;

    return values.map((_, i) => parseFloat((slope * i + intercept).toFixed(4)));
}

function movingAverage(values: number[], window: number): (number | null)[] {
    return values.map((_, i) => {
        if (i < window - 1) return null;
        const slice = values.slice(i - window + 1, i + 1);
        const avg = slice.reduce((a, b) => a + b, 0) / window;
        return parseFloat(avg.toFixed(4));
    });
}

export const create_line_chart_tool = tool(
    ({ title, data, datasetLabel, yAxisLabel, color, movingAverageWindow }) => {
        const labels = data.map((d) => d.label);
        const values = data.map((d) => d.value);
        const chartColor = colorMap[color] ?? colorMap.blue;

        const trendValues = linearRegression(values);
        const maValues = movingAverage(values, movingAverageWindow);

        const chartData = {
            type: "line",
            title,
            labels,
            yAxisLabel,
            datasets: [
                {
                    label: datasetLabel,
                    data: values,
                    borderColor: chartColor,
                    backgroundColor: chartColor + "33",
                },
                {
                    label: "Trend",
                    data: trendValues,
                    borderColor: colorMap.purple,
                    backgroundColor: "transparent",
                    borderDash: [6, 3],
                    pointRadius: 0,
                },
                {
                    label: `${movingAverageWindow}-pt Moving Avg`,
                    data: maValues,
                    borderColor: colorMap.orange,
                    backgroundColor: "transparent",
                    borderDash: [3, 3],
                    pointRadius: 0,
                },
            ],
        };

        return JSON.stringify({ chartData });
    },
    {
        name: "create_line_chart",
        description:
            "Visualize any data trend over time as a line chart. Automatically adds a trend line (linear regression) and moving average. Use whenever the user asks about progress, trends, or changes over time.",
        schema: z.object({
            title: z.string().describe("Chart title"),
            data: z
                .array(z.object({ label: z.string(), value: z.number() }))
                .describe("Data points, each with a label (e.g. date) and numeric value"),
            datasetLabel: z.string().describe("Label for the main data series"),
            yAxisLabel: z.string().describe("Y-axis label (e.g. 'Steps', 'Hours', 'BPM')"),
            color: z
                .enum(["blue", "purple", "green", "orange", "pink", "yellow", "red", "teal"])
                .describe("Color for the main data series"),
            movingAverageWindow: z
                .number()
                .int()
                .min(2)
                .describe("Number of data points for the moving average window"),
        }),
    }
);

export const create_bar_chart_tool = tool(
    ({ title, datasets, yAxisLabel }) => {
        const labels = datasets[0].data.map((d) => d.label);

        const chartData = {
            type: "bar",
            title,
            labels,
            yAxisLabel,
            datasets: datasets.map((ds) => {
                const chartColor = colorMap[ds.color] ?? colorMap.blue;
                return {
                    label: ds.label,
                    data: ds.data.map((d) => d.value),
                    borderColor: chartColor,
                    backgroundColor: chartColor + "cc",
                };
            }),
        };

        return JSON.stringify({ chartData });
    },
    {
        name: "create_bar_chart",
        description:
            "Visualize categorical or comparative data as a bar chart. Supports multiple datasets for grouped bars. Use for comparisons (e.g. exercise volume by day, calories by meal type, weight per exercise).",
        schema: z.object({
            title: z.string().describe("Chart title"),
            datasets: z.array(
                z.object({
                    label: z.string().describe("Label for this data series"),
                    color: z
                        .enum(["blue", "purple", "green", "orange", "pink", "yellow", "red", "teal"])
                        .describe("Bar color for this series"),
                    data: z
                        .array(z.object({ label: z.string(), value: z.number() }))
                        .describe("Data points — all datasets must share the same labels in the same order"),
                })
            ).min(1).describe("One or more data series. Use multiple for grouped bars."),
            yAxisLabel: z.string().describe("Y-axis label (e.g. 'kg', 'calories', 'reps')"),
        }),
    }
);
