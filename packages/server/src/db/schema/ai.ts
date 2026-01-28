import { relations } from "drizzle-orm";
	import {
		boolean,
		customType,
		integer,
		jsonb,
		pgEnum,
		pgTable,
		text,
		vector,
	} from "drizzle-orm/pg-core";
	import { createInsertSchema } from "drizzle-zod";
	import { nanoid } from "nanoid";
	import { z } from "zod";
	import { organization } from "./account";
import { projects } from "./project";
import { server } from "./server";

// ============================================
// Enums
// ============================================

export const aiConversationStatus = pgEnum("aiConversationStatus", [
	"active",
	"archived",
]);

export const aiMessageRole = pgEnum("aiMessageRole", [
	"user",
	"assistant",
	"system",
	"tool",
]);

export const aiRunStatus = pgEnum("aiRunStatus", [
	"pending",
	"planning",
	"waiting_approval",
	"executing",
	"verifying",
	"completed",
	"failed",
	"cancelled",
]);

export const aiToolExecutionStatus = pgEnum("aiToolExecutionStatus", [
	"pending",
	"approved",
	"rejected",
	"executing",
	"completed",
	"failed",
]);

export const aiProviderTypeSchema = z.enum([
	"openai",
	"azure",
	"anthropic",
	"cohere",
	"perplexity",
	"mistral",
	"ollama",
	"deepinfra",
	"deepseek",
	"gemini",
	"openai_compatible",
]);

	// ============================================
	// AI Configuration Table (existing)
	// ============================================

	const vectorUntyped = customType<{
		data: number[];
		driverData: string;
	}>({
		dataType() {
			return "vector";
		},
		toDriver(value) {
			if (!Array.isArray(value)) return value as unknown as string;
			return JSON.stringify(value);
		},
		fromDriver(value) {
			if (typeof value !== "string") return value as unknown as number[];
			return value
				.slice(1, -1)
				.split(",")
				.map((v) => Number.parseFloat(v));
		},
	});

	export const ai = pgTable("ai", {
		aiId: text("aiId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		providerType: text("providerType").notNull().default("openai_compatible"),
		apiUrl: text("apiUrl").notNull(),
		apiKey: text("apiKey").notNull(),
		model: text("model").notNull(),
		embeddingModel: text("embeddingModel"),
		isEnabled: boolean("isEnabled").notNull().default(true),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }), // Admin ID who created the AI settings
		createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const aiRelations = relations(ai, ({ one }) => ({
	organization: one(organization, {
		fields: [ai.organizationId],
		references: [organization.id],
	}),
}));

	const createSchema = createInsertSchema(ai, {
		name: z.string().min(1, { message: "Name is required" }),
		providerType: aiProviderTypeSchema.optional().default("openai_compatible"),
		apiUrl: z.string().url({ message: "Please enter a valid URL" }),
		apiKey: z.string(),
		model: z.string().min(1, { message: "Model is required" }),
		embeddingModel: z.string().trim().min(1).optional().nullable(),
		isEnabled: z.boolean().optional(),
	});

	export const apiCreateAi = createSchema
		.pick({
			name: true,
			providerType: true,
			apiUrl: true,
			apiKey: true,
			model: true,
			embeddingModel: true,
			isEnabled: true,
		})
		.required()
		.extend({
			providerType: aiProviderTypeSchema.optional().default("openai_compatible"),
			embeddingModel: z.string().trim().min(1).optional().nullable(),
		});

	export const apiUpdateAi = createSchema
		.partial()
		.extend({
			aiId: z.string().min(1),
			embeddingModel: z.string().trim().min(1).optional().nullable(),
		})
		.omit({ organizationId: true });

	// ============================================
	// Agent Playbooks (organization-scoped memory)
	// ============================================

	export const aiAgentPlaybooks = pgTable("ai_agent_playbook", {
		playbookId: text("playbookId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		signature: text("signature").notNull(),
		intent: text("intent").notNull(),
		summary: text("summary"),
		tags: jsonb("tags").$type<string[]>(),
		steps: jsonb("steps")
			.$type<
				Array<{
					toolName: string;
					procedureName?: string;
					inputKeys?: string[];
				}>
			>()
			.notNull(),
		successCount: integer("successCount").notNull().default(0),
		failCount: integer("failCount").notNull().default(0),
		lastUsedAt: text("lastUsedAt"),
		expiresAt: text("expiresAt").notNull(),
		hashVector: vector("hashVector", { dimensions: 256 }).notNull(),
		embeddingModel: text("embeddingModel"),
		embeddingDim: integer("embeddingDim"),
		embeddingVector: vectorUntyped("embeddingVector"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	});

export const deploySuggestionSchema = z.object({
	environmentId: z.string().min(1),
	id: z.string().min(1),
	dockerCompose: z.string().min(1),
	envVariables: z.string(),
	serverId: z.string().optional(),
	name: z.string().min(1),
	description: z.string(),
	domains: z
		.array(
			z.object({
				host: z.string().min(1),
				port: z.number().min(1),
				serviceName: z.string().min(1),
			}),
		)
		.optional(),
	configFiles: z
		.array(
			z.object({
				filePath: z.string().min(1),
				content: z.string().min(1),
			}),
		)
		.optional(),
});

// ============================================
// AI Conversation Table
// ============================================

export const aiConversations = pgTable("ai_conversation", {
	conversationId: text("conversationId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	userId: text("userId").notNull(),
	aiId: text("aiId").references(() => ai.aiId, { onDelete: "set null" }),
	title: text("title"),
	projectId: text("projectId").references(() => projects.projectId, {
		onDelete: "set null",
	}),
	serverId: text("serverId").references(() => server.serverId, {
		onDelete: "set null",
	}),
	status: aiConversationStatus("status").notNull().default("active"),
	metadata: jsonb("metadata").$type<Record<string, unknown>>(),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	updatedAt: text("updatedAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const aiConversationsRelations = relations(
	aiConversations,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [aiConversations.organizationId],
			references: [organization.id],
		}),
		ai: one(ai, {
			fields: [aiConversations.aiId],
			references: [ai.aiId],
		}),
		project: one(projects, {
			fields: [aiConversations.projectId],
			references: [projects.projectId],
		}),
		server: one(server, {
			fields: [aiConversations.serverId],
			references: [server.serverId],
		}),
		messages: many(aiMessages),
		runs: many(aiRuns),
	}),
);

// ============================================
// AI Message Table
// ============================================

export const aiMessages = pgTable("ai_message", {
	messageId: text("messageId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	conversationId: text("conversationId")
		.notNull()
		.references(() => aiConversations.conversationId, { onDelete: "cascade" }),
	role: aiMessageRole("role").notNull(),
	content: text("content"),
	toolCalls:
		jsonb("toolCalls").$type<
			Array<{
				id: string;
				type: "function";
				executionId?: string;
				function: { name: string; arguments: string };
			}>
		>(),
	toolCallId: text("toolCallId"),
	toolName: text("toolName"),
	promptTokens: integer("promptTokens"),
	completionTokens: integer("completionTokens"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const aiMessagesRelations = relations(aiMessages, ({ one, many }) => ({
	conversation: one(aiConversations, {
		fields: [aiMessages.conversationId],
		references: [aiConversations.conversationId],
	}),
	toolExecutions: many(aiToolExecutions),
}));

// ============================================
// AI Run Table (Agent Mode)
// ============================================

export const aiRuns = pgTable("ai_run", {
	runId: text("runId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	conversationId: text("conversationId")
		.notNull()
		.references(() => aiConversations.conversationId, { onDelete: "cascade" }),
	status: aiRunStatus("status").notNull().default("pending"),
	goal: text("goal").notNull(),
	plan: jsonb("plan").$type<{
		steps: Array<{
			id: string;
			toolName: string;
			description: string;
			parameters: Record<string, unknown>;
			requiresApproval: boolean;
		}>;
	}>(),
	result: jsonb("result").$type<{
		success: boolean;
		summary: string;
		data?: unknown;
	}>(),
	error: text("error"),
	startedAt: text("startedAt"),
	completedAt: text("completedAt"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const aiRunsRelations = relations(aiRuns, ({ one, many }) => ({
	conversation: one(aiConversations, {
		fields: [aiRuns.conversationId],
		references: [aiConversations.conversationId],
	}),
	toolExecutions: many(aiToolExecutions),
}));

// ============================================
// AI Tool Execution Table
// ============================================

export const aiToolExecutions = pgTable("ai_tool_execution", {
	executionId: text("executionId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	conversationId: text("conversationId").references(
		() => aiConversations.conversationId,
		{ onDelete: "cascade" },
	),
	runId: text("runId").references(() => aiRuns.runId, { onDelete: "cascade" }),
	messageId: text("messageId").references(() => aiMessages.messageId, {
		onDelete: "cascade",
	}),
	toolName: text("toolName").notNull(),
	parameters: jsonb("parameters").$type<Record<string, unknown>>(),
	result: jsonb("result").$type<{
		success: boolean;
		message?: string;
		data?: unknown;
		error?: string;
	}>(),
	status: aiToolExecutionStatus("status").notNull().default("pending"),
	requiresApproval: boolean("requiresApproval").notNull().default(false),
	approvedBy: text("approvedBy"),
	approvedAt: text("approvedAt"),
	startedAt: text("startedAt"),
	completedAt: text("completedAt"),
	error: text("error"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const aiToolExecutionsRelations = relations(
	aiToolExecutions,
	({ one }) => ({
		conversation: one(aiConversations, {
			fields: [aiToolExecutions.conversationId],
			references: [aiConversations.conversationId],
		}),
		run: one(aiRuns, {
			fields: [aiToolExecutions.runId],
			references: [aiRuns.runId],
		}),
		message: one(aiMessages, {
			fields: [aiToolExecutions.messageId],
			references: [aiMessages.messageId],
		}),
	}),
);

// ============================================
// API Schemas for Conversations
// ============================================

const conversationSchema = createInsertSchema(aiConversations, {
	conversationId: z.string(),
	title: z.string().optional(),
	projectId: z.string().optional(),
	serverId: z.string().nullable().optional(),
});

export const apiCreateConversation = conversationSchema.pick({
	title: true,
	aiId: true,
	projectId: true,
	serverId: true,
});

export const apiFindConversation = z.object({
	conversationId: z.string().min(1),
});

export const apiListConversations = z.object({
	projectId: z.string().optional(),
	serverId: z.string().nullable().optional(),
	status: z.enum(["active", "archived"]).optional(),
	limit: z.number().min(1).max(100).optional().default(20),
	offset: z.number().min(0).optional().default(0),
});

export const apiUpdateConversation = z.object({
	conversationId: z.string().min(1),
	title: z.string().optional(),
	status: z.enum(["active", "archived"]).optional(),
});

export const apiSetToolApprovalsDisabled = z.object({
	conversationId: z.string().min(1),
	disabled: z.boolean(),
});

// ============================================
// API Schemas for Chat
// ============================================

export const apiSendMessage = z.object({
	conversationId: z.string().min(1),
	message: z.string().min(1),
	aiId: z.string().min(1),
});

export const apiGetMessages = z.object({
	conversationId: z.string().min(1),
	limit: z.number().min(1).max(100).optional().default(50),
	before: z.string().optional(),
});

// ============================================
// API Schemas for Agent
// ============================================

export const apiStartAgent = z.object({
	conversationId: z.string().min(1),
	goal: z.string().min(1),
	aiId: z.string().min(1),
});

export const apiGetRun = z.object({
	runId: z.string().min(1),
});

export const apiApproveExecution = z.object({
	executionId: z.string().min(1),
	approved: z.boolean(),
});

export const apiCancelRun = z.object({
	runId: z.string().min(1),
});
