import { TodoistService, TodoistTask } from "./service/todoist-service";
import { processTask } from "./cron-interaction";

const aiProjectId = process.env.AI_PROJECT_ID ?? "6gW8WWPXf49rvQ9M";
const processLabel = "processed";

const todoistService = new TodoistService();

function timestamp(): string {
    return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
}

function isWithinActiveHours(): boolean {
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }), 10);
    return hour >= 8 && hour < 22;
}

async function main() {
    if (!isWithinActiveHours()) {
        console.log(`[${timestamp()}] Outside active hours (8am and 10pm PST), skipping.`);
        return;
    }

    console.log(`[${timestamp()}] script started`);

    const todaysTasks: TodoistTask[] = await todoistService.getTasksForDate(new Date());
    const aiTasks = todaysTasks.filter(task => task.project_id === aiProjectId);
    const unprocessedTasks = aiTasks.filter(task => !task.labels.includes(processLabel));

    console.log(`[${timestamp()}] Found ${aiTasks.length} AI tasks, ${unprocessedTasks.length} unprocessed`);

    for (const task of unprocessedTasks) {
        await processTask(task);
    }

    console.log(`[${timestamp()}] script finished`);
}

main().catch((error) => {
    console.error("Error in main:", error);
    process.exit(1);
});
