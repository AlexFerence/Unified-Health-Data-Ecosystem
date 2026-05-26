import { tool, StructuredToolInterface } from '@langchain/core/tools';
import axios, { AxiosRequestConfig } from 'axios';
import * as z from "zod";

const TODOIST_API_BASE_URL = 'https://api.todoist.com/api/v1';

export interface TodoistTask {
	id: string;
	user_id: string;
	project_id: string;
	section_id: string | null;
	parent_id: string | null;
	child_order: number;
	day_order: number;
	content: string;
	description: string;
	checked: boolean;
	is_deleted: boolean;
	is_collapsed: boolean;
	labels: string[];
	priority: number;
	note_count: number;
	goal_ids: string[];
	added_at: string | null;
	updated_at: string | null;
	completed_at: string | null;
	completed_by_uid: string | null;
	added_by_uid: string | null;
	assigned_by_uid: string | null;
	responsible_uid: string | null;
	due: {
		date: string;
		is_recurring: boolean;
		datetime?: string;
		string: string;
		timezone?: string;
		lang?: string;
	} | null;
	deadline: {
		date: string;
		lang?: string;
	} | null;
	duration: {
		amount: number;
		unit: 'minute' | 'day';
	} | null;
}

export interface TodoistProject {
	id: string;
	name: string;
	description?: string | null;
	color?: string;
	is_favorite?: boolean;
	is_archived?: boolean;
	is_deleted?: boolean;
	is_collapsed?: boolean;
	is_frozen?: boolean;
	is_shared?: boolean;
	view_style?: 'list' | 'board' | 'calendar' | string;
	parent_id?: string | null;
	folder_id?: number | null;
	workspace_id?: number | null;
	child_order?: number;
	default_order?: number;
	created_at?: string;
	updated_at?: string;
	inbox_project?: boolean;
	can_assign_tasks?: boolean;
	can_comment?: boolean;
	creator_uid?: string;
	public_key?: string;
	access?: unknown;
	role?: string;
}

export interface GetTasksOptions {
	projectId?: string;
	sectionId?: string;
	parentId?: string;
	label?: string;
	ids?: string[];
	goalId?: string;
	limit?: number;
}

export interface CompletedTasksOptions {
	workspaceId?: number;
	projectId?: string;
	sectionId?: string;
	parentId?: string;
	filterQuery?: string;
	filterLang?: string;
	limit?: number;
}

export interface GetProjectsOptions {
	folderId?: number | null;
	workspaceId?: number | null;
	limit?: number;
}

export interface CreateTaskInput {
	content: string;
	description?: string;
	projectId?: string;
	sectionId?: string;
	parentId?: string;
	order?: number;
	labels?: string[];
	priority?: number;
	dueString?: string;
	dueDate?: string;
	dueDatetime?: string;
	dueLang?: string;
	assigneeId?: number | null;
	duration?: number;
	durationUnit?: 'minute' | 'day';
	deadlineDate?: string;
}

export interface UpdateTaskInput {
	content?: string;
	description?: string;
	labels?: string[];
	priority?: number;
	dueString?: string;
	dueDate?: string;
	dueDatetime?: string;
	dueLang?: string;
	duration?: number;
	durationUnit?: 'minute' | 'day';
	assigneeId?: number | null;
	deadlineDate?: string;
	childOrder?: number;
	isCollapsed?: boolean;
	dayOrder?: number;
}

export interface MoveTaskInput {
	projectId?: string | null;
	sectionId?: string | null;
	parentId?: string | null;
}

export interface QuickAddTaskInput {
	text: string;
	note?: string;
	reminder?: string;
	autoReminder?: boolean;
	meta?: boolean;
}

export interface QuickAddTaskResponse {
	[id: string]: unknown;
}

interface PaginatedResultsResponse<T> {
	results: T[];
	next_cursor: string | null;
}

interface CompletedTasksResponse<T> {
	items: T[];
	next_cursor: string | null;
}

export class TodoistService {
	private readonly apiToken: string;

	constructor(apiToken: string = process.env.TODOIST_KEY ?? '') {
		if (!apiToken) {
			throw new Error('TODOIST_KEY is not set.');
		}

		this.apiToken = apiToken;
	}

	async getTasks(options: GetTasksOptions = {}): Promise<TodoistTask[]> {
		return this.getAllPages<TodoistTask>('/tasks', {
			project_id: options.projectId,
			section_id: options.sectionId,
			parent_id: options.parentId,
			label: options.label,
			ids: options.ids && options.ids.length > 0 ? options.ids.join(',') : undefined,
			goal_id: options.goalId,
			limit: options.limit
		});
	}

