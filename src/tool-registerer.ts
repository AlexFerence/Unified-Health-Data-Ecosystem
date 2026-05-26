import { StructuredToolInterface } from "@langchain/core/tools";
import { getAllGeneralTools, getCurrentDate } from "./service/general-tools";
import { create_line_chart_tool, create_bar_chart_tool } from "./service/chart-tool";
import { getAllPerplexityTools } from "./service/perplexity-service";
import { getAllFitbitTools } from "./service/fitbit-service";
import { getAllWithingsTools } from "./service/withings-service";
import { getAllTodoistTools } from "./service/todoist-service";
import { getAllMealTools } from "./service/meal-service";
import { getAllExerciseTools } from "./service/exercise-service";
import { getAllFilesTools } from "./service/files-service";

export interface ServiceToolBundle {
    tools: Record<string, StructuredToolInterface>;
    requiredEnvVars: string[];
}

const serviceBundles: ServiceToolBundle[] = [
    getAllGeneralTools(),
    getAllPerplexityTools(),
    getAllFitbitTools(),
    getAllWithingsTools(),
    getAllTodoistTools(),
    getAllMealTools(),
    getAllExerciseTools(),
    getAllFilesTools(),
];

const getToolsToRegister = (): StructuredToolInterface[] => {
    const tools: StructuredToolInterface[] = [
        create_line_chart_tool,
        create_bar_chart_tool,
    ];

    for (const bundle of serviceBundles) {
        const allPresent = bundle.requiredEnvVars.every(v => process.env[v]);
        if (allPresent) {
            tools.push(...Object.values(bundle.tools));
        }
    }

    return tools;
};

const toolsByName: Record<string, StructuredToolInterface> = Object.fromEntries(
    getToolsToRegister().map(t => [t.name, t])
);

export { getToolsToRegister, toolsByName };