	async getProjects(options: GetProjectsOptions = {}): Promise<TodoistProject[]> {
		return this.getAllPages<TodoistProject>('/projects', {
			folder_id: options.folderId ?? undefined,
			workspace_id: options.workspaceId ?? undefined,
			limit: options.limit
		});
	}

	async getTasksForDate(date: string | Date, options: GetTasksOptions = {}): Promise<TodoistTask[]> {
		const normalizedDate = this.formatDate(date);
		const tasks = await this.getTasks(options);

		return tasks.filter((task) => task.due?.date != null && task.due.date <= normalizedDate);
	}

	async getTasksByFilter(query: string, options: { lang?: string; limit?: number } = {}): Promise<TodoistTask[]> {
		return this.getAllPages<TodoistTask>('/tasks/filter', {
			query,
			lang: options.lang,
			limit: options.limit
		});
	}

	async getCompletedTasksByCompletionDate(
		since: string,
		until: string,
		options: CompletedTasksOptions = {}
	): Promise<TodoistTask[]> {
		return this.getAllCompletedTaskPages('/tasks/completed/by_completion_date', since, until, options);
	}

	async getCompletedTasksByDueDate(
		since: string,
		until: string,
		options: CompletedTasksOptions = {}
	): Promise<TodoistTask[]> {
		return this.getAllCompletedTaskPages('/tasks/completed/by_due_date', since, until, options);
	}

	async createTask(input: CreateTaskInput): Promise<TodoistTask> {
		return this.request<TodoistTask>('/tasks', {
			method: 'POST',
			data: this.mapTaskPayload(input)
		});
	}

	async updateTask(taskId: string, input: UpdateTaskInput): Promise<void> {
		await this.request<void>(`/tasks/${taskId}`, {
			method: 'POST',
			data: this.mapTaskPayload(input)
		});
	}

	async completeTask(taskId: string): Promise<void> {
		await this.closeTask(taskId);
	}

	async closeTask(taskId: string): Promise<void> {
		await this.request<void>(`/tasks/${taskId}/close`, {
			method: 'POST'
		});
	}

	async moveTask(taskId: string, input: MoveTaskInput): Promise<TodoistTask> {
		return this.request<TodoistTask>(`/tasks/${taskId}/move`, {
			method: 'POST',
			data: this.omitUndefined({
				project_id: input.projectId,
				section_id: input.sectionId,
				parent_id: input.parentId
			})
		});
	}

	async reopenTask(taskId: string): Promise<void> {
		await this.request<void>(`/tasks/${taskId}/reopen`, {
			method: 'POST'
		});
	}

	async quickAddTask(input: QuickAddTaskInput): Promise<QuickAddTaskResponse> {
		return this.request<QuickAddTaskResponse>('/tasks/quick', {
			method: 'POST',
			data: this.omitUndefined({
				text: input.text,
				note: input.note,
				reminder: input.reminder,
				auto_reminder: input.autoReminder,
				meta: input.meta
			})
		});
	}

	private async getAllPages<T>(path: string, params: Record<string, string | number | undefined>): Promise<T[]> {
		const items: T[] = [];
		let cursor: string | null = null;

		do {
			const response: PaginatedResultsResponse<T> = await this.request<PaginatedResultsResponse<T>>(path, {
				method: 'GET',
				params: this.omitUndefined({
					...params,
					cursor
				})
			});

			items.push(...response.results);
			cursor = response.next_cursor;
		} while (cursor);

		return items;
	}

	private async getAllCompletedTaskPages(
		path: string,
		since: string,
		until: string,
		options: CompletedTasksOptions
	): Promise<TodoistTask[]> {
		const items: TodoistTask[] = [];
		let cursor: string | null = null;

		do {
			const response: CompletedTasksResponse<TodoistTask> = await this.request<CompletedTasksResponse<TodoistTask>>(path, {
				method: 'GET',
				params: this.omitUndefined({
					since,
					until,
					workspace_id: options.workspaceId,
					project_id: options.projectId,
					section_id: options.sectionId,
					parent_id: options.parentId,
					filter_query: options.filterQuery,
					filter_lang: options.filterLang,
					limit: options.limit,
					cursor
				})
			});

			items.push(...response.items);
			cursor = response.next_cursor;
		} while (cursor);

		return items;
	}

	private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
		const response = await axios.request<T>({
			url: `${TODOIST_API_BASE_URL}${path}`,
			...config,
			headers: {
				Authorization: `Bearer ${this.apiToken}`,
				'Content-Type': 'application/json',
				...(config.headers ?? {})
			}
		});

		return response.data;
	}

	private formatDate(date: string | Date): string {
		if (date instanceof Date) {
			return date.toISOString().slice(0, 10);
		}

		return date;
	}

	private mapTaskPayload(input: CreateTaskInput | UpdateTaskInput): Record<string, unknown> {
		return this.omitUndefined({
			content: input.content,
			description: input.description,
			project_id: 'projectId' in input ? input.projectId : undefined,
			section_id: 'sectionId' in input ? input.sectionId : undefined,
			parent_id: 'parentId' in input ? input.parentId : undefined,
			order: 'order' in input ? input.order : undefined,
			labels: input.labels,
			priority: input.priority,
			due_string: input.dueString,
			due_date: input.dueDate,
			due_datetime: input.dueDatetime,
			due_lang: input.dueLang,
			assignee_id: input.assigneeId,
			duration: input.duration,
			duration_unit: input.durationUnit,
			deadline_date: input.deadlineDate,
			child_order: 'childOrder' in input ? input.childOrder : undefined,
			is_collapsed: 'isCollapsed' in input ? input.isCollapsed : undefined,
			day_order: 'dayOrder' in input ? input.dayOrder : undefined
		});
	}

	private omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
		return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
	}
}

const todoistService = new TodoistService();

export const todoist_create_task_tool = tool(
	async (input: CreateTaskInput) => {
		return todoistService.createTask(input);
	},
	{
		name: 'todoist_create_task',
		description: 'Create a new task in Todoist',
		schema: z.object({
			content: z.string().describe('The content of the task'),
			description: z.string().optional().describe('The description of the task'),
			projectId: z.string().optional().describe('The ID of the project to add the task to'),
			labels: z.array(z.string()).optional().describe('An array of label IDs to assign to the task'),
			priority: z.number().optional().describe('The priority level of the task (1-4)'),
			dueString: z.string().optional().describe('A natural language string representing the due date (e.g. "tomorrow at 5pm")'),
			dueDate: z.string().optional().describe('The due date in YYYY-MM-DD format'),
			dueDatetime: z.string().optional().describe('The due date and time in ISO 8601 format'),
			duration: z.number().optional().describe('The duration of the task'),
			durationUnit: z.enum(['minute', 'day']).optional().describe('The unit for the duration (minute or day)'),
		})
	}
);

export const todoist_get_tasks_for_date_tool = tool(
	async ({ date }: { date: string }) => {
		return todoistService.getTasksForDate(date);
	},
	{
		name: 'todoist_get_tasks_for_date',
		description: 'Get tasks that are due on a specific date',
		schema: z.object({
			date: z.string().describe('The date to get tasks for (YYYY-MM-DD)')
		})
	}
);

export const todoist_complete_task_tool = tool(
	async ({ taskId }: { taskId: string }) => {
		await todoistService.completeTask(taskId);
		return { success: true };
	},
	{
		name: 'todoist_complete_task',
		description: 'Mark a task as completed in Todoist',
		schema: z.object({
			taskId: z.string().describe('The ID of the task to complete')
		})
	}
);

export const todoist_update_task_tool = tool(
	async ({ taskId, content, description, labels, priority }: { taskId: string; content?: string; description?: string; labels?: string[]; priority?: number }) => {
		await todoistService.updateTask(taskId, { content, description, labels, priority });
		return { success: true };
	},
	{
		name: 'todoist_update_task',
		description: 'Update an existing task in Todoist',
		schema: z.object({
			taskId: z.string().describe('The ID of the task to update'),
			content: z.string().optional().describe('The new content of the task'),
			description: z.string().optional().describe('The new description of the task'),
			labels: z.array(z.string()).optional().describe('An array of label IDs to assign to the task'),
			priority: z.number().optional().describe('The priority level of the task (1-4)')
		})
	}
);

export const getAllTodoistTools = () => ({
	tools: {
		[todoist_create_task_tool.name]: todoist_create_task_tool,
		[todoist_get_tasks_for_date_tool.name]: todoist_get_tasks_for_date_tool,
		[todoist_complete_task_tool.name]: todoist_complete_task_tool,
		[todoist_update_task_tool.name]: todoist_update_task_tool,
	},
	requiredEnvVars: ["TODOIST_KEY"],
});


