import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	ai,
	aiAgentPlaybooks,
	aiConversations,
	aiDisplayMessages,
	aiEmbeddingProviders,
	aiMcpServers,
	aiMessages,
	aiRuns,
	aiToolExecutions,
} from "@dokploy/server/db/schema";
import { selectAIProvider } from "@dokploy/server/utils/ai/select-ai-provider";
import { TRPCError } from "@trpc/server";
import {
	embed,
	generateObject,
	generateText,
	type ModelMessage,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { z } from "zod";
import { IS_CLOUD } from "../constants";
import {
	getZodEnumValues,
	getZodIntersectionSides,
	getZodLiteralValue,
	getZodObjectShape,
	getZodTypeLabel,
	getZodUnionOptions,
	isZodKind,
	isZodObject,
	unwrapZodSchema,
} from "../utils/zod-compat";
import { findOrganizationById } from "./admin";
import {
	buildAgentDisplayMessageFromEvents,
	type ParsedAgentEventMessage,
} from "./ai/agent-display-replay";
import {
	callAiMcpTool,
	listAiMcpServersByOrganizationId,
	listAiMcpToolsCached,
	validateAiMcpToolArguments,
} from "./ai/mcp-servers";
import {
	type EmbeddingProviderConfig,
	hashTextToUnitVector,
	PLAYBOOK_DEFAULT_TOP_K,
	PLAYBOOK_EMBEDDING_MAX_DISTANCE,
	PLAYBOOK_HASH_DIMENSIONS,
	PLAYBOOK_HASH_MAX_DISTANCE,
	PLAYBOOK_INDEXED_EMBEDDING_DIMENSIONS,
	PLAYBOOK_MAX_INDEXABLE_EMBEDDING_DIMENSIONS,
	PLAYBOOK_QUERY_CANDIDATE_MULTIPLIER,
	PLAYBOOK_RETENTION_DAYS,
	tryEmbedText,
} from "./ai/playbook-memory";
import { getTrpcBridge } from "./ai/trpc-bridge";
import {
	initializeTools,
	type Tool,
	type ToolContext,
	type ToolResult,
	toolRegistry,
} from "./ai-tools";
import { selectRelevantTools } from "./ai-tools/selector";
import { findServerById } from "./server";

type CoreMessage = ModelMessage;

type AiMessageRow = typeof aiMessages.$inferSelect;
type AiDisplayMessageRow = typeof aiDisplayMessages.$inferSelect;
type AiMessageAttachment = NonNullable<AiMessageRow["attachments"]>[number];

const OPENAI_RESPONSES_PROVIDER_OPTIONS = {
	openai: {
		store: false,
	},
};

const AUTO_EXECUTE_ACTION_REQUESTS = false;

function getOpenAIResponsesProviderOptions(aiSettings: {
	providerType?: string | null;
}) {
	return String(aiSettings.providerType ?? "")
		.trim()
		.toLowerCase() === "openai"
		? OPENAI_RESPONSES_PROVIDER_OPTIONS
		: undefined;
}

type ToolPromptInfo = {
	name: string;
	description: string;
	riskLevel: string;
	requiresApproval: boolean;
	parameters?: string;
};

type MetaToolName =
	| "tool_suggest"
	| "tool_search"
	| "tool_describe"
	| "tool_call";

type ToolBudgetMode = "standard" | "max";

const RISK_RANK = {
	low: 1,
	medium: 2,
	high: 3,
} as const;

const TOOL_BUDGET_STANDARD_STEPS = 60;
const TOOL_BUDGET_MAX_STEPS = 200;

const MCP_VIRTUAL_TOOL_PREFIX = "mcp/";
const MCP_SERVER_NAME_TTL_MS = 5 * 60 * 1000;
const mcpServerNameCache = new Map<
	string,
	{ name: string; expiresAt: number }
>();

function buildMcpVirtualToolName(mcpServerId: string, toolName: string) {
	const id = String(mcpServerId ?? "").trim();
	const name = String(toolName ?? "").trim();
	return `${MCP_VIRTUAL_TOOL_PREFIX}${id}/${name}`;
}

function parseMcpVirtualToolName(
	toolName: string,
): { mcpServerId: string; mcpToolName: string } | null {
	const normalized = String(toolName ?? "").trim();
	if (!normalized.toLowerCase().startsWith(MCP_VIRTUAL_TOOL_PREFIX))
		return null;
	const parts = normalized.split("/");
	if (parts.length < 3) return null;
	const mcpServerId = String(parts[1] ?? "").trim();
	const mcpToolName = parts.slice(2).join("/").trim();
	if (!mcpServerId || !mcpToolName) return null;
	return { mcpServerId, mcpToolName };
}

async function getMcpServerNameCached(params: {
	organizationId: string;
	mcpServerId: string;
}): Promise<string> {
	const orgId = String(params.organizationId ?? "").trim();
	const serverId = String(params.mcpServerId ?? "").trim();
	if (!orgId || !serverId) return "";

	const key = `${orgId}:${serverId}`;
	const now = Date.now();
	const cached = mcpServerNameCache.get(key);
	if (cached && cached.expiresAt > now) return cached.name;

	let name = "";
	try {
		const server = await db.query.aiMcpServers.findFirst({
			where: eq(aiMcpServers.mcpServerId, serverId),
			columns: {
				organizationId: true,
				name: true,
			},
		});
		if (server && server.organizationId === orgId) {
			name = String(server.name ?? "").trim();
		}
	} catch {}

	mcpServerNameCache.set(key, {
		name,
		expiresAt: now + MCP_SERVER_NAME_TTL_MS,
	});
	return name;
}

async function executeToolByNameMaybeMcp(
	toolName: string,
	parameters: unknown,
	ctx: ToolContext,
): Promise<ToolResult> {
	const mcp = parseMcpVirtualToolName(toolName);
	if (!mcp) {
		return await toolRegistry.execute(toolName, parameters, ctx);
	}

	const serverName = await getMcpServerNameCached({
		organizationId: ctx.organizationId,
		mcpServerId: mcp.mcpServerId,
	});
	const args =
		isRecord(parameters) && !Array.isArray(parameters)
			? (parameters as Record<string, unknown>)
			: {};

	try {
		try {
			const toolList = await listAiMcpToolsCached({
				organizationId: ctx.organizationId,
				mcpServerId: mcp.mcpServerId,
			});
			if (!toolList.error) {
				const info = toolList.tools.find(
					(t) => String(t.name ?? "").trim() === mcp.mcpToolName,
				);
				const validation = validateAiMcpToolArguments({
					inputSchema: info?.inputSchema,
					arguments: args,
				});
				if (!validation.ok) {
					return {
						success: false,
						message: `Invalid parameters for MCP tool "${mcp.mcpToolName}"`,
						error: validation.errorText.replace(/\s*\n\s*/g, "; ").trim(),
						data: {
							mcpServerId: mcp.mcpServerId,
							serverName: serverName || mcp.mcpServerId,
							toolName: mcp.mcpToolName,
							issues: validation.issues,
						},
					};
				}
			}
		} catch {}

		const res = await callAiMcpTool({
			organizationId: ctx.organizationId,
			mcpServerId: mcp.mcpServerId,
			toolName: mcp.mcpToolName,
			arguments: args,
		});
		const success = res.isError !== true;
		return {
			success,
			message: success
				? `MCP tool "${mcp.mcpToolName}" executed`
				: `MCP tool "${mcp.mcpToolName}" returned an error`,
			error: success ? undefined : "MCP_TOOL_ERROR",
			data: {
				mcpServerId: mcp.mcpServerId,
				serverName: serverName || mcp.mcpServerId,
				toolName: mcp.mcpToolName,
				content: res.content,
				structuredContent: res.structuredContent,
				isError: res.isError,
			},
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			message: `MCP tool "${mcp.mcpToolName}" failed`,
			error: errorMessage,
			data: {
				mcpServerId: mcp.mcpServerId,
				serverName: serverName || mcp.mcpServerId,
				toolName: mcp.mcpToolName,
			},
		};
	}
}

function normalizeRiskLevel(value: unknown): string {
	return typeof value === "string" ? value.toLowerCase() : "high";
}

function getRiskRank(value: unknown): number {
	const normalized = normalizeRiskLevel(value);
	switch (normalized) {
		case "low":
			return RISK_RANK.low;
		case "medium":
			return RISK_RANK.medium;
		case "high":
			return RISK_RANK.high;
		default:
			return RISK_RANK.high;
	}
}

function describeZodParameters(schema: z.ZodTypeAny): string {
	const unwrapped = unwrapZodSchema(schema).schema;
	if (!isZodObject(unwrapped)) {
		return `Schema: ${getZodTypeLabel(unwrapped)}`;
	}

	const rawShape = getZodObjectShape(unwrapped);
	const keys = Object.keys(rawShape || {});
	if (keys.length === 0) return "(no parameters)";

	const lines = keys.map((key) => {
		const field = rawShape[key] as z.ZodTypeAny;
		const { schema: fieldSchema, flags } = unwrapZodSchema(field);
		const required = !flags.optional && !flags.hasDefault;
		const desc = (fieldSchema as unknown as { _def?: { description?: string } })
			._def?.description;
		const typeLabel = getZodTypeLabel(fieldSchema);
		const extras = [
			required ? "required" : "optional",
			flags.nullable ? "nullable" : "",
			flags.hasDefault ? "default" : "",
		]
			.filter(Boolean)
			.join(", ");
		return `- ${key}: ${typeLabel} (${extras})${desc ? ` - ${desc}` : ""}`;
	});

	return lines.join("\n");
}

function buildMetaToolPromptInfo(params?: {
	selectedNames?: readonly MetaToolName[];
}): ToolPromptInfo[] {
	const selected = new Set<MetaToolName>(
		params?.selectedNames ?? [
			"tool_suggest",
			"tool_search",
			"tool_describe",
			"tool_call",
		],
	);
	return [
		{
			name: "tool_suggest",
			description:
				"Suggest a small set of likely relevant tools for the user's request. Use this first when you need a shortlist; fall back to tool_search if needed.",
			riskLevel: "low",
			requiresApproval: false,
		},
		{
			name: "tool_search",
			description:
				"Search the full tool catalog by natural language and return matching tool names.",
			riskLevel: "low",
			requiresApproval: false,
		},
		{
			name: "tool_describe",
			description:
				"Get details and parameter hints for a specific tool (name, description, approval/risk, parameters).",
			riskLevel: "low",
			requiresApproval: false,
		},
		{
			name: "tool_call",
			description:
				"Execute a specific tool by name with parameters. The target tool may require approval; tool_call itself does not.",
			riskLevel: "low",
			requiresApproval: false,
		},
	].filter((tool): tool is ToolPromptInfo & { name: MetaToolName } =>
		selected.has(tool.name as MetaToolName),
	);
}

function sortToolsForPrompt(tools: Tool[]): Tool[] {
	const safe = tools
		.filter((t) => t.riskLevel === "low" && !t.requiresApproval)
		.sort((a, b) => a.name.localeCompare(b.name));
	const rest = tools
		.filter((t) => !(t.riskLevel === "low" && !t.requiresApproval))
		.sort((a, b) => a.name.localeCompare(b.name));
	return safe.concat(rest);
}

function buildToolCatalogPromptInfo(params: {
	userMessage: string;
	projectId?: string;
	serverId?: string;
	maxTools?: number;
}): ToolPromptInfo[] {
	const maxTools = typeof params.maxTools === "number" ? params.maxTools : 24;
	const all = toolRegistry.getAll();
	const coreToolOrder = [
		"trpc_router_list",
		"trpc_procedure_search",
		"trpc_procedure_suggest",
		"trpc_procedure_describe",
		"trpc_procedure_call",
	] as const;
	const coreTools: Tool[] = coreToolOrder
		.map((name) => toolRegistry.get(name))
		.filter(Boolean) as Tool[];

	const selectedTools = (() => {
		if (all.length <= maxTools) return sortToolsForPrompt(all);

		const remaining = Math.max(0, maxTools - coreTools.length);
		const relevant = selectRelevantTools(params.userMessage, {
			projectId: params.projectId,
			serverId: params.serverId,
			minTools: 0,
			maxTools: remaining,
		});

		const byName = new Map<string, Tool>();
		for (const t of coreTools) byName.set(t.name, t);
		for (const t of relevant) byName.set(t.name, t);

		const combined: Tool[] = [];
		for (const name of coreToolOrder) {
			const t = byName.get(name);
			if (t) {
				combined.push(t);
				byName.delete(name);
			}
		}

		return combined.concat(sortToolsForPrompt(Array.from(byName.values())));
	})();

	return selectedTools.map((t) => {
		const data = getToolDescribeData(t);
		return {
			name: data.name,
			description: data.description,
			riskLevel: data.riskLevel,
			requiresApproval: data.requiresApproval,
			parameters: data.parameters,
		};
	});
}

function shouldEnableFullToolSearch(userMessage: string): boolean {
	const text = userMessage.trim();
	if (!text) return true;

	if (
		/(?:\btool_(?:search|suggest|describe)\b|\btool\s+catalog\b|\btool\s+list\b|\bmcp\b|\brouter\b|\bprocedure\b|\bschema\b|\bapi\b|工具|工具列表|工具目录|过程|路由|参数|入参|schema)/i.test(
			text,
		)
	) {
		return true;
	}

	if (
		/(?:what can|which tool|which tools|search|find|explore|discover|suggest|recommend|如何|怎么|哪些|哪个|推荐|查找|搜索)/i.test(
			text,
		)
	) {
		const operationalSignals =
			/(?:deploy|deployment|domain|certificate|ssl|https|docker|container|compose|server|file|repo|database|sql|backup|restore|restart|logs?|修复|部署|域名|证书|容器|服务器|数据库|备份|恢复|重启|日志)/i.test(
				text,
			);
		if (!operationalSignals) return true;
	}

	return false;
}

function buildToolExposurePlan(params: {
	userMessage: string;
	projectId?: string;
	serverId?: string;
}): {
	activeMetaTools: MetaToolName[];
	promptTools: ToolPromptInfo[];
} {
	const enableFullSearch = shouldEnableFullToolSearch(params.userMessage);
	const activeMetaTools: MetaToolName[] = enableFullSearch
		? ["tool_suggest", "tool_search", "tool_describe", "tool_call"]
		: ["tool_suggest", "tool_describe", "tool_call"];
	const promptTools = buildMetaToolPromptInfo({
		selectedNames: activeMetaTools,
	}).concat(
		buildToolCatalogPromptInfo({
			userMessage: params.userMessage,
			projectId: params.projectId,
			serverId: params.serverId,
			maxTools: enableFullSearch ? 14 : 10,
		}),
	);

	return {
		activeMetaTools,
		promptTools,
	};
}

function resolveActiveToolNames<TTools extends Record<string, unknown>>(
	tools: TTools,
	activeMetaTools: readonly MetaToolName[],
): Array<Extract<keyof TTools, string>> {
	const out: Array<Extract<keyof TTools, string>> = [];
	for (const name of activeMetaTools) {
		if (name in tools) {
			out.push(name as Extract<keyof TTools, string>);
		}
	}
	return out;
}

function tokenizeToolSearchQuery(query: string): string[] {
	const q = query.trim().toLowerCase();
	const tokens: string[] = q.split(/[\s/_.-]+/g).filter(Boolean);

	const add = (...arr: string[]) => {
		for (const t of arr) tokens.push(t);
	};

	// Keep this minimal: the tool catalog is intentionally small (tRPC bridge),
	// but we still want Chinese queries to match English tool names.
	if (/(trpc|t\s*rpc|t-rpc)/i.test(query)) add("trpc");
	if (/(api|接口)/i.test(query)) add("api");
	if (/(router|routers|路由|模块)/i.test(query)) add("router");
	if (/(procedure|procedures|方法|函数|接口)/i.test(query)) add("procedure");
	if (/(search|查找|搜索)/i.test(query)) add("search");
	if (/(describe|schema|入参|参数|字段|说明|描述)/i.test(query))
		add("describe");
	if (/(call|invoke|execute|run|调用|执行)/i.test(query)) add("call");
	if (
		/(\bsql\b|\bdatabase\b|\bdb\b|\btable\b|\bschema\b|\bddl\b|\bdml\b|\bpostgres\b|\bpostgresql\b|\bmysql\b|\bmariadb\b|\bsqlite\b|\bmongodb\b|\bmongo\b|\bredis\b|数据库|数据表|表|查询|结构)/i.test(
			query,
		)
	) {
		add(
			"sql",
			"database",
			"db",
			"table",
			"schema",
			"ddl",
			"dml",
			"postgres",
			"postgresql",
			"pg",
			"mysql",
			"mariadb",
			"mongo",
			"mongodb",
			"redis",
		);
	}
	if (/(项目|project)/i.test(query)) add("project", "projects");
	if (/(环境|environment|env)/i.test(query)) add("environment");
	if (/(应用|application|app)/i.test(query)) add("application", "app");
	if (/(容器|container|docker)/i.test(query)) add("container", "docker");
	if (/(日志|log|logs)/i.test(query)) add("logs", "log");
	if (/(服务器|主机|server|host)/i.test(query)) add("server");

	return Array.from(new Set(tokens.filter(Boolean)));
}

function deriveDefaultToolTags(t: {
	name: string;
	category: string;
}): string[] {
	const parts = t.name.split(/[_-]/g).filter(Boolean);
	const isNonEmptyString = (v: unknown): v is string =>
		typeof v === "string" && v.trim().length > 0;
	return Array.from(new Set([t.category, ...parts].filter(isNonEmptyString)));
}

function deriveToolSearchTerms(t: {
	name: string;
	description: string;
	category: string;
	aliases?: string[];
	tags?: string[];
}): string[] {
	const derivedTags = deriveDefaultToolTags({
		name: t.name,
		category: t.category,
	});
	const nameParts = t.name.split(/[_-]/g).filter(Boolean);
	const actionSynonyms: Record<string, string[]> = {
		create: ["create", "add", "new"],
		add: ["create", "add", "new"],
		new: ["create", "add", "new"],
		update: ["update", "edit", "set"],
		edit: ["update", "edit", "set"],
		set: ["update", "edit", "set"],
		delete: ["delete", "remove", "destroy"],
		remove: ["delete", "remove", "destroy"],
		destroy: ["delete", "remove", "destroy"],
		list: ["list", "get", "show", "all"],
		get: ["list", "get", "show", "all"],
		show: ["list", "get", "show", "all"],
		all: ["list", "get", "show", "all"],
		info: ["info", "detail", "inspect"],
		detail: ["info", "detail", "inspect"],
		inspect: ["info", "detail", "inspect"],
	};
	const actionTerms = nameParts.flatMap((p) => actionSynonyms[p] ?? []);
	return Array.from(
		new Set(
			[
				...(t.aliases ?? []),
				...(t.tags ?? []),
				...derivedTags,
				...nameParts,
				...actionTerms,
			].filter(Boolean),
		),
	);
}

type ToolSearchIndexItem = {
	t: ReturnType<typeof toolRegistry.getAll>[number];
	nameLower: string;
	extraTermsLower: string[];
	hayLower: string;
};

let toolSearchIndexCache:
	| {
			revision: number;
			items: ToolSearchIndexItem[];
	  }
	| undefined;

function getToolSearchIndex(): ToolSearchIndexItem[] {
	const revision = toolRegistry.getRevision();
	if (toolSearchIndexCache?.revision === revision) {
		return toolSearchIndexCache.items;
	}

	const all = toolRegistry.getAll();

	const items: ToolSearchIndexItem[] = all.map((t) => {
		const extraTerms = deriveToolSearchTerms(t);
		return {
			t,
			nameLower: t.name.toLowerCase(),
			extraTermsLower: extraTerms.map((x) => x.toLowerCase()),
			hayLower:
				`${t.name} ${t.description} ${t.category} ${extraTerms.join(" ")}`.toLowerCase(),
		};
	});

	toolSearchIndexCache = { revision, items };
	return items;
}

type ToolDescribeData = {
	name: string;
	description: string;
	category: string;
	riskLevel: string;
	requiresApproval: boolean;
	aliases: string[];
	tags: string[];
	confirmLiterals: string[];
	exampleParams: Record<string, unknown>;
	exampleToolCall: {
		toolName: string;
		params: Record<string, unknown>;
	};
	parameters: string;
};

let toolDescribeCache:
	| {
			revision: number;
			items: Map<string, ToolDescribeData>;
	  }
	| undefined;

let aiWarmupPromise: Promise<void> | undefined;

export function warmupAi(options?: {
	toolSearchIndex?: boolean;
	toolDescribeCache?: boolean;
}): Promise<void> {
	if (aiWarmupPromise) return aiWarmupPromise;

	aiWarmupPromise = (async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		initializeTools();

		if (options?.toolSearchIndex !== false) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			getToolSearchIndex();
		}

		if (options?.toolDescribeCache) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const all = toolRegistry.getAll();
			for (const t of all) {
				getToolDescribeData(t);
			}
		}
	})().catch((error) => {
		aiWarmupPromise = undefined;
		console.warn(
			"[AI warmup] Failed to warm up AI tool runtime:",
			error instanceof Error ? error.message : String(error),
		);
	});

	return aiWarmupPromise;
}

function getToolDescribeData(t: Tool): ToolDescribeData {
	const revision = toolRegistry.getRevision();
	if (!toolDescribeCache || toolDescribeCache.revision !== revision) {
		toolDescribeCache = { revision, items: new Map() };
	}

	const cached = toolDescribeCache.items.get(t.name);
	if (cached) {
		return {
			...cached,
			aliases: [...cached.aliases],
			tags: [...cached.tags],
			confirmLiterals: [...cached.confirmLiterals],
			exampleParams: { ...cached.exampleParams },
			exampleToolCall: {
				...cached.exampleToolCall,
				params: { ...cached.exampleToolCall.params },
			},
		};
	}

	const tags = t.tags && t.tags.length > 0 ? t.tags : deriveDefaultToolTags(t);
	const confirmLiterals = extractConfirmLiterals(t.parameters);
	const exampleParams = buildExampleParams(t.parameters);
	const data: ToolDescribeData = {
		name: t.name,
		description: t.description,
		category: t.category,
		riskLevel: t.riskLevel,
		requiresApproval: t.requiresApproval,
		aliases: t.aliases ?? [],
		tags,
		confirmLiterals,
		exampleParams,
		exampleToolCall: {
			toolName: t.name,
			params: { ...exampleParams },
		},
		parameters: describeZodParameters(t.parameters),
	};

	toolDescribeCache.items.set(t.name, data);
	return {
		...data,
		aliases: [...data.aliases],
		tags: [...data.tags],
		confirmLiterals: [...data.confirmLiterals],
		exampleParams: { ...data.exampleParams },
		exampleToolCall: {
			...data.exampleToolCall,
			params: { ...data.exampleToolCall.params },
		},
	};
}

function extractLiteralStringOptions(schema: z.ZodTypeAny): string[] {
	const unwrapped = unwrapZodSchema(schema).schema;

	if (isZodKind(unwrapped, "literal")) {
		const v = getZodLiteralValue(unwrapped);
		return typeof v === "string" ? [v] : [];
	}
	if (isZodKind(unwrapped, "enum")) {
		return getZodEnumValues(unwrapped);
	}
	if (isZodKind(unwrapped, "union")) {
		return Array.from(
			new Set(
				getZodUnionOptions(unwrapped).flatMap((opt) =>
					extractLiteralStringOptions(opt),
				),
			),
		);
	}
	if (isZodKind(unwrapped, "intersection")) {
		const { left, right } = getZodIntersectionSides(unwrapped);
		return Array.from(
			new Set([
				...(left ? extractLiteralStringOptions(left) : []),
				...(right ? extractLiteralStringOptions(right) : []),
			]),
		);
	}

	return [];
}

function extractConfirmLiterals(schema: z.ZodTypeAny): string[] {
	const unwrapped = unwrapZodSchema(schema).schema;
	if (!isZodObject(unwrapped)) return [];

	const rawShape = getZodObjectShape(unwrapped);

	const keys = Object.keys(rawShape || {});
	const confirmKeys = keys
		.filter((k) => k.toLowerCase().includes("confirm"))
		.sort((a, b) => (a === "confirm" ? -1 : 0) - (b === "confirm" ? -1 : 0));

	const collected = confirmKeys.flatMap((key) =>
		extractLiteralStringOptions(rawShape[key] as z.ZodTypeAny),
	);
	return Array.from(new Set(collected));
}

function buildExampleParams(schema: z.ZodTypeAny): Record<string, unknown> {
	const unwrapped = unwrapZodSchema(schema).schema;
	if (!isZodObject(unwrapped)) return {};

	const rawShape = getZodObjectShape(unwrapped);

	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(rawShape ?? {})) {
		const { schema: fieldSchema, flags } = unwrapZodSchema(
			field as z.ZodTypeAny,
		);
		const required = !flags.optional && !flags.hasDefault;
		if (!required) continue;

		if (key.toLowerCase().includes("confirm")) {
			const options = extractLiteralStringOptions(fieldSchema);
			out[key] = options[0] ?? "<confirm>";
			continue;
		}

		const typeLabel = getZodTypeLabel(fieldSchema);
		if (typeLabel.includes("string")) out[key] = "<string>";
		else if (typeLabel.includes("number")) out[key] = 1;
		else if (typeLabel.includes("boolean")) out[key] = true;
		else if (typeLabel.includes("enum")) {
			const opts = extractLiteralStringOptions(fieldSchema);
			out[key] = opts[0] ?? "<value>";
		} else if (typeLabel.includes("array")) out[key] = [];
		else if (typeLabel.includes("object")) out[key] = {};
		else out[key] = "<value>";
	}

	return out;
}

function buildUnknownToolSuggestionResult(toolName: string): {
	success: false;
	message: string;
	error: string;
	data: {
		query: string;
		suggestions: Array<{
			name: string;
			description: string;
			category: string;
			riskLevel: string;
			requiresApproval: boolean;
		}>;
		nextCall?: {
			toolName: string;
			params: Record<string, unknown>;
			confirmLiterals: string[];
		};
	};
} {
	const normalized = toolName.trim();
	const searched = searchToolCatalog({ query: normalized, limit: 5 });
	return {
		success: false,
		message: `Tool "${normalized}" not found`,
		error: `Unknown tool: ${normalized}`,
		data: {
			query: normalized,
			suggestions: searched.data.map((t) => ({
				name: t.name,
				description: t.description,
				category: t.category,
				riskLevel: t.riskLevel,
				requiresApproval: t.requiresApproval,
			})),
			nextCall: searched.meta.nextCall,
		},
	};
}

function searchToolCatalog(params: {
	query: string;
	limit?: number;
	category?: string;
	riskLevelMax?: "low" | "medium" | "high";
	requiresApproval?: boolean;
}): {
	success: boolean;
	message: string;
	meta: {
		query: string;
		nextCall?: {
			toolName: string;
			params: Record<string, unknown>;
			confirmLiterals: string[];
		};
		appliedFilters: {
			category?: string;
			riskLevelMax?: "low" | "medium" | "high";
			requiresApproval?: boolean;
		};
	};
	data: Array<{
		name: string;
		description: string;
		category: string;
		riskLevel: string;
		requiresApproval: boolean;
		aliases?: string[];
		tags?: string[];
	}>;
} {
	const all = toolRegistry.getAll();
	const index = getToolSearchIndex();
	const tokens = tokenizeToolSearchQuery(params.query);
	const tokensLower = tokens.map((t) => t.toLowerCase());
	const riskLevelMaxRank =
		typeof params.riskLevelMax === "string"
			? getRiskRank(params.riskLevelMax)
			: undefined;
	const normalizedCategory =
		typeof params.category === "string" && params.category.trim().length > 0
			? params.category.trim()
			: undefined;

	const scored: Array<{ t: (typeof all)[number]; score: number }> = [];
	for (const x of index) {
		const t = x.t;
		if (normalizedCategory && t.category !== normalizedCategory) continue;
		if (typeof params.requiresApproval === "boolean") {
			if (t.requiresApproval !== params.requiresApproval) continue;
		}
		if (typeof riskLevelMaxRank === "number") {
			if (getRiskRank(t.riskLevel) > riskLevelMaxRank) continue;
		}

		let score = 0;
		for (const tTok of tokensLower) {
			if (x.nameLower.includes(tTok)) score += 6;
			if (x.extraTermsLower.some((term) => term.includes(tTok))) score += 5;
			if (x.hayLower.includes(tTok)) score += 3;
		}
		if (t.riskLevel === "low") score += 1;
		if (score > 0) scored.push({ t, score });
	}
	scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));

	const limit = params.limit ?? 12;
	const picked = (() => {
		if (scored.length > 0) return scored.slice(0, limit).map((x) => x.t);

		const pool = all.filter((t) => {
			if (normalizedCategory && t.category !== normalizedCategory) return false;
			if (typeof params.requiresApproval === "boolean") {
				if (t.requiresApproval !== params.requiresApproval) return false;
			}
			if (typeof riskLevelMaxRank === "number") {
				if (getRiskRank(t.riskLevel) > riskLevelMaxRank) return false;
			}
			return true;
		});

		const safe = pool
			.filter((t) => t.riskLevel === "low" && !t.requiresApproval)
			.sort((a, b) => a.name.localeCompare(b.name));

		const isDestructive = (name: string) =>
			/(delete|remove|destroy|purge|uninstall|reset|rotate|revoke|restore)/i.test(
				name,
			);
		const writeCapable = pool
			.filter((t) => t.requiresApproval || t.riskLevel !== "low")
			.filter((t) => !isDestructive(t.name))
			.sort((a, b) => a.name.localeCompare(b.name));

		return safe.concat(writeCapable).slice(0, limit);
	})();

	const message =
		scored.length > 0
			? `Found ${picked.length} tool(s) matching "${params.query}"`
			: `No direct matches for "${params.query}". Returning ${picked.length} suggested tool(s) (some may require approval).`;

	const bestTool = scored.length > 0 ? scored[0]?.t : undefined;
	const fallbackTool =
		toolRegistry.get("trpc_procedure_search") ??
		toolRegistry.get("trpc_router_list");
	const nextCall = bestTool
		? {
				toolName: bestTool.name,
				params: buildExampleParams(bestTool.parameters),
				confirmLiterals: extractConfirmLiterals(bestTool.parameters),
			}
		: fallbackTool
			? {
					toolName: fallbackTool.name,
					params:
						fallbackTool.name === "trpc_procedure_search"
							? { query: params.query }
							: buildExampleParams(fallbackTool.parameters),
					confirmLiterals: extractConfirmLiterals(fallbackTool.parameters),
				}
			: picked[0]
				? {
						toolName: picked[0].name,
						params: buildExampleParams(picked[0].parameters),
						confirmLiterals: extractConfirmLiterals(picked[0].parameters),
					}
				: undefined;

	return {
		success: true,
		message,
		meta: {
			query: params.query,
			nextCall,
			appliedFilters: {
				category: normalizedCategory,
				riskLevelMax: params.riskLevelMax,
				requiresApproval: params.requiresApproval,
			},
		},
		data: picked.map((t) => ({
			name: t.name,
			description: t.description,
			category: t.category,
			riskLevel: t.riskLevel,
			requiresApproval: t.requiresApproval,
			aliases: t.aliases ?? [],
			tags: t.tags && t.tags.length > 0 ? t.tags : deriveDefaultToolTags(t),
		})),
	};
}

export const getAiSettingsByOrganizationId = async (organizationId: string) => {
	const aiSettings = await db.query.ai.findMany({
		where: eq(ai.organizationId, organizationId),
		orderBy: desc(ai.createdAt),
	});
	return aiSettings;
};

export const getAiSettingById = async (aiId: string) => {
	const aiSetting = await db.query.ai.findFirst({
		where: eq(ai.aiId, aiId),
	});
	if (!aiSetting) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AI settings not found",
		});
	}
	return aiSetting;
};

export const saveAiSettings = async (organizationId: string, settings: any) => {
	const aiId = settings.aiId;
	const existing = aiId
		? await db.query.ai.findFirst({ where: eq(ai.aiId, aiId) })
		: null;
	const providerType =
		(settings?.providerType as string | undefined | null) ??
		(existing?.providerType as string | undefined) ??
		"openai_compatible";
	const apiUrl = String(settings?.apiUrl ?? "")
		.trim()
		.replace(/\/+$/, "");
	const normalizedSettings = {
		...settings,
		providerType,
		apiUrl,
	};

	return db
		.insert(ai)
		.values({
			aiId,
			organizationId,
			...normalizedSettings,
		})
		.onConflictDoUpdate({
			target: ai.aiId,
			set: {
				...normalizedSettings,
			},
		});
};

export const deleteAiSettings = async (aiId: string) => {
	return db.delete(ai).where(eq(ai.aiId, aiId));
};

export const getAiEmbeddingProviderByOrganizationId = async (
	organizationId: string,
) => {
	return (
		(await db.query.aiEmbeddingProviders.findFirst({
			where: eq(aiEmbeddingProviders.organizationId, organizationId),
		})) ?? null
	);
};

export const saveAiEmbeddingProvider = async (
	organizationId: string,
	settings: any,
) => {
	const providerType =
		String(settings?.providerType ?? "").trim() || "openai_compatible";
	const apiUrl = String(settings?.apiUrl ?? "")
		.trim()
		.replace(/\/+$/, "");
	const apiKey = String(settings?.apiKey ?? "");
	const model = String(settings?.model ?? "").trim();

	if (apiUrl.length === 0 || model.length === 0) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Embedding provider apiUrl/model is required",
		});
	}

	return await db.transaction(async (tx) => {
		const [currentProvider] = await tx
			.select({
				providerType: aiEmbeddingProviders.providerType,
				apiUrl: aiEmbeddingProviders.apiUrl,
				model: aiEmbeddingProviders.model,
			})
			.from(aiEmbeddingProviders)
			.where(eq(aiEmbeddingProviders.organizationId, organizationId))
			.limit(1);

		const shouldClearStoredEmbeddings =
			!!currentProvider &&
			(currentProvider.providerType !== providerType ||
				currentProvider.apiUrl !== apiUrl ||
				currentProvider.model !== model);

		const result = await tx
			.insert(aiEmbeddingProviders)
			.values({
				organizationId,
				providerType,
				apiUrl,
				apiKey,
				model,
			})
			.onConflictDoUpdate({
				target: aiEmbeddingProviders.organizationId,
				set: {
					providerType,
					apiUrl,
					apiKey,
					model,
					updatedAt: new Date().toISOString(),
				},
			});

		if (shouldClearStoredEmbeddings) {
			await tx
				.update(aiAgentPlaybooks)
				.set({
					embeddingModel: null,
					embeddingDim: null,
					embeddingVector: null,
				})
				.where(
					and(
						eq(aiAgentPlaybooks.organizationId, organizationId),
						isNotNull(aiAgentPlaybooks.embeddingVector),
					),
				);
		}

		return result;
	});
};

export const deleteAiEmbeddingProvider = async (organizationId: string) => {
	return await db.transaction(async (tx) => {
		const result = await tx
			.delete(aiEmbeddingProviders)
			.where(eq(aiEmbeddingProviders.organizationId, organizationId));

		await tx
			.update(aiAgentPlaybooks)
			.set({
				embeddingModel: null,
				embeddingDim: null,
				embeddingVector: null,
			})
			.where(
				and(
					eq(aiAgentPlaybooks.organizationId, organizationId),
					isNotNull(aiAgentPlaybooks.embeddingVector),
				),
			);

		return result;
	});
};

export {
	type AiMcpServerTestResult,
	createAiMcpServer,
	deleteAiMcpServer,
	listAiMcpServersByOrganizationId,
	testAiMcpServer,
	updateAiMcpServer,
} from "./ai/mcp-servers";

export type AiEmbeddingProviderTestResult = {
	status: "ok" | "not_configured" | "error";
	mode: "embedding" | "local_hash";
	providerType?: string;
	model?: string;
	dim: number;
	latencyMs?: number;
	error?: string;
};

export const testAiEmbeddingProvider = async (params: {
	organizationId: string;
	text?: string;
}): Promise<AiEmbeddingProviderTestResult> => {
	const provider = await getAiEmbeddingProviderByOrganizationId(
		params.organizationId,
	);
	const text =
		String(params.text ?? "Dokploy embedding test").trim() ||
		"Dokploy embedding test";

	if (!provider) {
		return {
			status: "not_configured",
			mode: "local_hash",
			model: "hash(blake2b512)",
			dim: PLAYBOOK_HASH_DIMENSIONS,
		};
	}

	const config: EmbeddingProviderConfig = {
		providerType: provider.providerType,
		apiUrl: provider.apiUrl,
		apiKey: provider.apiKey,
		model: provider.model,
	};

	const modelId = String(config.model ?? "").trim();
	if (!modelId) {
		return {
			status: "error",
			mode: "local_hash",
			providerType: config.providerType ?? undefined,
			model: modelId,
			dim: PLAYBOOK_HASH_DIMENSIONS,
			error: "Embedding model is required",
		};
	}

	const providerClient = selectAIProvider(config) as unknown as Record<
		string,
		unknown
	>;
	const embeddingFactory =
		(providerClient as { textEmbeddingModel?: unknown }).textEmbeddingModel ??
		(providerClient as { textEmbedding?: unknown }).textEmbedding ??
		(providerClient as { embedding?: unknown }).embedding;
	if (typeof embeddingFactory !== "function") {
		return {
			status: "error",
			mode: "local_hash",
			providerType: config.providerType ?? undefined,
			model: modelId,
			dim: PLAYBOOK_HASH_DIMENSIONS,
			error: "Provider does not support text embeddings",
		};
	}

	let embeddingModel: unknown;
	try {
		embeddingModel = (embeddingFactory as (id: string) => unknown)(modelId);
	} catch (error) {
		return {
			status: "error",
			mode: "local_hash",
			providerType: config.providerType ?? undefined,
			model: modelId,
			dim: PLAYBOOK_HASH_DIMENSIONS,
			error:
				getProviderErrorText(error) || "Failed to initialize embedding model",
		};
	}

	const startedAt = Date.now();
	try {
		const res = await embed({ model: embeddingModel as never, value: text });
		const raw = (res as unknown as { embedding?: unknown }).embedding;
		if (!Array.isArray(raw)) {
			throw new Error("No embedding vector returned");
		}
		const vec = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
		if (vec.length === 0) {
			throw new Error("Empty embedding vector returned");
		}
		return {
			status: "ok",
			mode: "embedding",
			providerType: config.providerType ?? undefined,
			model: modelId,
			dim: vec.length,
			latencyMs: Date.now() - startedAt,
		};
	} catch (error) {
		return {
			status: "error",
			mode: "local_hash",
			providerType: config.providerType ?? undefined,
			model: modelId,
			dim: PLAYBOOK_HASH_DIMENSIONS,
			latencyMs: Date.now() - startedAt,
			error: getProviderErrorText(error) || "Embedding test failed",
		};
	}
};

export type AiEmbeddingProviderDiagnostics = {
	configuredProviderType: string | null;
	configuredModel: string | null;
	totalPlaybooks: number;
	embeddedPlaybooks: number;
	missingEmbeddings: number;
	modelBreakdown: Array<{
		model: string | null;
		count: number;
	}>;
	dimensionBreakdown: Array<{
		dim: number | null;
		count: number;
	}>;
	hasStoredEmbeddings: boolean;
	hasPartialEmbeddings: boolean;
	hasMixedModels: boolean;
	hasMixedDimensions: boolean;
	hasConfiguredModelMismatch: boolean;
};

const toDiagnosticCount = (value: unknown) => {
	const numeric = Number(value ?? 0);
	return Number.isFinite(numeric) ? numeric : 0;
};

export const getAiEmbeddingProviderDiagnostics = async (
	organizationId: string,
): Promise<AiEmbeddingProviderDiagnostics> => {
	const provider = await getAiEmbeddingProviderByOrganizationId(organizationId);
	const [totals] = await db
		.select({
			totalPlaybooks: sql<number>`count(*)`,
			embeddedPlaybooks: sql<number>`count(*) filter (where ${aiAgentPlaybooks.embeddingVector} is not null)`,
			missingEmbeddings: sql<number>`count(*) filter (where ${aiAgentPlaybooks.embeddingVector} is null)`,
		})
		.from(aiAgentPlaybooks)
		.where(eq(aiAgentPlaybooks.organizationId, organizationId));

	const [modelRows, dimensionRows] = await Promise.all([
		db
			.select({
				model: aiAgentPlaybooks.embeddingModel,
				count: sql<number>`count(*)`,
			})
			.from(aiAgentPlaybooks)
			.where(
				and(
					eq(aiAgentPlaybooks.organizationId, organizationId),
					isNotNull(aiAgentPlaybooks.embeddingVector),
				),
			)
			.groupBy(aiAgentPlaybooks.embeddingModel),
		db
			.select({
				dim: aiAgentPlaybooks.embeddingDim,
				count: sql<number>`count(*)`,
			})
			.from(aiAgentPlaybooks)
			.where(
				and(
					eq(aiAgentPlaybooks.organizationId, organizationId),
					isNotNull(aiAgentPlaybooks.embeddingVector),
				),
			)
			.groupBy(aiAgentPlaybooks.embeddingDim),
	]);

	const modelBreakdown = modelRows
		.map((row) => ({
			model: row.model ?? null,
			count: toDiagnosticCount(row.count),
		}))
		.sort(
			(left, right) =>
				right.count - left.count ||
				String(left.model ?? "").localeCompare(String(right.model ?? "")),
		);

	const dimensionBreakdown = dimensionRows
		.map((row) => ({
			dim: row.dim ?? null,
			count: toDiagnosticCount(row.count),
		}))
		.sort((left, right) => {
			if (right.count !== left.count) return right.count - left.count;
			if (left.dim === null) return 1;
			if (right.dim === null) return -1;
			return left.dim - right.dim;
		});

	const configuredModel = String(provider?.model ?? "").trim() || null;
	const embeddedPlaybooks = toDiagnosticCount(totals?.embeddedPlaybooks);
	const missingEmbeddings = toDiagnosticCount(totals?.missingEmbeddings);

	return {
		configuredProviderType: provider?.providerType ?? null,
		configuredModel,
		totalPlaybooks: toDiagnosticCount(totals?.totalPlaybooks),
		embeddedPlaybooks,
		missingEmbeddings,
		modelBreakdown,
		dimensionBreakdown,
		hasStoredEmbeddings: embeddedPlaybooks > 0,
		hasPartialEmbeddings: embeddedPlaybooks > 0 && missingEmbeddings > 0,
		hasMixedModels: modelBreakdown.length > 1,
		hasMixedDimensions: dimensionBreakdown.length > 1,
		hasConfiguredModelMismatch:
			configuredModel !== null &&
			modelBreakdown.some(
				(row) => String(row.model ?? "").trim() !== configuredModel,
			),
	};
};
const resolveEmbeddingProviderConfig = async (params: {
	organizationId: string;
	aiSettings: {
		apiUrl: string;
		apiKey: string;
		providerType?: string | null;
		embeddingModel?: string | null;
		embeddingProviderType?: string | null;
		embeddingApiUrl?: string | null;
		embeddingApiKey?: string | null;
	};
}): Promise<EmbeddingProviderConfig | null> => {
	const orgProvider = await getAiEmbeddingProviderByOrganizationId(
		params.organizationId,
	);
	if (orgProvider) {
		return {
			providerType: orgProvider.providerType,
			apiUrl: orgProvider.apiUrl,
			apiKey: orgProvider.apiKey,
			model: orgProvider.model,
		};
	}

	const overrideModel = String(params.aiSettings.embeddingModel ?? "").trim();
	if (overrideModel.length > 0) {
		const overrideApiUrl = String(params.aiSettings.embeddingApiUrl ?? "")
			.trim()
			.replace(/\/+$/, "");
		const hasOverrideApiUrl = overrideApiUrl.length > 0;
		return {
			providerType:
				params.aiSettings.embeddingProviderType ??
				params.aiSettings.providerType,
			apiUrl: hasOverrideApiUrl ? overrideApiUrl : params.aiSettings.apiUrl,
			apiKey: hasOverrideApiUrl
				? String(params.aiSettings.embeddingApiKey ?? "")
				: params.aiSettings.apiKey,
			model: overrideModel,
		};
	}

	return null;
};

interface Props {
	organizationId: string;
	aiId: string;
	input: string;
	serverId?: string | undefined;
}

export const suggestVariants = async ({
	organizationId,
	aiId,
	input,
	serverId,
}: Props) => {
	try {
		const aiSettings = await getAiSettingById(aiId);
		if (!aiSettings || !aiSettings.isEnabled) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "AI features are not enabled for this configuration",
			});
		}

		const provider = selectAIProvider(aiSettings);
		const model = provider(aiSettings.model);
		const providerOptions = getOpenAIResponsesProviderOptions(aiSettings);

		let ip = "";
		if (!IS_CLOUD) {
			const organization = await findOrganizationById(organizationId);
			ip = organization?.owner.serverIp || "";
		}

		if (serverId) {
			const server = await findServerById(serverId);
			ip = server.ipAddress;
		} else if (process.env.NODE_ENV === "development") {
			ip = "127.0.0.1";
		}

		const { object } = await generateObject({
			model,
			providerOptions,
			output: "object",
			schema: z.object({
				suggestions: z.array(
					z.object({
						id: z.string(),
						name: z.string(),
						shortDescription: z.string(),
						description: z.string(),
					}),
				),
			}),
			prompt: `Suggest up to 3 open-source projects that match the user's needs.

Return JSON only:
{"suggestions":[{"id":"project-slug","name":"Project Name","shortDescription":"1-line summary","description":"Plain text description"}]}

Rules:
- id: lowercase slug with hyphens
- shortDescription: single line, main technologies
- description: plain text only (no code/config/install steps)
- Must be docker + docker-compose deployable

User request:
${input}`,
		});

		if (object?.suggestions?.length) {
			const result = [];
			for (const suggestion of object.suggestions) {
				try {
					const { object: docker } = await generateObject({
						model,
						providerOptions,
						output: "object",
						schema: z.object({
							dockerCompose: z.string(),
							envVariables: z.array(
								z.object({
									name: z.string(),
									value: z.string(),
								}),
							),
							domains: z.array(
								z.object({
									host: z.string(),
									port: z.number(),
									serviceName: z.string(),
								}),
							),
							configFiles: z
								.array(
									z.object({
										content: z.string(),
										filePath: z.string(),
									}),
								)
								.optional(),
						}),
						prompt: `Generate a docker-compose.yml plus env vars and domain configs to install the project.

Return JSON only:
{"dockerCompose":"<yaml>","envVariables":[{"name":"VAR","value":"example"}],"domains":[{"host":"domain","port":3000,"serviceName":"service"}],"configFiles":[{"content":"...","filePath":"..."}]}

Rules:
- dockerCompose: no "version", no "container_name"; use ports like "3000" (no host:container); include all required dependency services.
- Variables: in dockerCompose use \${VAR-default}; in envVariables use concrete example values (no \${...}); list every referenced VAR exactly once.
- configFiles: omit unless strictly required; prefer env vars; if used, keep minimal and mount from ../files/<folder>.
- domains: for each public service add {host:"{service}-{hex3}-${ip ? ip.replaceAll(".", "-") : ""}.traefik.me", port:<internal>, serviceName:<service>}.

Project details:
${suggestion?.description}`,
					});
					if (!!docker && !!docker.dockerCompose) {
						result.push({
							...suggestion,
							...docker,
						});
					}
				} catch (error) {
					console.error("Error in docker compose generation:", error);
				}
			}

			return result;
		}

		throw new TRPCError({
			code: "NOT_FOUND",
			message: "No suggestions found",
		});
	} catch (error) {
		console.error("Error in suggestVariants:", error);
		throw error;
	}
};

// ============================================
// Conversation Management
// ============================================

export const createConversation = async (params: {
	organizationId: string;
	userId: string;
	aiId?: string;
	title?: string;
	projectId?: string;
	serverId?: string;
	uiLocale?: string;
}) => {
	const normalizedAiId =
		typeof params.aiId === "string" && params.aiId.trim().length > 0
			? params.aiId
			: undefined;
	const uiLocale = normalizeUiLocale(params.uiLocale);

	if (normalizedAiId) {
		const existingAi = await db.query.ai.findFirst({
			where: and(
				eq(ai.aiId, normalizedAiId),
				eq(ai.organizationId, params.organizationId),
			),
		});
		if (!existingAi) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "AI settings not found",
			});
		}
	}

	const [conversation] = await db
		.insert(aiConversations)
		.values({
			organizationId: params.organizationId,
			userId: params.userId,
			aiId: normalizedAiId,
			title: params.title || "New Conversation",
			projectId: params.projectId,
			serverId: params.serverId,
			metadata: {
				toolApprovalsDisabled: true,
				...(uiLocale ? { uiLocale } : {}),
			},
		})
		.returning();
	return conversation;
};

export const getConversationById = async (conversationId: string) => {
	const conversation = await db.query.aiConversations.findFirst({
		where: eq(aiConversations.conversationId, conversationId),
		with: {
			messages: {
				orderBy: desc(aiMessages.createdAt),
				limit: 50,
			},
		},
	});
	if (!conversation) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Conversation not found",
		});
	}
	return conversation;
};

export const getConversationIdForToolExecution = async (
	executionId: string,
): Promise<string | null> => {
	const normalizedExecutionId = executionId.trim();
	if (normalizedExecutionId.length === 0) return null;

	const execution = await db.query.aiToolExecutions.findFirst({
		where: eq(aiToolExecutions.executionId, normalizedExecutionId),
		columns: {
			conversationId: true,
			messageId: true,
			runId: true,
		},
	});

	if (!execution) return null;
	if (execution.conversationId) return execution.conversationId;

	if (execution.messageId) {
		const message = await db.query.aiMessages.findFirst({
			where: eq(aiMessages.messageId, execution.messageId),
			columns: {
				conversationId: true,
			},
		});
		return message?.conversationId ?? null;
	}

	if (execution.runId) {
		const run = await db.query.aiRuns.findFirst({
			where: eq(aiRuns.runId, execution.runId),
			columns: {
				conversationId: true,
			},
		});
		return run?.conversationId ?? null;
	}

	return null;
};

export const listConversations = async (params: {
	organizationId: string;
	userId: string;
	projectId?: string;
	serverId?: string | null;
	status?: "active" | "archived";
	limit?: number;
	offset?: number;
}) => {
	const conditions = [
		eq(aiConversations.organizationId, params.organizationId),
		eq(aiConversations.userId, params.userId),
	];

	if (params.projectId) {
		conditions.push(eq(aiConversations.projectId, params.projectId));
	}
	if (params.serverId === null) {
		conditions.push(isNull(aiConversations.serverId));
	} else if (
		typeof params.serverId === "string" &&
		params.serverId.length > 0
	) {
		conditions.push(eq(aiConversations.serverId, params.serverId));
	}
	if (params.status) {
		conditions.push(eq(aiConversations.status, params.status));
	}

	const conversations = await db.query.aiConversations.findMany({
		where: and(...conditions),
		orderBy: desc(aiConversations.updatedAt),
		limit: params.limit || 20,
		offset: params.offset || 0,
	});
	return conversations;
};

export const getConversationIndicators = async (params: {
	organizationId: string;
	userId: string;
	conversationIds: string[];
}) => {
	const ids = Array.from(
		new Set(
			(params.conversationIds || [])
				.map((id) => (typeof id === "string" ? id.trim() : ""))
				.filter((id) => id.length > 0),
		),
	).slice(0, 100);
	if (ids.length === 0) return {};

	const conversations = await db.query.aiConversations.findMany({
		where: and(
			eq(aiConversations.organizationId, params.organizationId),
			eq(aiConversations.userId, params.userId),
			inArray(aiConversations.conversationId, ids),
		),
		columns: {
			conversationId: true,
		},
	});

	const allowedIds = conversations
		.map((c) => c.conversationId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (allowedIds.length === 0) return {};

	const sendingAssistantMessages = await db.query.aiDisplayMessages.findMany({
		where: and(
			inArray(aiDisplayMessages.conversationId, allowedIds),
			eq(aiDisplayMessages.role, "assistant"),
			eq(aiDisplayMessages.status, "sending"),
		),
		columns: {
			conversationId: true,
		},
	});
	const sendingByConversationId = new Set(
		sendingAssistantMessages
			.map((row) => row.conversationId)
			.filter((id): id is string => typeof id === "string" && id.length > 0),
	);

	const runningRuns = await db.query.aiRuns.findMany({
		where: and(
			inArray(aiRuns.conversationId, allowedIds),
			inArray(aiRuns.status, ["pending", "planning", "executing", "verifying"]),
		),
		columns: {
			conversationId: true,
		},
	});
	const runningByConversationId = new Set(
		runningRuns
			.map((row) => row.conversationId)
			.filter((id): id is string => typeof id === "string" && id.length > 0),
	);

	const waitingApprovalRuns = await db.query.aiRuns.findMany({
		where: and(
			inArray(aiRuns.conversationId, allowedIds),
			eq(aiRuns.status, "waiting_approval"),
		),
		columns: {
			conversationId: true,
		},
	});
	const pendingApprovalByConversationId = new Set(
		waitingApprovalRuns
			.map((row) => row.conversationId)
			.filter((id): id is string => typeof id === "string" && id.length > 0),
	);

	const pendingApprovalExecutions = await db.query.aiToolExecutions.findMany({
		where: and(
			inArray(aiToolExecutions.conversationId, allowedIds),
			eq(aiToolExecutions.requiresApproval, true),
			eq(aiToolExecutions.status, "pending"),
		),
		columns: {
			conversationId: true,
		},
	});
	for (const row of pendingApprovalExecutions) {
		const conversationId = row.conversationId;
		if (typeof conversationId === "string" && conversationId.length > 0) {
			pendingApprovalByConversationId.add(conversationId);
		}
	}

	return Object.fromEntries(
		allowedIds.map((conversationId) => {
			const hasPendingApproval =
				pendingApprovalByConversationId.has(conversationId);
			const isRunning =
				!hasPendingApproval &&
				(sendingByConversationId.has(conversationId) ||
					runningByConversationId.has(conversationId));
			return [conversationId, { isRunning, hasPendingApproval }] as const;
		}),
	);
};

export const updateConversation = async (
	conversationId: string,
	data: {
		title?: string;
		status?: "active" | "archived";
		metadata?: Record<string, unknown>;
	},
) => {
	const updates: Partial<typeof aiConversations.$inferInsert> & {
		updatedAt: string;
	} = {
		updatedAt: new Date().toISOString(),
	};
	if (data.title !== undefined) updates.title = data.title;
	if (data.status !== undefined) updates.status = data.status;
	if (data.metadata !== undefined) updates.metadata = data.metadata;

	const [updated] = await db
		.update(aiConversations)
		.set(updates)
		.where(eq(aiConversations.conversationId, conversationId))
		.returning();
	return updated;
};

const scheduleConversationSummaryUpdate = (params: {
	conversationId: string;
	model: unknown;
	providerOptions?: typeof OPENAI_RESPONSES_PROVIDER_OPTIONS;
	maxMessages?: number;
}) => {
	void (async () => {
		try {
			const conversation = await getConversationById(params.conversationId);
			const existingSummary =
				conversation.metadata &&
				typeof conversation.metadata === "object" &&
				"summary" in conversation.metadata &&
				typeof (conversation.metadata as { summary?: unknown }).summary ===
					"string"
					? String((conversation.metadata as { summary?: unknown }).summary)
					: "";
			const uiLocale = getUiLocaleFromMetadata(conversation.metadata);

			const history = await getMessages({
				conversationId: params.conversationId,
				limit: params.maxMessages ?? 20,
			});

			const transcript = history
				.map((m) => {
					const content = (m.content || "").trim();
					if (content.length > 0) return `${m.role}: ${content}`;
					if (m.toolCalls && m.toolCalls.length > 0) {
						const tools = m.toolCalls
							.map((tc) => tc.function?.name)
							.filter(Boolean)
							.join(", ");
						return `${m.role}: [tool_calls: ${tools}]`;
					}
					return `${m.role}:`;
				})
				.join("\n");

			const summaryText = await generatePromptText({
				model: params.model as any,
				providerOptions: params.providerOptions,
				prompt: `Update the conversation memory summary.

Rules:
- Output max 10 lines. ${buildReplyLanguageInstruction(uiLocale)}
- Keep stable facts, user preferences, chosen project/server context, and decisions.
- No secrets.

Existing summary:
${existingSummary || "(none)"}

Recent conversation (most recent last):
${transcript}

Return ONLY the updated summary.`,
				maxOutputTokens: 220,
			});

			const nextSummary = summaryText.trim();
			if (!nextSummary) return;

			await updateConversation(params.conversationId, {
				metadata: {
					...(typeof conversation.metadata === "object" && conversation.metadata
						? conversation.metadata
						: {}),
					summary: nextSummary,
				},
			});
		} catch {
			// Ignore summary errors
		}
	})();
};

export const deleteConversation = async (conversationId: string) => {
	await db
		.delete(aiConversations)
		.where(eq(aiConversations.conversationId, conversationId));
};

// ============================================
// Message Management
// ============================================

export const getMessages = async (params: {
	conversationId: string;
	limit?: number;
	before?: string;
	beforeMessageId?: string;
}) => {
	const conditions: Array<ReturnType<typeof eq> | undefined> = [
		eq(aiMessages.conversationId, params.conversationId),
	];
	if (params.before) {
		const beforeMessageId =
			typeof params.beforeMessageId === "string"
				? params.beforeMessageId.trim()
				: "";
		if (beforeMessageId.length > 0) {
			conditions.push(
				or(
					lt(aiMessages.createdAt, params.before),
					and(
						eq(aiMessages.createdAt, params.before),
						lt(aiMessages.messageId, beforeMessageId),
					),
				),
			);
		} else {
			conditions.push(lt(aiMessages.createdAt, params.before));
		}
	}

	const messages = await db.query.aiMessages.findMany({
		where: and(...conditions),
		orderBy: [desc(aiMessages.createdAt), desc(aiMessages.messageId)],
		limit: params.limit || 50,
	});
	return messages.reverse();
};

export const getDisplayMessages = async (params: {
	conversationId: string;
	limit?: number;
	before?: string;
	beforeMessageId?: string;
}) => {
	const conditions: Array<ReturnType<typeof eq> | undefined> = [
		eq(aiDisplayMessages.conversationId, params.conversationId),
	];
	if (params.before) {
		const beforeMessageId =
			typeof params.beforeMessageId === "string"
				? params.beforeMessageId.trim()
				: "";
		if (beforeMessageId.length > 0) {
			conditions.push(
				or(
					lt(aiDisplayMessages.createdAt, params.before),
					and(
						eq(aiDisplayMessages.createdAt, params.before),
						lt(aiDisplayMessages.messageId, beforeMessageId),
					),
				),
			);
		} else {
			conditions.push(lt(aiDisplayMessages.createdAt, params.before));
		}
	}

	const messages = await db.query.aiDisplayMessages.findMany({
		where: and(...conditions),
		orderBy: [
			desc(aiDisplayMessages.createdAt),
			desc(aiDisplayMessages.messageId),
		],
		limit: params.limit || 50,
	});
	const rawMessages = await getMessages(params);
	if (rawMessages.length === 0) return messages.reverse();

	const mergedById = new Map(
		messages.map((message) => [message.messageId, message] as const),
	);
	let didRepair = false;
	for (const rawMessage of rawMessages) {
		if (rawMessage.role === "system") continue;
		const inferredIdentity = inferDisplayMessageIdentity(rawMessage);
		const existing = mergedById.get(rawMessage.messageId);
		if (!existing) {
			const snapshot = await syncDisplayMessageFromRawMessage(
				rawMessage,
				inferredIdentity,
			);
			if (!snapshot) continue;
			mergedById.set(snapshot.messageId, snapshot);
			didRepair = true;
			continue;
		}
		const repairedToolCalls = buildDisplayToolCalls({
			toolCalls: rawMessage.toolCalls,
		});
		const normalizedContent =
			normalizeAssistantMessageContent(
				rawMessage.role,
				rawMessage.content ?? null,
			) ?? null;
		const needsKindRepair =
			inferredIdentity.kind === "agent" &&
			existing.kind !== inferredIdentity.kind;
		const needsRunIdRepair =
			inferredIdentity.kind === "agent" &&
			normalizeDisplayMessageRunId(existing.runId) !== inferredIdentity.runId;
		const needsSourceMessageRepair =
			typeof existing.sourceMessageId !== "string" ||
			existing.sourceMessageId.trim().length === 0;
		const needsToolCallsRepair =
			(!Array.isArray(existing.toolCalls) || existing.toolCalls.length === 0) &&
			Array.isArray(repairedToolCalls) &&
			repairedToolCalls.length > 0;
		const needsContentRepair =
			rawMessage.role === "assistant" &&
			normalizedContent !== (existing.content ?? null);
		if (
			!needsKindRepair &&
			!needsRunIdRepair &&
			!needsSourceMessageRepair &&
			!needsToolCallsRepair &&
			!needsContentRepair
		) {
			continue;
		}
		const repaired = await upsertDisplayMessageSnapshot({
			messageId: existing.messageId,
			conversationId: rawMessage.conversationId,
			role: rawMessage.role,
			...(needsSourceMessageRepair
				? { sourceMessageId: rawMessage.messageId }
				: {}),
			...(needsRunIdRepair ? { runId: inferredIdentity.runId } : {}),
			...(needsKindRepair ? { kind: inferredIdentity.kind } : {}),
			...(needsToolCallsRepair ? { toolCalls: repairedToolCalls } : {}),
			...(needsContentRepair ? { content: normalizedContent } : {}),
			createdAt: rawMessage.createdAt,
		});
		if (!repaired) continue;
		mergedById.set(repaired.messageId, repaired);
		didRepair = true;
	}
	const didRepairFromEvents = await repairAgentDisplayMessagesFromEvents({
		conversationId: params.conversationId,
		rawMessages,
		mergedById,
	});
	if (!didRepair && !didRepairFromEvents) return messages.reverse();

	return Array.from(mergedById.values()).sort((left, right) => {
		const leftTime = Date.parse(left.createdAt ?? "");
		const rightTime = Date.parse(right.createdAt ?? "");
		if (
			Number.isFinite(leftTime) &&
			Number.isFinite(rightTime) &&
			leftTime !== rightTime
		) {
			return leftTime - rightTime;
		}
		return left.messageId.localeCompare(right.messageId);
	});
};

export const getAgentEventMessages = async (params: {
	conversationId: string;
	runId: string;
	limit?: number;
	before?: string;
	beforeMessageId?: string;
}) => {
	const maxLimit = 500;
	const limit = Math.max(1, Math.min(params.limit ?? 200, maxLimit));
	const batchSize = Math.min(500, Math.max(50, limit * 5));
	const runId = params.runId.trim();
	if (runId.length === 0)
		return { messages: [] as AiMessageRow[], nextCursor: null };

	let before = typeof params.before === "string" ? params.before : undefined;
	let beforeMessageId =
		typeof params.beforeMessageId === "string"
			? params.beforeMessageId.trim()
			: "";

	const matchedDesc: AiMessageRow[] = [];
	let nextCursor: { before: string; beforeMessageId: string } | null = null;

	for (let page = 0; page < 10 && matchedDesc.length < limit; page++) {
		const conditions: Array<ReturnType<typeof eq> | undefined> = [
			eq(aiMessages.conversationId, params.conversationId),
			eq(aiMessages.role, "system"),
		];
		if (before) {
			if (beforeMessageId.length > 0) {
				conditions.push(
					or(
						lt(aiMessages.createdAt, before),
						and(
							eq(aiMessages.createdAt, before),
							lt(aiMessages.messageId, beforeMessageId),
						),
					),
				);
			} else {
				conditions.push(lt(aiMessages.createdAt, before));
			}
		}

		const batch = await db.query.aiMessages.findMany({
			where: and(...conditions),
			orderBy: [desc(aiMessages.createdAt), desc(aiMessages.messageId)],
			limit: batchSize,
		});
		if (batch.length === 0) break;

		for (const msg of batch) {
			if (matchedDesc.length >= limit) break;
			const content = typeof msg.content === "string" ? msg.content : "";
			if (!content) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(content);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			const type = typeof parsed.type === "string" ? parsed.type : "";
			if (!type.startsWith("agent.")) continue;
			const messageRunId =
				typeof parsed.runId === "string" ? parsed.runId.trim() : "";
			if (messageRunId !== runId) continue;
			matchedDesc.push(msg);
		}

		const last = batch[batch.length - 1];
		if (!last) break;
		nextCursor = { before: last.createdAt, beforeMessageId: last.messageId };
		before = last.createdAt;
		beforeMessageId = last.messageId;

		if (batch.length < batchSize) break;
	}

	return { messages: matchedDesc.reverse(), nextCursor };
};

type DisplayToolCallStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "executing"
	| "completed"
	| "failed";

type DisplayMessageStatus = "sending" | "sent" | "stopped" | "error";
type DisplayMessageKind = "message" | "agent";
type DisplayToolCall = NonNullable<AiDisplayMessageRow["toolCalls"]>[number];
type DisplayToolCallResult = DisplayToolCall["result"];

async function listAgentEventPayloads(params: {
	conversationId: string;
	runId: string;
	maxEvents?: number;
}): Promise<ParsedAgentEventMessage[]> {
	const runId = params.runId.trim();
	if (runId.length === 0) return [];
	const maxEvents = Math.max(1, Math.min(params.maxEvents ?? 2000, 5000));
	const batchSize = Math.min(500, Math.max(100, Math.min(maxEvents, 500)));
	let before: string | undefined;
	let beforeMessageId = "";
	const matchedDesc: ParsedAgentEventMessage[] = [];

	for (let page = 0; page < 30 && matchedDesc.length < maxEvents; page++) {
		const conditions: Array<ReturnType<typeof eq> | undefined> = [
			eq(aiMessages.conversationId, params.conversationId),
			eq(aiMessages.role, "system"),
		];
		if (before) {
			if (beforeMessageId.length > 0) {
				conditions.push(
					or(
						lt(aiMessages.createdAt, before),
						and(
							eq(aiMessages.createdAt, before),
							lt(aiMessages.messageId, beforeMessageId),
						),
					),
				);
			} else {
				conditions.push(lt(aiMessages.createdAt, before));
			}
		}

		const batch = await db.query.aiMessages.findMany({
			where: and(...conditions),
			orderBy: [desc(aiMessages.createdAt), desc(aiMessages.messageId)],
			limit: batchSize,
		});
		if (batch.length === 0) break;

		for (const msg of batch) {
			if (matchedDesc.length >= maxEvents) break;
			const content = typeof msg.content === "string" ? msg.content : "";
			if (!content) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(content);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			const type = typeof parsed.type === "string" ? parsed.type : "";
			if (!type.startsWith("agent.")) continue;
			const messageRunId =
				typeof parsed.runId === "string" ? parsed.runId.trim() : "";
			if (messageRunId !== runId) continue;
			matchedDesc.push({
				messageId: msg.messageId,
				createdAt: msg.createdAt,
				payload: parsed,
			});
		}

		const last = batch[batch.length - 1];
		if (!last) break;
		before = last.createdAt;
		beforeMessageId = last.messageId;
		if (batch.length < batchSize) break;
	}

	return matchedDesc.reverse();
}

function normalizeDisplayMessageRunId(
	value: string | null | undefined,
): string | null {
	const normalized = typeof value === "string" ? value.trim() : "";
	return normalized.length > 0 ? normalized : null;
}

function inferAgentRunIdFromMessageId(messageId: string): string | null {
	const normalized = typeof messageId === "string" ? messageId.trim() : "";
	const prefix = "agent-run-";
	if (!normalized.startsWith(prefix)) return null;
	const runId = normalized.slice(prefix.length).trim();
	return runId.length > 0 ? runId : null;
}

function inferDisplayMessageIdentity(
	message: Pick<AiMessageRow, "messageId" | "role">,
	overrides: { kind?: DisplayMessageKind; runId?: string | null } = {},
): { kind: DisplayMessageKind; runId: string | null } {
	const explicitRunId = normalizeDisplayMessageRunId(overrides.runId);
	const inferredRunId =
		message.role === "assistant"
			? inferAgentRunIdFromMessageId(message.messageId)
			: null;
	if (overrides.kind) {
		return {
			kind: overrides.kind,
			runId:
				explicitRunId ?? (overrides.kind === "agent" ? inferredRunId : null),
		};
	}
	const runId = explicitRunId ?? inferredRunId;
	if (runId) {
		return { kind: "agent", runId };
	}
	return { kind: "message", runId: null };
}
const ASSISTANT_TOOL_MARKER_PREFIX = "<<tool:";
const ASSISTANT_TOOL_MARKER_SUFFIX = ">>";

function stripAssistantToolMarkers(value: string): string {
	if (value.length === 0) return value;
	let output = "";
	let cursor = 0;
	while (cursor < value.length) {
		const markerIndex = value.indexOf(ASSISTANT_TOOL_MARKER_PREFIX, cursor);
		if (markerIndex === -1) {
			output += value.slice(cursor);
			break;
		}
		output += value.slice(cursor, markerIndex);
		const markerEnd = value.indexOf(
			ASSISTANT_TOOL_MARKER_SUFFIX,
			markerIndex + ASSISTANT_TOOL_MARKER_PREFIX.length,
		);
		if (markerEnd === -1) break;
		cursor = markerEnd + ASSISTANT_TOOL_MARKER_SUFFIX.length;
	}
	const maxPrefixLength = Math.min(
		output.length,
		ASSISTANT_TOOL_MARKER_PREFIX.length - 1,
	);
	for (let len = maxPrefixLength; len >= 2; len--) {
		if (!ASSISTANT_TOOL_MARKER_PREFIX.startsWith(output.slice(-len))) continue;
		return output.slice(0, -len);
	}
	return output;
}

function normalizeAssistantMessageContent(
	role: "user" | "assistant" | "system" | "tool" | undefined,
	content: string | null | undefined,
): string | null | undefined {
	if (role !== "assistant") return content;
	if (typeof content !== "string") return content;
	return stripAssistantToolMarkers(content);
}

function extractExecutionIdFromToolResultValue(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const direct = (value as { executionId?: unknown }).executionId;
	if (typeof direct === "string" && direct.trim().length > 0) {
		return direct.trim();
	}
	const nested = (value as { data?: unknown }).data;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		const inner = (nested as { executionId?: unknown }).executionId;
		if (typeof inner === "string" && inner.trim().length > 0) {
			return inner.trim();
		}
	}
	return "";
}

function buildDisplayToolCalls(params: {
	toolCalls: AiMessageRow["toolCalls"] | null | undefined;
	toolResults?: unknown[];
}): AiDisplayMessageRow["toolCalls"] {
	const toolCalls = Array.isArray(params.toolCalls) ? params.toolCalls : [];
	const toolResults = Array.isArray(params.toolResults)
		? params.toolResults
		: [];
	if (toolCalls.length === 0) return null;

	const resultByToolCallId = new Map<string, unknown>();
	for (const entry of toolResults) {
		if (!entry || typeof entry !== "object") continue;
		const toolCallId =
			(entry as { toolCallId?: unknown }).toolCallId ??
			(entry as { id?: unknown }).id;
		if (typeof toolCallId !== "string" || toolCallId.trim().length === 0)
			continue;
		const resultValue =
			(entry as { result?: unknown }).result ??
			(entry as { output?: unknown }).output ??
			entry;
		resultByToolCallId.set(toolCallId.trim(), resultValue);
	}

	return toolCalls.map((toolCall) => {
		const resultValue = resultByToolCallId.get(toolCall.id);
		let status: DisplayToolCallStatus | undefined = resultValue
			? "completed"
			: "executing";
		let executionId =
			typeof toolCall.executionId === "string"
				? toolCall.executionId.trim()
				: "";
		let result: DisplayToolCallResult | undefined;

		if (
			resultValue &&
			typeof resultValue === "object" &&
			!Array.isArray(resultValue)
		) {
			const record = resultValue as {
				success?: unknown;
				message?: unknown;
				data?: unknown;
				error?: unknown;
				status?: unknown;
			};
			const nextExecutionId = extractExecutionIdFromToolResultValue(record);
			if (nextExecutionId.length > 0) executionId = nextExecutionId;
			if (
				record.status === "pending_approval" &&
				extractExecutionIdFromToolResultValue(record).length > 0
			) {
				status = "pending";
				result = {
					success: true,
					message:
						typeof record.message === "string" ? record.message : undefined,
					data: record.data,
				};
			} else if (typeof record.success === "boolean") {
				status = record.success ? "completed" : "failed";
				result = {
					success: record.success,
					message:
						typeof record.message === "string" ? record.message : undefined,
					data: record.data,
					error: typeof record.error === "string" ? record.error : undefined,
				};
			}
		}

		return {
			id: toolCall.id,
			type: toolCall.type,
			status,
			executionId: executionId || undefined,
			result,
			function: toolCall.function,
		};
	});
}

async function upsertDisplayMessageSnapshot(params: {
	messageId: string;
	conversationId: string;
	role: "user" | "assistant" | "system" | "tool";
	content?: string | null;
	reasoning?: string | null;
	attachments?: AiDisplayMessageRow["attachments"] | null;
	toolCalls?: AiDisplayMessageRow["toolCalls"] | null;
	status?: DisplayMessageStatus;
	error?: string | null;
	kind?: DisplayMessageKind;
	runId?: string | null;
	sourceMessageId?: string | null;
	createdAt?: string;
}) {
	if (params.role === "system") return null;
	const messageId =
		typeof params.messageId === "string" ? params.messageId.trim() : "";
	const conversationId =
		typeof params.conversationId === "string"
			? params.conversationId.trim()
			: "";
	if (messageId.length === 0 || conversationId.length === 0) return null;
	const now = new Date().toISOString();
	const insertValue = {
		messageId,
		conversationId,
		sourceMessageId:
			typeof params.sourceMessageId === "string" &&
			params.sourceMessageId.trim().length > 0
				? params.sourceMessageId.trim()
				: null,
		runId:
			typeof params.runId === "string" && params.runId.trim().length > 0
				? params.runId.trim()
				: null,
		role: params.role,
		kind: params.kind ?? "message",
		content: params.content ?? null,
		reasoning: params.reasoning ?? null,
		attachments: params.attachments ?? null,
		toolCalls: params.toolCalls ?? null,
		status: params.status ?? "sent",
		error: params.error ?? null,
		createdAt:
			typeof params.createdAt === "string" && params.createdAt.trim().length > 0
				? params.createdAt
				: now,
		updatedAt: now,
	};
	const updateValue = {
		conversationId: insertValue.conversationId,
		role: insertValue.role,
		updatedAt: insertValue.updatedAt,
		...(params.sourceMessageId !== undefined
			? { sourceMessageId: insertValue.sourceMessageId }
			: {}),
		...(params.runId !== undefined ? { runId: insertValue.runId } : {}),
		...(params.kind !== undefined ? { kind: insertValue.kind } : {}),
		...(params.content !== undefined ? { content: insertValue.content } : {}),
		...(params.reasoning !== undefined
			? { reasoning: insertValue.reasoning }
			: {}),
		...(params.attachments !== undefined
			? { attachments: insertValue.attachments }
			: {}),
		...(params.toolCalls !== undefined
			? { toolCalls: insertValue.toolCalls }
			: {}),
		...(params.status !== undefined ? { status: insertValue.status } : {}),
		...(params.error !== undefined ? { error: insertValue.error } : {}),
	};
	const [snapshot] = await db
		.insert(aiDisplayMessages)
		.values(insertValue)
		.onConflictDoUpdate({
			target: aiDisplayMessages.messageId,
			set: updateValue,
		})
		.returning();
	return snapshot;
}

async function syncDisplayMessageFromRawMessage(
	message: AiMessageRow | undefined,
	overrides: {
		reasoning?: string | null;
		status?: DisplayMessageStatus;
		error?: string | null;
		kind?: DisplayMessageKind;
		runId?: string | null;
		toolResults?: unknown[];
	} = {},
) {
	if (!message || message.role === "system") return null;
	const identity = inferDisplayMessageIdentity(message, overrides);
	return upsertDisplayMessageSnapshot({
		messageId: message.messageId,
		conversationId: message.conversationId,
		sourceMessageId: message.messageId,
		runId: identity.runId,
		role: message.role,
		kind: identity.kind,
		content:
			normalizeAssistantMessageContent(message.role, message.content ?? null) ??
			null,
		reasoning: overrides.reasoning ?? null,
		attachments: message.attachments ?? null,
		toolCalls: buildDisplayToolCalls({
			toolCalls: message.toolCalls,
			toolResults: overrides.toolResults,
		}),
		status: overrides.status ?? "sent",
		error: overrides.error ?? null,
		createdAt: message.createdAt,
	});
}

async function repairAgentDisplayMessagesFromEvents(params: {
	conversationId: string;
	rawMessages: AiMessageRow[];
	mergedById: Map<string, AiDisplayMessageRow>;
}): Promise<boolean> {
	const candidates = Array.from(params.mergedById.values()).filter(
		(message) => {
			if (message.role !== "assistant") return false;
			if (message.kind !== "agent") return false;
			return normalizeDisplayMessageRunId(message.runId) !== null;
		},
	);
	if (candidates.length === 0) return false;

	const runIds = Array.from(
		new Set(
			candidates
				.map((message) => normalizeDisplayMessageRunId(message.runId))
				.filter(
					(runId): runId is string =>
						typeof runId === "string" && runId.length > 0,
				),
		),
	);
	if (runIds.length === 0) return false;

	const eventEntries = await Promise.all(
		runIds.map(async (runId) => {
			const events = await listAgentEventPayloads({
				conversationId: params.conversationId,
				runId,
				maxEvents: 2000,
			});
			return [runId, events] as const;
		}),
	);
	const eventMessagesByRunId = new Map(eventEntries);
	const rawMessagesById = new Map(
		params.rawMessages.map((message) => [message.messageId, message] as const),
	);

	let didRepair = false;
	for (const message of candidates) {
		const runId = normalizeDisplayMessageRunId(message.runId);
		if (!runId) continue;
		const eventMessages = eventMessagesByRunId.get(runId) ?? [];
		if (eventMessages.length === 0) continue;
		const rawMessage = rawMessagesById.get(message.messageId);
		const replayed = buildAgentDisplayMessageFromEvents({
			baseMessage: message,
			sourceMessageId:
				rawMessage?.messageId ?? message.sourceMessageId ?? message.messageId,
			eventMessages,
		});
		if (!replayed) continue;

		const currentSource =
			typeof message.sourceMessageId === "string" &&
			message.sourceMessageId.trim().length > 0
				? message.sourceMessageId.trim()
				: null;
		const nextSource =
			typeof replayed.sourceMessageId === "string" &&
			replayed.sourceMessageId.trim().length > 0
				? replayed.sourceMessageId.trim()
				: null;
		const currentContent = message.content ?? null;
		const nextContent = replayed.content ?? null;
		const currentReasoning = message.reasoning ?? null;
		const nextReasoning = replayed.reasoning ?? null;
		const currentToolCallsJson = JSON.stringify(message.toolCalls ?? null);
		const nextToolCallsJson = JSON.stringify(replayed.toolCalls ?? null);
		const currentError = message.error ?? null;
		const nextError = replayed.error ?? null;

		const needsSourceRepair = currentSource !== nextSource;
		const needsContentRepair = currentContent !== nextContent;
		const needsReasoningRepair = currentReasoning !== nextReasoning;
		const needsToolCallsRepair = currentToolCallsJson !== nextToolCallsJson;
		const needsStatusRepair = message.status !== replayed.status;
		const needsErrorRepair = currentError !== nextError;
		if (
			!needsSourceRepair &&
			!needsContentRepair &&
			!needsReasoningRepair &&
			!needsToolCallsRepair &&
			!needsStatusRepair &&
			!needsErrorRepair
		) {
			continue;
		}

		const repaired = await upsertDisplayMessageSnapshot({
			messageId: message.messageId,
			conversationId: message.conversationId,
			role: message.role,
			kind: "agent",
			runId,
			...(needsSourceRepair ? { sourceMessageId: nextSource } : {}),
			...(needsContentRepair ? { content: nextContent } : {}),
			...(needsReasoningRepair ? { reasoning: nextReasoning } : {}),
			...(needsToolCallsRepair
				? { toolCalls: replayed.toolCalls ?? null }
				: {}),
			...(needsStatusRepair ? { status: replayed.status } : {}),
			...(needsErrorRepair ? { error: nextError } : {}),
			createdAt: message.createdAt,
		});
		if (!repaired) continue;
		params.mergedById.set(repaired.messageId, repaired);
		didRepair = true;
	}

	return didRepair;
}

export const saveMessage = async (params: {
	messageId?: string;
	conversationId: string;
	role: "user" | "assistant" | "system" | "tool";
	content?: string;
	attachments?: AiMessageRow["attachments"];
	toolCalls?: Array<{
		id: string;
		type: "function";
		executionId?: string;
		function: { name: string; arguments: string };
	}>;
	toolCallId?: string;
	toolName?: string;
	promptTokens?: number;
	completionTokens?: number;
}) => {
	const insertValue = {
		...params,
		content: normalizeAssistantMessageContent(params.role, params.content),
	};
	const [message] = await db.insert(aiMessages).values(insertValue).returning();

	// Update conversation timestamp
	await db
		.update(aiConversations)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(aiConversations.conversationId, params.conversationId));

	await syncDisplayMessageFromRawMessage(message);

	return message;
};

export const updateMessage = async (params: {
	messageId: string;
	conversationId: string;
	role?: "user" | "assistant" | "system" | "tool";
	content?: string | null;
	attachments?: AiMessageRow["attachments"] | null;
	toolCalls?: AiMessageRow["toolCalls"] | null;
	toolCallId?: string | null;
	toolName?: string | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
}) => {
	const update: Record<string, unknown> = {};
	if (typeof params.role === "string") update.role = params.role;
	if (params.content !== undefined) {
		update.content = normalizeAssistantMessageContent(
			params.role ?? "assistant",
			params.content,
		);
	}
	if (params.attachments !== undefined) update.attachments = params.attachments;
	if (params.toolCalls !== undefined) update.toolCalls = params.toolCalls;
	if (params.toolCallId !== undefined) update.toolCallId = params.toolCallId;
	if (params.toolName !== undefined) update.toolName = params.toolName;
	if (params.promptTokens !== undefined)
		update.promptTokens = params.promptTokens;
	if (params.completionTokens !== undefined)
		update.completionTokens = params.completionTokens;

	const [message] = await db
		.update(aiMessages)
		.set(update)
		.where(eq(aiMessages.messageId, params.messageId))
		.returning();

	// Update conversation timestamp
	await db
		.update(aiConversations)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(aiConversations.conversationId, params.conversationId));

	await syncDisplayMessageFromRawMessage(message);

	return message;
};

const AI_MESSAGE_MAX_ATTACHMENTS = 4;
const AI_MESSAGE_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function estimateBase64Bytes(base64: string): number {
	const cleaned = base64.trim().replace(/\s/g, "");
	const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
	const bytes = Math.floor((cleaned.length * 3) / 4) - padding;
	return bytes > 0 ? bytes : 0;
}

function normalizeMessageAttachments(
	attachments: AiMessageAttachment[] | undefined,
): AiMessageAttachment[] {
	if (!Array.isArray(attachments) || attachments.length === 0) return [];
	if (attachments.length > AI_MESSAGE_MAX_ATTACHMENTS) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Too many attachments (max ${AI_MESSAGE_MAX_ATTACHMENTS})`,
		});
	}

	const normalized: AiMessageAttachment[] = [];
	for (const attachment of attachments) {
		if (!attachment || attachment.type !== "image") continue;
		if (
			typeof attachment.data !== "string" ||
			attachment.data.trim().length === 0
		) {
			continue;
		}
		if (
			typeof attachment.mediaType !== "string" ||
			attachment.mediaType.trim().length === 0
		) {
			continue;
		}
		const mediaType = attachment.mediaType.trim();
		if (!mediaType.startsWith("image/")) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Unsupported attachment media type: ${mediaType}`,
			});
		}
		const data = attachment.data.trim();
		const bytes = estimateBase64Bytes(data);
		if (bytes > AI_MESSAGE_MAX_IMAGE_BYTES) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Attachment too large (max ${AI_MESSAGE_MAX_IMAGE_BYTES} bytes)`,
			});
		}

		normalized.push({
			...attachment,
			data,
			mediaType,
		});
	}
	return normalized;
}

function messageToCoreMessage(
	msg: Pick<AiMessageRow, "role" | "content" | "toolCalls" | "attachments">,
): CoreMessage | null {
	if (msg.role !== "user" && msg.role !== "assistant") return null;

	const normalizedContent = normalizeAssistantMessageContent(
		msg.role,
		msg.content,
	);
	const content =
		typeof normalizedContent === "string" ? normalizedContent.trim() : "";
	const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

	if (msg.role === "user" && attachments.length > 0) {
		const parts: Array<Record<string, unknown>> = [];
		if (content.length > 0) {
			parts.push({ type: "text", text: content });
		}
		for (const attachment of attachments) {
			if (!attachment || attachment.type !== "image") continue;
			if (typeof attachment.data !== "string" || attachment.data.length === 0) {
				continue;
			}
			if (
				typeof attachment.mediaType !== "string" ||
				attachment.mediaType.length === 0
			) {
				continue;
			}
			parts.push({
				type: "image",
				image: attachment.data,
				mediaType: attachment.mediaType,
			});
		}
		if (parts.length > 0) {
			return { role: "user", content: parts as any };
		}
	}

	if (content.length > 0) {
		return { role: msg.role as "user" | "assistant", content };
	}

	const toolNames = (msg.toolCalls ?? [])
		.map((tc) => tc.function?.name)
		.filter(Boolean)
		.join(", ");
	if (toolNames.length > 0) {
		return {
			role: msg.role as "user" | "assistant",
			content: `[tool_calls: ${toolNames}]`,
		};
	}

	return null;
}

// ============================================
// Chat Function
// ============================================

interface ChatParams {
	conversationId: string;
	message: string;
	attachments?: AiMessageAttachment[];
	aiId: string;
	organizationId: string;
	userId: string;
	uiLocale?: string;
	persistUserMessage?: boolean;
	historyBefore?: { before?: string; beforeMessageId?: string };
	assistantMessageId?: string;
	sourceUserMessageId?: string;
}

type ChatUsage = {
	inputTokens?: number;
	outputTokens?: number;
};

function buildChatTools(params: {
	conversationId: string;
	runId?: string;
	toolContext: ToolContext;
	messageId?: string;
	toolApprovalsDisabled?: boolean;
}): Record<string, any> {
	let cachedConversationMetadata: unknown | undefined;
	const getConversationMetadata = async (): Promise<unknown> => {
		if (cachedConversationMetadata !== undefined)
			return cachedConversationMetadata;
		try {
			const conversation = await db.query.aiConversations.findFirst({
				where: eq(aiConversations.conversationId, params.conversationId),
				columns: { metadata: true },
			});
			cachedConversationMetadata = conversation?.metadata ?? null;
		} catch {
			cachedConversationMetadata = null;
		}
		return cachedConversationMetadata;
	};
	const getGithubRepoForConversation = async (): Promise<string | null> => {
		const metadata = await getConversationMetadata();
		return getGithubRepoFromMetadata(metadata);
	};
	let cachedUserMessageText: string | null | undefined;
	const getUserMessageTextForToolCall = async (): Promise<string> => {
		if (cachedUserMessageText !== undefined) return cachedUserMessageText ?? "";

		const messageId =
			typeof params.messageId === "string" ? params.messageId.trim() : "";
		if (messageId) {
			try {
				const msg = await db.query.aiMessages.findFirst({
					where: eq(aiMessages.messageId, messageId),
					columns: { role: true, content: true },
				});
				if (msg?.role === "user" && typeof msg.content === "string") {
					cachedUserMessageText = msg.content;
					return msg.content;
				}
			} catch {}
		}

		try {
			const msg = await db.query.aiMessages.findFirst({
				where: and(
					eq(aiMessages.conversationId, params.conversationId),
					eq(aiMessages.role, "user"),
				),
				columns: { content: true },
				orderBy: desc(aiMessages.createdAt),
			});
			cachedUserMessageText =
				typeof msg?.content === "string" ? msg.content : "";
		} catch {
			cachedUserMessageText = "";
		}
		return cachedUserMessageText ?? "";
	};

	type McpVirtualTool = {
		name: string;
		description: string;
		category: string;
		riskLevel: Tool["riskLevel"];
		requiresApproval: boolean;
		tags: string[];
		aliases: string[];
		mcpServerId: string;
		serverName: string;
		mcpToolName: string;
		inputSchema?: unknown;
		outputSchema?: unknown;
	};

	let cachedMcpVirtualTools: McpVirtualTool[] | null | undefined;
	const getMcpVirtualTools = async (): Promise<McpVirtualTool[]> => {
		if (cachedMcpVirtualTools !== undefined) return cachedMcpVirtualTools ?? [];

		const servers = await listAiMcpServersByOrganizationId({
			organizationId: params.toolContext.organizationId,
			limit: 100,
			offset: 0,
		});
		const enabled = servers.filter((s) => s.isEnabled);
		if (enabled.length === 0) {
			cachedMcpVirtualTools = [];
			return [];
		}

		const out: McpVirtualTool[] = [];
		for (const server of enabled) {
			const toolList = await listAiMcpToolsCached({
				organizationId: params.toolContext.organizationId,
				mcpServerId: server.mcpServerId,
			});
			if (toolList.error) continue;
			for (const t of toolList.tools) {
				const toolName = t.name.trim();
				if (!toolName) continue;
				const name = buildMcpVirtualToolName(server.mcpServerId, toolName);
				const serverName =
					String(server.name ?? "").trim() || server.mcpServerId;
				const description =
					typeof t.description === "string" && t.description.trim().length > 0
						? t.description.trim()
						: `MCP tool "${toolName}" (${serverName})`;
				out.push({
					name,
					description,
					category: "mcp",
					riskLevel: "high",
					requiresApproval: true,
					tags: ["mcp", serverName, toolName].filter(
						(x) => x.trim().length > 0,
					),
					aliases: [],
					mcpServerId: server.mcpServerId,
					serverName,
					mcpToolName: toolName,
					inputSchema: t.inputSchema,
					outputSchema: t.outputSchema,
				});
			}
		}

		cachedMcpVirtualTools = out;
		return out;
	};

	const searchToolCatalogWithMcp = async (input: {
		query: string;
		limit?: number;
		category?: string;
		riskLevelMax?: "low" | "medium" | "high";
		requiresApproval?: boolean;
	}) => {
		const mcpTools = await getMcpVirtualTools();
		if (mcpTools.length === 0) return searchToolCatalog(input);

		const tokens = tokenizeToolSearchQuery(input.query);
		const tokensLower = tokens.map((t) => t.toLowerCase());
		const riskLevelMaxRank =
			typeof input.riskLevelMax === "string"
				? getRiskRank(input.riskLevelMax)
				: undefined;
		const normalizedCategory =
			typeof input.category === "string" && input.category.trim().length > 0
				? input.category.trim()
				: undefined;

		const scored: Array<{
			name: string;
			description: string;
			category: string;
			riskLevel: Tool["riskLevel"];
			requiresApproval: boolean;
			aliases?: string[];
			tags?: string[];
			score: number;
		}> = [];

		for (const x of getToolSearchIndex()) {
			const t = x.t;
			if (normalizedCategory && t.category !== normalizedCategory) continue;
			if (typeof input.requiresApproval === "boolean") {
				if (t.requiresApproval !== input.requiresApproval) continue;
			}
			if (typeof riskLevelMaxRank === "number") {
				if (getRiskRank(t.riskLevel) > riskLevelMaxRank) continue;
			}

			let score = 0;
			for (const tTok of tokensLower) {
				if (x.nameLower.includes(tTok)) score += 6;
				if (x.extraTermsLower.some((term) => term.includes(tTok))) score += 5;
				if (x.hayLower.includes(tTok)) score += 3;
			}
			if (t.riskLevel === "low") score += 1;
			if (score <= 0) continue;

			scored.push({
				name: t.name,
				description: t.description,
				category: t.category,
				riskLevel: t.riskLevel,
				requiresApproval: t.requiresApproval,
				aliases: t.aliases ?? [],
				tags: t.tags && t.tags.length > 0 ? t.tags : deriveDefaultToolTags(t),
				score,
			});
		}

		for (const t of mcpTools) {
			if (normalizedCategory && t.category !== normalizedCategory) continue;
			if (typeof input.requiresApproval === "boolean") {
				if (t.requiresApproval !== input.requiresApproval) continue;
			}
			if (typeof riskLevelMaxRank === "number") {
				if (getRiskRank(t.riskLevel) > riskLevelMaxRank) continue;
			}

			const nameLower = t.name.toLowerCase();
			const extraTermsLower = t.tags.map((x) => x.toLowerCase());
			const hayLower =
				`${t.name} ${t.description} ${t.category} ${t.tags.join(" ")}`.toLowerCase();

			let score = 0;
			for (const tTok of tokensLower) {
				if (nameLower.includes(tTok)) score += 6;
				if (extraTermsLower.some((term) => term.includes(tTok))) score += 5;
				if (hayLower.includes(tTok)) score += 3;
			}
			if (score <= 0) continue;

			scored.push({
				name: t.name,
				description: t.description,
				category: t.category,
				riskLevel: t.riskLevel,
				requiresApproval: t.requiresApproval,
				aliases: t.aliases,
				tags: t.tags,
				score,
			});
		}

		if (scored.length === 0) return searchToolCatalog(input);

		scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

		const limit = input.limit ?? 12;
		const picked = scored.slice(0, limit);
		const message = `Found ${picked.length} tool(s) matching "${input.query}"`;

		const best = picked[0];
		const bestTool = best ? toolRegistry.get(best.name) : undefined;
		const nextCall = best
			? bestTool
				? {
						toolName: bestTool.name,
						params: buildExampleParams(bestTool.parameters),
						confirmLiterals: extractConfirmLiterals(bestTool.parameters),
					}
				: {
						toolName: best.name,
						params: {},
						confirmLiterals: [],
					}
			: undefined;

		return {
			success: true,
			message,
			meta: {
				query: input.query,
				nextCall,
				appliedFilters: {
					category: normalizedCategory,
					riskLevelMax: input.riskLevelMax,
					requiresApproval: input.requiresApproval,
				},
			},
			data: picked.map((t) => ({
				name: t.name,
				description: t.description,
				category: t.category,
				riskLevel: t.riskLevel,
				requiresApproval: t.requiresApproval,
				aliases: t.aliases ?? [],
				tags: t.tags ?? [],
			})),
		};
	};

	const suggestMcpTools = async (
		query: string,
		limit: number,
	): Promise<
		Array<{
			name: string;
			description: string;
			category: string;
			riskLevel: Tool["riskLevel"];
			requiresApproval: boolean;
		}>
	> => {
		const mcpTools = await getMcpVirtualTools();
		if (mcpTools.length === 0) return [];

		const tokens = tokenizeToolSearchQuery(query);
		const tokensLower = tokens.map((t) => t.toLowerCase());

		const scored: Array<{ t: McpVirtualTool; score: number }> = [];
		for (const t of mcpTools) {
			const nameLower = t.name.toLowerCase();
			const hayLower =
				`${t.name} ${t.description} ${t.category} ${t.tags.join(" ")}`.toLowerCase();

			let score = 0;
			for (const tTok of tokensLower) {
				if (nameLower.includes(tTok)) score += 6;
				if (hayLower.includes(tTok)) score += 3;
			}
			if (score <= 0) continue;
			scored.push({ t, score });
		}

		scored.sort(
			(a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name),
		);

		return scored.slice(0, limit).map((x) => ({
			name: x.t.name,
			description: x.t.description,
			category: x.t.category,
			riskLevel: x.t.riskLevel,
			requiresApproval: x.t.requiresApproval,
		}));
	};

	return {
		tool_suggest: tool({
			description:
				"Suggest likely relevant tools for a request. Returns a short list; use tool_search if the list is empty or insufficient.",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("The user's request (natural language)"),
				limit: z
					.number()
					.min(1)
					.max(30)
					.optional()
					.default(15)
					.describe("Max number of tools to return"),
			}),
			execute: async (input: { query: string; limit?: number }) => {
				const limit = input.limit ?? 15;
				const selectedRaw = selectRelevantTools(input.query, {
					projectId: params.toolContext.projectId,
					serverId: params.toolContext.serverId,
					minTools: 0,
					maxTools: limit,
				});
				const base = selectedRaw.map((t) => ({
					name: t.name,
					description: t.description,
					category: t.category,
					riskLevel: t.riskLevel,
					requiresApproval: t.requiresApproval,
				}));
				const remaining = Math.max(0, limit - base.length);
				const extraMcp =
					remaining > 0 ? await suggestMcpTools(input.query, remaining) : [];
				const merged: Array<(typeof base)[number]> = [];
				const seen = new Set<string>();
				for (const x of base) {
					if (seen.has(x.name)) continue;
					seen.add(x.name);
					merged.push(x);
				}
				for (const x of extraMcp) {
					if (seen.has(x.name)) continue;
					seen.add(x.name);
					merged.push(x);
					if (merged.length >= limit) break;
				}
				return {
					success: true,
					message:
						merged.length > 0
							? `Suggested ${merged.length} tool(s) for "${input.query}"`
							: `No direct suggestions for "${input.query}". Use tool_search to explore the full catalog.`,
					data: merged,
				};
			},
		}),
		tool_search: tool({
			description:
				"Search the full tool catalog and return matching tool names and summaries.",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("What you want to do or find (natural language)"),
				limit: z
					.number()
					.min(1)
					.max(30)
					.optional()
					.default(12)
					.describe("Max number of tools to return"),
				category: z
					.string()
					.min(1)
					.optional()
					.describe("Optional tool category filter"),
				riskLevelMax: z
					.enum(["low", "medium", "high"])
					.optional()
					.describe("Optional max risk level filter"),
				requiresApproval: z
					.boolean()
					.optional()
					.describe("Optional approval requirement filter"),
			}),
			execute: async (input: {
				query: string;
				limit?: number;
				category?: string;
				riskLevelMax?: "low" | "medium" | "high";
				requiresApproval?: boolean;
			}) => {
				return await searchToolCatalogWithMcp(input);
			},
		}),
		tool_describe: tool({
			description:
				"Describe a specific tool, including parameter hints extracted from its schema.",
			inputSchema: z.object({
				toolName: z
					.string()
					.min(1)
					.describe('Exact tool name, e.g. "trpc_procedure_call"'),
			}),
			execute: async (input: { toolName: string }) => {
				const toolName = input.toolName.trim();

				const mcp = parseMcpVirtualToolName(toolName);
				if (mcp) {
					const catalog = await getMcpVirtualTools();
					const match = catalog.find(
						(t) =>
							t.mcpServerId === mcp.mcpServerId &&
							t.mcpToolName === mcp.mcpToolName,
					);
					if (!match) return buildUnknownToolSuggestionResult(toolName);
					return {
						success: true,
						message: `MCP tool "${match.mcpToolName}" described`,
						data: {
							kind: "mcp_tool",
							name: match.name,
							description: match.description,
							server: {
								mcpServerId: match.mcpServerId,
								name: match.serverName,
							},
							inputSchema: match.inputSchema,
							outputSchema: match.outputSchema,
							exampleToolCall: {
								toolName: match.name,
								params: {},
							},
						},
					};
				}

				const t = toolRegistry.get(toolName);
				if (!t) {
					if (toolName.includes(".")) {
						const bridge = getTrpcBridge();
						if (bridge) {
							try {
								const desc = await bridge.describeProcedure(toolName);
								return {
									success: true,
									message: `tRPC procedure "${desc.name}" described`,
									data: { kind: "trpc_procedure", ...desc },
								};
							} catch {}
						}
					}
					return buildUnknownToolSuggestionResult(toolName);
				}
				const data = getToolDescribeData(t);
				return {
					success: true,
					message: `Tool "${t.name}" description retrieved`,
					data,
				};
			},
		}),
		tool_call: tool({
			description:
				"Create a tool execution by name + params. Enforces validation. If the target tool requires approval, this returns pending_approval and does NOT execute; you must still provide all required params (including confirm literals). Use tool_describe first if unsure.",
			inputSchema: z
				.object({
					toolName: z.string().min(1).describe("Exact tool name to execute"),
					params: z
						.record(z.string(), z.any())
						.optional()
						.default({})
						.describe("Parameters object for the tool"),
				})
				.passthrough(),
			execute: async (input: { toolName: string; params?: unknown }) => {
				const inputAny = input as unknown as Record<string, unknown>;
				const normalizedToolName = input.toolName.trim();
				input.toolName = normalizedToolName;

				const recordCandidates = [
					inputAny.params,
					inputAny.input,
					inputAny.args,
					input.params,
				].filter(isRecord) as Record<string, unknown>[];
				const preferredRecord =
					recordCandidates.find(
						(candidate) => Object.keys(candidate).length > 0,
					) ?? recordCandidates[0];
				const rawParams: Record<string, unknown> = {
					...(preferredRecord ?? {}),
				};

				// Common LLM mistake: provide tool params at the top-level instead of inside `params`.
				for (const [k, v] of Object.entries(inputAny)) {
					if (
						k === "toolName" ||
						k === "params" ||
						k === "input" ||
						k === "args"
					)
						continue;
					if (rawParams[k] == null) rawParams[k] = v;
				}

				// Common LLM mistake: provide `procedureName` at the top-level instead of inside `params`.
				if (
					input.toolName === "trpc_procedure_call" &&
					rawParams.procedureName == null &&
					typeof inputAny.procedureName === "string" &&
					inputAny.procedureName.trim()
				) {
					rawParams.procedureName = inputAny.procedureName.trim();
				}
				if (
					(input.toolName === "trpc_procedure_call" ||
						input.toolName === "trpc_procedure_describe") &&
					typeof rawParams.procedureName === "string"
				) {
					rawParams.procedureName = rawParams.procedureName.trim();
				}
				if (
					input.toolName === "trpc_procedure_call" &&
					typeof rawParams.input === "undefined" &&
					typeof inputAny.input !== "undefined"
				) {
					rawParams.input = inputAny.input;
				}
				if (
					input.toolName === "trpc_procedure_call" &&
					typeof rawParams.input === "undefined" &&
					typeof rawParams.params === "undefined" &&
					typeof rawParams.procedureName === "string" &&
					rawParams.procedureName.trim().length > 0
				) {
					const inferredInput: Record<string, unknown> = {};
					for (const [k, v] of Object.entries(rawParams)) {
						if (k === "procedureName" || k === "input" || k === "params") {
							continue;
						}
						inferredInput[k] = v;
					}
					if (Object.keys(inferredInput).length > 0) {
						rawParams.input = inferredInput;
					}
				}
				if (
					input.toolName === "trpc_procedure_search" &&
					typeof rawParams.query === "string"
				) {
					rawParams.query = rawParams.query.trim();
				}
				if (
					(input.toolName === "trpc_procedure_search" ||
						input.toolName === "tool_search" ||
						input.toolName === "tool_suggest") &&
					(typeof rawParams.query !== "string" ||
						rawParams.query.trim().length === 0) &&
					typeof rawParams.reason === "string" &&
					rawParams.reason.trim().length > 0
				) {
					rawParams.query = rawParams.reason.trim();
				}
				if (
					input.toolName === "trpc_procedure_search" &&
					typeof rawParams.limit === "number"
				) {
					rawParams.limit = Math.max(1, Math.min(50, rawParams.limit));
				}
				if (
					(input.toolName === "tool_search" ||
						input.toolName === "tool_suggest") &&
					typeof rawParams.limit === "number"
				) {
					rawParams.limit = Math.max(1, Math.min(30, rawParams.limit));
				}

				let t = toolRegistry.get(input.toolName);
				if (!t) {
					const mcp = parseMcpVirtualToolName(input.toolName);
					if (mcp) {
						const catalog = await getMcpVirtualTools();
						const match = catalog.find(
							(t) =>
								t.mcpServerId === mcp.mcpServerId &&
								t.mcpToolName === mcp.mcpToolName,
						);

						if (!match) {
							const searched = await searchToolCatalogWithMcp({
								query: input.toolName,
								limit: 5,
							});
							return {
								success: false,
								message: `Tool "${input.toolName}" not found`,
								error: `Unknown tool: ${input.toolName}`,
								data: {
									query: input.toolName,
									suggestions: searched.data,
									nextCall: searched.meta.nextCall,
								},
							};
						}

						const mcpValidation = validateAiMcpToolArguments({
							inputSchema: match.inputSchema,
							arguments: rawParams,
						});
						if (!mcpValidation.ok) {
							return {
								success: false,
								message: `Invalid parameters for MCP tool "${match.name}"`,
								error: mcpValidation.errorText
									.replace(/\s*\n\s*/g, "; ")
									.trim(),
								data: {
									toolName: match.name,
									server: {
										mcpServerId: match.mcpServerId,
										name: match.serverName,
									},
									issues: mcpValidation.issues,
									hint: "Use tool_describe to view the MCP tool input schema, then retry tool_call with a params object matching that schema.",
								},
							};
						}

						const requiresApproval = params.toolApprovalsDisabled !== true;
						const execution = await createToolExecution({
							conversationId: params.conversationId,
							runId: params.runId,
							messageId: params.messageId,
							toolName: match.name,
							parameters: rawParams,
							requiresApproval,
						});

						if (requiresApproval) {
							return {
								success: true,
								status: "pending_approval",
								executionId: execution.executionId,
								toolName: match.name,
								message: `This action requires approval. Tool: ${match.name}`,
								data: {
									executionId: execution.executionId,
									toolName: match.name,
									confirmLiterals: [],
									exampleParams: {},
								},
							};
						}

						if (
							typeof params.runId === "string" &&
							params.runId.trim().length > 0
						) {
							await saveAgentEventMessage({
								conversationId: params.conversationId,
								payload: {
									type: "agent.step.start",
									runId: params.runId.trim(),
									stepId: execution.executionId,
									executionId: execution.executionId,
									toolName: match.name,
									parametersPreview: safeJsonForPrompt(rawParams, 4000),
								},
							});
						}

						try {
							const res = await callAiMcpTool({
								organizationId: params.toolContext.organizationId,
								mcpServerId: match.mcpServerId,
								toolName: match.mcpToolName,
								arguments: rawParams,
							});
							const success = res.isError !== true;
							const toolResult = normalizeToolResultForStorage({
								success,
								message: success
									? `MCP tool "${match.mcpToolName}" executed`
									: `MCP tool "${match.mcpToolName}" returned an error`,
								data: {
									mcpServerId: match.mcpServerId,
									serverName: match.serverName,
									toolName: match.mcpToolName,
									content: res.content,
									structuredContent: res.structuredContent,
									isError: res.isError,
								},
							});

							const completionUpdate: Record<string, unknown> = {
								status: success ? "completed" : "failed",
								result: toolResult,
								completedAt: new Date().toISOString(),
							};
							if (!success) completionUpdate.error = "MCP_TOOL_ERROR";
							await updateToolExecution(
								execution.executionId,
								completionUpdate,
							);

							return {
								executionId: execution.executionId,
								invokedTool: match.name,
								...(toolResult as object),
							};
						} catch (error) {
							const errorMessage =
								error instanceof Error ? error.message : String(error);
							await updateToolExecution(execution.executionId, {
								status: "failed",
								error: errorMessage,
								completedAt: new Date().toISOString(),
							});
							return {
								executionId: execution.executionId,
								success: false,
								message: "Tool execution failed",
								error: errorMessage,
							};
						}
					}
				}
				if (!t) {
					// Convenience fallback: treat an unknown dotted name as a tRPC procedure call.
					// Example: { toolName: "project.create", params: { name: "dk" } }
					if (input.toolName.includes(".")) {
						const trpcTool = toolRegistry.get("trpc_procedure_call");
						if (trpcTool) {
							const wrappedCandidate = (() => {
								if (isRecord(rawParams.input)) return rawParams.input;
								if (isRecord(rawParams.params)) return rawParams.params;
								const filteredEntries = Object.entries(rawParams).filter(
									([key]) =>
										key !== "procedureName" &&
										key !== "input" &&
										key !== "params",
								);
								return Object.fromEntries(filteredEntries);
							})();
							const wrapped = isRecord(wrappedCandidate)
								? { ...wrappedCandidate }
								: {};
							rawParams.procedureName = input.toolName;
							if (Object.keys(wrapped).length > 0) {
								rawParams.input = wrapped;
							}
							t = trpcTool;
						}
					}
				}

				if (!t) {
					const searched = searchToolCatalog({
						query: input.toolName,
						limit: 5,
					});
					const candidateName = searched.meta.nextCall?.toolName ?? "";
					const candidate = candidateName
						? toolRegistry.get(candidateName)
						: undefined;
					if (
						candidate &&
						candidate.riskLevel === "low" &&
						!candidate.requiresApproval
					) {
						const candidateValidation =
							candidate.parameters.safeParse(rawParams);
						if (candidateValidation.success) {
							t = candidate;
						}
					}
				}

				if (!t) return buildUnknownToolSuggestionResult(input.toolName);
				const validation = t.parameters.safeParse(rawParams);
				if (!validation.success) {
					const exampleParams = buildExampleParams(t.parameters);
					return {
						success: false,
						message:
							"Invalid parameters (use tool_describe and provide all required fields; for approval-required tools, include confirm literals in the tool_call params)",
						error: validation.error.message,
						data: {
							toolName: t.name,
							confirmLiterals: extractConfirmLiterals(t.parameters),
							exampleParams,
							exampleToolCall: {
								toolName: t.name,
								params: exampleParams,
							},
						},
					};
				}

				const validatedParams = validation.data as unknown as Record<
					string,
					unknown
				>;

				let requiresApproval =
					t.requiresApproval && params.toolApprovalsDisabled !== true;
				if (
					t.name === "trpc_procedure_call" &&
					typeof validatedParams.procedureName === "string" &&
					validatedParams.procedureName.trim().length > 0
				) {
					const procedureName = validatedParams.procedureName.trim();
					const bridge = getTrpcBridge();
					if (bridge) {
						try {
							const desc = await bridge.describeProcedure(procedureName);
							const inputCandidate =
								typeof validatedParams.input !== "undefined"
									? validatedParams.input
									: typeof validatedParams.params !== "undefined"
										? validatedParams.params
										: undefined;

							if (typeof inputCandidate === "undefined") {
								if (desc.inputExample !== null) {
									const requiredFields = (desc.fields ?? [])
										.filter((f) => f.required)
										.map((f) => f.name);

									if (desc.type === "query" && requiredFields.length === 0) {
										validatedParams.input = {};
									} else if (requiredFields.length === 1) {
										const onlyField = String(requiredFields[0] ?? "").trim();
										let inferred: Record<string, unknown> | null = null;
										if (
											onlyField === "projectId" &&
											typeof params.toolContext.projectId === "string" &&
											params.toolContext.projectId.trim().length > 0
										) {
											inferred = {
												projectId: params.toolContext.projectId.trim(),
											};
										} else if (
											onlyField === "serverId" &&
											typeof params.toolContext.serverId === "string" &&
											params.toolContext.serverId.trim().length > 0
										) {
											inferred = {
												serverId: params.toolContext.serverId.trim(),
											};
										} else if (onlyField === "organizationId") {
											inferred = {
												organizationId: params.toolContext.organizationId,
											};
										} else if (onlyField === "userId") {
											inferred = { userId: params.toolContext.userId };
										} else if (onlyField === "repo") {
											let repo = await getGithubRepoForConversation();
											if (!repo) {
												const userText = await getUserMessageTextForToolCall();
												repo = extractGithubRepoFromText(userText);
											}
											if (repo) inferred = { repo };
										}

										if (inferred) {
											validatedParams.input = inferred;
										} else {
											return {
												success: false,
												message: `Invalid parameters: tRPC procedure "${procedureName}" requires an input object`,
												error: "TRPC_INPUT_REQUIRED",
												data: {
													procedure: desc,
													requiredFields,
													exampleToolCall: {
														toolName: "trpc_procedure_call",
														params: {
															procedureName,
															input: desc.inputExample,
														},
													},
												},
											};
										}
									} else if (
										requiredFields.length === 2 &&
										requiredFields.includes("repo") &&
										requiredFields.includes("path")
									) {
										const repo = await getGithubRepoForConversation();
										const userText = await getUserMessageTextForToolCall();
										const path = extractFilePathFromText(userText);

										if (repo && path) {
											validatedParams.input = { repo, path };
										} else {
											const inferred: Record<string, unknown> = {};
											if (repo) inferred.repo = repo;
											if (path) inferred.path = path;
											return {
												success: false,
												message: `Invalid parameters: tRPC procedure "${procedureName}" requires an input object`,
												error: "TRPC_INPUT_REQUIRED",
												data: {
													procedure: desc,
													requiredFields,
													inferredInput: inferred,
													exampleToolCall: {
														toolName: "trpc_procedure_call",
														params: {
															procedureName,
															input: desc.inputExample,
														},
													},
												},
											};
										}
									} else {
										return {
											success: false,
											message: `Invalid parameters: tRPC procedure "${procedureName}" requires an input object`,
											error: "TRPC_INPUT_REQUIRED",
											data: {
												procedure: desc,
												requiredFields,
												exampleToolCall: {
													toolName: "trpc_procedure_call",
													params: {
														procedureName,
														input: desc.inputExample,
													},
												},
											},
										};
									}
								}
							}

							if (requiresApproval && desc.type === "query") {
								requiresApproval = false;
							}
						} catch {}
					}
				}

				const execution = await createToolExecution({
					conversationId: params.conversationId,
					runId: params.runId,
					messageId: params.messageId,
					toolName: t.name,
					parameters: validatedParams,
					requiresApproval,
				});

				if (requiresApproval) {
					return {
						success: true,
						status: "pending_approval",
						executionId: execution.executionId,
						toolName: t.name,
						message: `This action requires approval. Tool: ${t.name}`,
						data: {
							executionId: execution.executionId,
							toolName: t.name,
							confirmLiterals: extractConfirmLiterals(t.parameters),
							exampleParams: buildExampleParams(t.parameters),
						},
					};
				}

				if (
					typeof params.runId === "string" &&
					params.runId.trim().length > 0
				) {
					await saveAgentEventMessage({
						conversationId: params.conversationId,
						payload: {
							type: "agent.step.start",
							runId: params.runId.trim(),
							stepId: execution.executionId,
							executionId: execution.executionId,
							toolName: t.name,
							parametersPreview: safeJsonForPrompt(validatedParams, 4000),
						},
					});
				}

				try {
					const rawResult = await t.execute(
						validation.data as never,
						params.toolContext,
					);
					const result = normalizeToolResultForStorage(rawResult);

					const completionUpdate: Record<string, unknown> = {
						status: rawResult.success ? "completed" : "failed",
						result,
						completedAt: new Date().toISOString(),
					};
					if (!rawResult.success) {
						completionUpdate.error = rawResult.error || rawResult.message;
					}
					await updateToolExecution(execution.executionId, completionUpdate);

					return {
						executionId: execution.executionId,
						invokedTool: t.name,
						...(result as object),
					};
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					await updateToolExecution(execution.executionId, {
						status: "failed",
						error: errorMessage,
						completedAt: new Date().toISOString(),
					});
					return {
						executionId: execution.executionId,
						success: false,
						message: "Tool execution failed",
						error: errorMessage,
					};
				}
			},
		}),
	};
}

function getProviderErrorText(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	const responseBody = (err as { responseBody?: unknown })?.responseBody;
	const responseBodyText =
		typeof responseBody === "string" && responseBody.trim().length > 0
			? responseBody
			: "";

	if (responseBodyText.length === 0) return msg;
	if (msg.includes(responseBodyText)) return msg;
	return `${msg}\n${responseBodyText}`;
}

function isMissingToolUseIdError(err: unknown): boolean {
	const msg = getProviderErrorText(err);
	return (
		msg.includes("tool_use.id") ||
		msg.includes("tool_use.id:") ||
		msg.includes("function_call.args") ||
		msg.includes("type.googleapis.com/google.protobuf.Struct") ||
		(msg.includes("request.contents") &&
			msg.includes("function_call") &&
			msg.includes("Invalid value")) ||
		(msg.includes("messages.") &&
			msg.includes("tool_use") &&
			msg.includes("Field required"))
	);
}

function isSystemMessagePlacementError(err: unknown): boolean {
	const msg = getProviderErrorText(err).toLowerCase();
	return (
		msg.includes("system messages are only supported at the beginning") ||
		(msg.includes("system messages") &&
			msg.includes("beginning of the conversation")) ||
		msg.includes("system messages are not supported")
	);
}

function getInitialSystemMode(aiSettings: {
	providerType?: string | null;
}): "system" | "inline" {
	const providerType = String(aiSettings.providerType ?? "")
		.trim()
		.toLowerCase();

	// Prefer the provider-native system channel when it's widely supported and stable.
	if (
		providerType === "openai" ||
		providerType === "azure" ||
		providerType === "anthropic"
	) {
		return "system";
	}

	// For OpenAI-compatible/custom endpoints and various providers, use inline system
	// instructions by default to maximize compatibility.
	return "inline";
}

function isInvalidJsonLikelySse(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	if (msg.includes("Invalid JSON response")) return true;
	if (msg.includes("AI_JSONParseError")) return true;
	if (msg.includes("JSON parsing failed")) return true;

	const causeText = (err as { cause?: unknown })?.cause as
		| { text?: unknown }
		| undefined;
	const text = causeText?.text;
	if (typeof text === "string" && text.trimStart().startsWith("data:")) {
		return true;
	}

	return false;
}

function normalizeUnknownToString(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function safeTruncateString(value: string, maxLen: number) {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, maxLen)}\n... (truncated)`;
}

function safeJsonForPrompt(value: unknown, maxLen: number) {
	const limits = {
		maxDepth: 4,
		maxArrayLength: 50,
		maxObjectKeys: 50,
		maxStringLength: 2000,
	} as const;

	const truncatedMarker = "\n... (truncated)";
	let truncated = false;

	const parts: string[] = [];
	let remaining = Math.max(0, maxLen);

	const push = (text: string) => {
		if (remaining <= 0) return;
		if (text.length <= remaining) {
			parts.push(text);
			remaining -= text.length;
			return;
		}
		parts.push(text.slice(0, remaining));
		remaining = 0;
		truncated = true;
	};

	const seen = new WeakSet<object>();

	const write = (input: unknown, depth: number) => {
		if (remaining <= 0) return;
		if (depth > limits.maxDepth) {
			truncated = true;
			push('"[MaxDepth]"');
			return;
		}

		if (input === null) {
			push("null");
			return;
		}

		if (typeof input === "string") {
			const s =
				input.length > limits.maxStringLength
					? `${input.slice(0, limits.maxStringLength)}…`
					: input;
			if (input.length > limits.maxStringLength) truncated = true;
			push(JSON.stringify(s));
			return;
		}
		if (
			typeof input === "number" ||
			typeof input === "boolean" ||
			typeof input === "bigint"
		) {
			push(String(input));
			return;
		}
		if (input === undefined) {
			push("null");
			return;
		}
		if (typeof input === "function") {
			push('"[Function]"');
			return;
		}
		if (typeof input === "symbol") {
			push(JSON.stringify(`[Symbol ${String(input)}]`));
			return;
		}

		if (Array.isArray(input)) {
			push("[");
			const len = input.length;
			const shown = Math.min(len, limits.maxArrayLength);
			for (let i = 0; i < shown; i++) {
				if (i > 0) push(", ");
				write(input[i], depth + 1);
				if (remaining <= 0) break;
			}
			if (len > shown && remaining > 0) {
				truncated = true;
				push(', "…"');
			}
			push("]");
			return;
		}

		if (typeof input === "object") {
			const obj = input as Record<string, unknown>;
			if (seen.has(obj)) {
				truncated = true;
				push('"[Circular]"');
				return;
			}
			seen.add(obj);

			push("{");
			let written = 0;
			let hasMore = false;
			for (const key in obj) {
				if (!Object.hasOwn(obj, key)) continue;
				if (written >= limits.maxObjectKeys) {
					hasMore = true;
					break;
				}
				if (written > 0) push(", ");
				push(JSON.stringify(key));
				push(": ");
				write(obj[key], depth + 1);
				written++;
				if (remaining <= 0) break;
			}
			if (hasMore && remaining > 0) {
				truncated = true;
				push(', "_truncated": true');
			}
			push("}");
			return;
		}

		push(JSON.stringify(String(input)));
	};

	try {
		write(value, 0);
		const out = parts.join("");
		return truncated ? `${out}${truncatedMarker}` : out;
	} catch {
		return safeTruncateString(String(value), maxLen);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikePemBlock(value: string): boolean {
	return /-----BEGIN [A-Z0-9 ]+-----/.test(value);
}

function looksLikeBase64Blob(value: string): boolean {
	const compact = value.replace(/\s+/g, "");
	if (compact.length < 512 || compact.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function summarizeValueForModelContext(
	value: unknown,
	options?: {
		depth?: number;
		key?: string;
	},
): unknown {
	const depth = options?.depth ?? 0;
	const key = options?.key ?? "";

	if (value == null) return value;
	if (depth >= 4) return "[Depth omitted]";

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (looksLikePemBlock(trimmed)) {
			return `[PEM omitted; ${value.length} chars]`;
		}
		if (
			/(?:^|\.)(?:certificateData|privateKey|contentBase64|base64|pem)$/i.test(
				key,
			) ||
			looksLikeBase64Blob(trimmed)
		) {
			return `[Binary/blob omitted; ${value.length} chars]`;
		}
		if (value.length > 800) {
			return `${value.slice(0, 300)}… (${value.length} chars total)`;
		}
		return value;
	}

	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return value;
	}

	if (Array.isArray(value)) {
		const sampleSize = 5;
		if (value.length <= sampleSize) {
			return value.map((item) =>
				summarizeValueForModelContext(item, {
					depth: depth + 1,
					key,
				}),
			);
		}
		return {
			count: value.length,
			sample: value.slice(0, sampleSize).map((item) =>
				summarizeValueForModelContext(item, {
					depth: depth + 1,
					key,
				}),
			),
			truncated: true,
		};
	}

	if (!isRecord(value)) return String(value);

	const out: Record<string, unknown> = {};
	let kept = 0;
	for (const [entryKey, entryValue] of Object.entries(value)) {
		if (kept >= 20) {
			out._truncatedKeys = true;
			break;
		}
		if (
			/(?:^|\.)(?:certificateData|privateKey|contentBase64|pem|preview)$/i.test(
				`${key}.${entryKey}`,
			)
		) {
			if (typeof entryValue === "string") {
				out[entryKey] = `[Omitted; ${entryValue.length} chars]`;
			} else {
				out[entryKey] = "[Omitted]";
			}
			kept++;
			continue;
		}
		out[entryKey] = summarizeValueForModelContext(entryValue, {
			depth: depth + 1,
			key: key ? `${key}.${entryKey}` : entryKey,
		});
		kept++;
	}
	return out;
}

function summarizeJsonForModelContext(value: unknown, maxLen: number): string {
	return safeJsonForPrompt(summarizeValueForModelContext(value), maxLen);
}

function getRetryableToolCallFailures(toolResults: unknown): {
	failures: Record<string, unknown>[];
	successfulTools: string[];
	hasPendingApproval: boolean;
} {
	const failures: Record<string, unknown>[] = [];
	const successfulTools = new Set<string>();
	let hasPendingApproval = false;

	if (!Array.isArray(toolResults)) {
		return { failures, successfulTools: [], hasPendingApproval };
	}

	for (const tr of toolResults) {
		if (!tr || typeof tr !== "object") continue;

		const resultValue =
			(tr as { result?: unknown }).result ??
			(tr as { output?: unknown }).output ??
			tr;
		if (!isRecord(resultValue)) continue;

		if (resultValue.success === true) {
			if (resultValue.status === "pending_approval") {
				hasPendingApproval = true;
			}
			const invokedTool =
				typeof resultValue.invokedTool === "string"
					? resultValue.invokedTool.trim()
					: typeof resultValue.toolName === "string"
						? resultValue.toolName.trim()
						: "";
			if (invokedTool.length > 0) successfulTools.add(invokedTool);
			continue;
		}

		if (resultValue.success !== false) continue;

		const message =
			typeof resultValue.message === "string" ? resultValue.message : "";
		const error =
			typeof resultValue.error === "string" ? resultValue.error : "";
		const data = isRecord(resultValue.data) ? resultValue.data : undefined;

		const isInvalidParams = message.startsWith("Invalid parameters");
		const isUnknownTool = error.startsWith("Unknown tool:");
		const hasExampleToolCall =
			!!data &&
			"exampleToolCall" in data &&
			isRecord((data as { exampleToolCall?: unknown }).exampleToolCall);

		if (isInvalidParams || isUnknownTool || hasExampleToolCall) {
			failures.push(resultValue);
		}
	}

	return {
		failures: failures.slice(0, 2),
		successfulTools: Array.from(successfulTools),
		hasPendingApproval,
	};
}

const TOOL_RESULT_MAX_JSON_CHARS = 200_000;
const TOOL_RESULT_PREVIEW_CHARS = 20_000;

function safeJsonStringifyForStorage(value: unknown): string {
	const seen = new WeakSet<object>();
	const replacer = (_key: string, v: unknown) => {
		if (typeof v === "bigint") return v.toString();
		if (v instanceof Error) {
			return {
				name: v.name,
				message: v.message,
				stack: v.stack,
			};
		}
		if (v instanceof Map) {
			return Array.from(v.entries());
		}
		if (v instanceof Set) {
			return Array.from(v.values());
		}
		if (typeof v === "object" && v !== null) {
			const obj = v as object;
			if (seen.has(obj)) return "[Circular]";
			seen.add(obj);
		}
		return v;
	};

	try {
		return JSON.stringify(value, replacer);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			return JSON.stringify({ error: "UNSERIALIZABLE", message });
		} catch {
			return '{"error":"UNSERIALIZABLE"}';
		}
	}
}

function normalizeToolResultForStorage(raw: unknown): {
	success: boolean;
	message: string;
	data?: unknown;
	error?: string;
} {
	const base = (() => {
		if (isRecord(raw) && typeof raw.success === "boolean") {
			const message = typeof raw.message === "string" ? raw.message : "";
			const out: {
				success: boolean;
				message: string;
				data?: unknown;
				error?: string;
			} = {
				success: raw.success,
				message: message.length > 0 ? message : "Tool executed",
			};
			if ("data" in raw) out.data = raw.data;
			if (typeof raw.error === "string") out.error = raw.error;
			return out;
		}
		return {
			success: false,
			message: "Tool returned an invalid result",
			error: `Invalid tool result type: ${typeof raw}`,
			data: {},
		};
	})();

	const json = safeJsonStringifyForStorage(base);
	if (json.length <= TOOL_RESULT_MAX_JSON_CHARS) {
		try {
			return JSON.parse(json) as typeof base;
		} catch (error) {
			return {
				success: base.success,
				message: base.message,
				error: error instanceof Error ? error.message : String(error),
				data: {
					truncated: true,
					jsonChars: json.length,
					preview: json.slice(0, TOOL_RESULT_PREVIEW_CHARS),
				},
			};
		}
	}

	return {
		success: base.success,
		message: base.message,
		error: base.error,
		data: {
			truncated: true,
			jsonChars: json.length,
			preview: json.slice(0, TOOL_RESULT_PREVIEW_CHARS),
		},
	};
}

function getToolApprovalsDisabledFromMetadata(metadata: unknown): boolean {
	return isRecord(metadata) && metadata.toolApprovalsDisabled === true;
}

function setToolApprovalsDisabledInMetadata(
	metadata: unknown,
	disabled: boolean,
): Record<string, unknown> {
	const next = isRecord(metadata) ? { ...metadata } : {};
	if (disabled) next.toolApprovalsDisabled = true;
	else
		delete (next as { toolApprovalsDisabled?: unknown }).toolApprovalsDisabled;
	return next;
}

function getToolBudgetModeFromMetadata(metadata: unknown): ToolBudgetMode {
	if (!isRecord(metadata)) return "max";
	const raw = (metadata as { toolBudgetMode?: unknown }).toolBudgetMode;
	return raw === "standard" ? "standard" : "max";
}

function setToolBudgetModeInMetadata(
	metadata: unknown,
	mode: ToolBudgetMode,
): Record<string, unknown> {
	const next = isRecord(metadata) ? { ...metadata } : {};
	if (mode === "standard") next.toolBudgetMode = "standard";
	else delete (next as { toolBudgetMode?: unknown }).toolBudgetMode;
	return next;
}

function getToolStepBudget(mode: ToolBudgetMode): number {
	return mode === "max" ? TOOL_BUDGET_MAX_STEPS : TOOL_BUDGET_STANDARD_STEPS;
}

function normalizeUiLocale(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function getUiLocaleFromMetadata(metadata: unknown): string | null {
	if (!isRecord(metadata)) return null;
	return normalizeUiLocale(metadata.uiLocale);
}

function setUiLocaleInMetadata(
	metadata: unknown,
	uiLocale: string | null,
): Record<string, unknown> {
	const next = isRecord(metadata) ? { ...metadata } : {};
	if (uiLocale) next.uiLocale = uiLocale;
	else delete (next as { uiLocale?: unknown }).uiLocale;
	return next;
}

function getGithubRepoFromMetadata(metadata: unknown): string | null {
	if (!isRecord(metadata)) return null;
	const raw =
		(metadata as { githubRepo?: unknown }).githubRepo ??
		(metadata as { repo?: unknown }).repo;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function setGithubRepoInMetadata(
	metadata: unknown,
	repo: string | null,
): Record<string, unknown> {
	const next = isRecord(metadata) ? { ...metadata } : {};
	if (repo) next.githubRepo = repo;
	else delete (next as { githubRepo?: unknown }).githubRepo;
	return next;
}

function isLikelyPathLikeOwnerRepo(owner: string, repo: string): boolean {
	const o = owner.toLowerCase();
	const r = repo.toLowerCase();
	if (o === "docker" && (r === "volumes" || r === "volume")) return true;
	if (o === "apps" || o === "packages" || o === "src" || o === "public")
		return true;
	if (r === "src" || r === "dist" || r === "config" || r === "volumes")
		return true;
	return false;
}

function scoreGithubRepoCandidate(owner: string, repo: string): number {
	const full = `${owner}/${repo}`;
	let score = 0;
	if (owner.length > 0 && owner.length <= 39) score += 1;
	if (repo.length > 0 && repo.length <= 100) score += 1;
	if (/[A-Z0-9]/.test(full)) score += 2;
	if (full.includes("-")) score += 2;
	if (full.includes("_")) score += 1;
	if (full.includes(".")) score += 1;
	if (isLikelyPathLikeOwnerRepo(owner, repo)) score -= 8;
	return score;
}

function extractGithubRepoFromText(text: string): string | null {
	const input = text.trim();
	if (!input) return null;

	const urlMatch = input.match(
		/https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+)(?:\.git)?/i,
	);
	if (urlMatch) {
		const owner = String(urlMatch[1] ?? "").trim();
		const repo = String(urlMatch[2] ?? "")
			.replace(/\.git$/i, "")
			.trim();
		if (owner && repo) return `${owner}/${repo}`;
	}

	const tokenRe =
		/\b([A-Za-z0-9][A-Za-z0-9_.-]{0,80})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,100})(?:\.git)?\b/g;
	const candidates: Array<{ owner: string; repo: string; score: number }> = [];
	for (const match of input.matchAll(tokenRe)) {
		const owner = String(match[1] ?? "").trim();
		const repo = String(match[2] ?? "")
			.replace(/\.git$/i, "")
			.trim();
		if (!owner || !repo) continue;
		candidates.push({
			owner,
			repo,
			score: scoreGithubRepoCandidate(owner, repo),
		});
	}
	if (candidates.length === 0) return null;

	candidates.sort((a, b) => b.score - a.score);
	const best = candidates[0];
	if (!best) return null;

	const hasRepoHint = /(github|repo|repository|仓库|git)/i.test(input);
	const threshold = hasRepoHint ? 2 : 4;
	if (best.score < threshold) return null;
	return `${best.owner}/${best.repo}`;
}

function scoreFilePathCandidate(path: string): number {
	const p = path.trim();
	const lower = p.toLowerCase();
	let score = 0;
	if (lower.includes("docker-compose")) score += 10;
	if (lower.endsWith(".yml") || lower.endsWith(".yaml")) score += 4;
	if (lower.endsWith(".env")) score += 4;
	if (lower.includes("/")) score += 2;
	if (p.length > 0 && p.length <= 120) score += 1;
	return score;
}

function extractFilePathFromText(text: string): string | null {
	const input = text.trim();
	if (!input) return null;

	const quoted = input.match(
		/["'`“”‘’]([^"'`“”‘’\s]+\.(?:ya?ml|json|env|conf|toml|ini|ts|tsx|js|jsx|sh|md|txt|sql|csv))["'`“”‘’]/i,
	);
	if (quoted) {
		const v = String(quoted[1] ?? "").trim();
		if (v) return v.replaceAll("\\", "/");
	}

	const tokenRe =
		/(?:^|[\s(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:ya?ml|json|env|conf|toml|ini|ts|tsx|js|jsx|sh|md|txt|sql|csv))(?:$|[\s),.!?])/gi;
	const candidates: Array<{ value: string; score: number }> = [];
	for (const match of input.matchAll(tokenRe)) {
		const raw = String(match[1] ?? "").trim();
		if (!raw) continue;
		const normalized = raw.replaceAll("\\", "/");
		candidates.push({
			value: normalized,
			score: scoreFilePathCandidate(normalized),
		});
	}
	if (candidates.length === 0) return null;
	candidates.sort(
		(a, b) => b.score - a.score || a.value.length - b.value.length,
	);
	return candidates[0]?.value ?? null;
}

function buildReplyLanguageInstruction(uiLocale: string | null): string {
	return uiLocale
		? `Use the user's UI language (UI locale: ${uiLocale}).`
		: "Use the same language as the user.";
}

function shouldPreferChineseReply(params: {
	uiLocale: string | null;
	userMessage: string;
}): boolean {
	if (params.uiLocale) {
		const locale = params.uiLocale.toLowerCase();
		if (locale === "zh" || locale.startsWith("zh-")) return true;
	}
	return /[\u4e00-\u9fff]/.test(params.userMessage);
}

async function appendToolOutcomeAssistantMessage(_params: {
	conversationId?: string | null;
	toolName: string;
	executionId: string;
	outcome: "completed" | "failed" | "rejected";
	result?: { success: boolean; message?: string; error?: string };
}) {
	return;
}

async function generateToolOutcomeSummary(params: {
	model: unknown;
	providerOptions?: typeof OPENAI_RESPONSES_PROVIDER_OPTIONS;
	userMessage: string;
	uiLocale?: string | null;
	toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
	toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
	streamError?: string | null;
}): Promise<string> {
	const uiLocale = normalizeUiLocale(params.uiLocale);

	const buildFallback = () => {
		const looksChinese = shouldPreferChineseReply({
			uiLocale,
			userMessage: params.userMessage,
		});
		const toolNames = params.toolCalls
			.map((tc) => tc.name)
			.filter((name) => typeof name === "string" && name.trim().length > 0)
			.slice(0, 6)
			.join(", ");

		if (looksChinese) {
			return toolNames.length > 0
				? `已执行工具：${toolNames}。请查看工具执行结果。`
				: "已执行相关工具操作。请查看工具执行结果。";
		}
		return toolNames.length > 0
			? `Executed tool(s): ${toolNames}. Please review the tool results above.`
			: "Executed the requested tool actions. Please review the tool results above.";
	};

	const toolCallsText = params.toolCalls
		.map((tc) => {
			return `tool_call_id: ${tc.id}\ntool: ${tc.name}\nargs:\n${summarizeJsonForModelContext(tc.arguments, 1200)}`;
		})
		.join("\n\n");

	const toolResultsText = params.toolResults
		.map((tr) => {
			return `tool_call_id: ${tr.toolCallId}\ntool: ${tr.toolName}\nresult:\n${summarizeJsonForModelContext(tr.result, 1600)}`;
		})
		.join("\n\n");

	const streamErrorText =
		typeof params.streamError === "string" &&
		params.streamError.trim().length > 0
			? params.streamError.trim()
			: "";

	const prompt = `Write the final user-facing reply for this turn using the user request and tool calls/results.

Rules:
- ${buildReplyLanguageInstruction(uiLocale)} Plain text only. 3-8 lines. No secrets.
- If any result is pending approval (status="pending_approval"), ask the user to approve/reject.
- If any tool failed (success=false or has error), explain what failed and the next step.
- Otherwise, confirm completion and summarize.

User request:
${safeTruncateString(params.userMessage, 1200)}

Tool calls:
${toolCallsText || "(none)"}

Tool results:
${toolResultsText || "(none)"}

${streamErrorText ? `Model streaming error (non-fatal):\n${safeTruncateString(streamErrorText, 1200)}\n` : ""}

	Return ONLY the reply.`;

	try {
		const text = await generatePromptText({
			model: params.model,
			providerOptions: params.providerOptions,
			prompt,
			maxOutputTokens: 260,
		});
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed : buildFallback();
	} catch (error) {
		console.error("Failed to generate tool outcome summary:", error);
		return buildFallback();
	}
}

function injectToolExecutionContextMessage(
	messages: CoreMessage[],
	content: string,
): CoreMessage[] {
	const trimmed = content.trim();
	if (trimmed.length === 0) return messages;

	const insertIndex =
		messages.length > 0 && messages[messages.length - 1]?.role === "user"
			? messages.length - 1
			: messages.length;

	const next = messages.slice();
	next.splice(insertIndex, 0, { role: "system", content: trimmed });
	return next;
}

async function buildToolExecutionContextMessage(params: {
	conversationId: string;
	maxExecutions?: number;
	maxChars?: number;
}): Promise<string> {
	const maxExecutions = Math.min(Math.max(params.maxExecutions ?? 6, 1), 20);
	const maxChars = Math.min(Math.max(params.maxChars ?? 8000, 1500), 30000);

	const executions = await db.query.aiToolExecutions.findMany({
		where: eq(aiToolExecutions.conversationId, params.conversationId),
		orderBy: desc(aiToolExecutions.createdAt),
		limit: maxExecutions,
	});
	if (!executions || executions.length === 0) return "";

	const lines = executions
		.slice()
		.reverse()
		.map((e) => {
			const header = [
				`executionId: ${e.executionId}`,
				`tool: ${e.toolName}`,
				`status: ${e.status}`,
				e.requiresApproval ? "requiresApproval: true" : "",
				typeof e.createdAt === "string" && e.createdAt.length > 0
					? `createdAt: ${e.createdAt}`
					: "",
			]
				.filter(Boolean)
				.join("\n");

			const paramsText =
				e.parameters && typeof e.parameters === "object"
					? `params:\n${summarizeJsonForModelContext(e.parameters, 1200)}`
					: "";

			const resultText =
				e.result && typeof e.result === "object"
					? `result:\n${summarizeJsonForModelContext(e.result, 1800)}`
					: e.error
						? `error:\n${safeTruncateString(String(e.error), 1000)}`
						: "";

			return [header, paramsText, resultText].filter(Boolean).join("\n");
		});

	const content = `Recent tool executions (for context, newest last; truncated):\n${lines.join(
		"\n\n",
	)}`;
	return safeTruncateString(content, maxChars);
}

async function generatePromptText(params: {
	model: unknown;
	providerOptions?: typeof OPENAI_RESPONSES_PROVIDER_OPTIONS;
	prompt: string;
	maxOutputTokens?: number;
}): Promise<string> {
	try {
		const result = await generateText({
			model: params.model as any,
			providerOptions: params.providerOptions,
			prompt: params.prompt,
			maxOutputTokens: params.maxOutputTokens,
		});
		return typeof result.text === "string" ? result.text : "";
	} catch (error) {
		if (!isInvalidJsonLikelySse(error)) throw error;

		const stream = streamText({
			model: params.model as any,
			providerOptions: params.providerOptions,
			prompt: params.prompt,
			maxOutputTokens: params.maxOutputTokens,
		});
		let fullText = "";
		for await (const chunk of stream.fullStream) {
			if (chunk.type !== "text-delta") continue;
			const delta = (chunk as { text?: unknown }).text;
			if (typeof delta === "string" && delta.length > 0) {
				fullText += delta;
			}
		}
		return fullText;
	}
}

export type ChatResult = {
	message: Awaited<ReturnType<typeof saveMessage>>;
	usage: ChatUsage | undefined;
	toolResults: unknown;
};

export const chat = async ({
	conversationId,
	message,
	attachments,
	aiId,
	organizationId,
	userId,
	uiLocale,
}: ChatParams): Promise<ChatResult> => {
	const aiSettings = await getAiSettingById(aiId);
	if (!aiSettings || !aiSettings.isEnabled) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AI features are not enabled for this configuration",
		});
	}

	if (aiSettings.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this AI configuration",
		});
	}

	const conversation = await getConversationById(conversationId);
	if (conversation.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this conversation",
		});
	}

	const requestedUiLocale = normalizeUiLocale(uiLocale);
	const existingUiLocale = getUiLocaleFromMetadata(conversation.metadata);
	const effectiveUiLocale = requestedUiLocale ?? existingUiLocale;
	let conversationMetadata = conversation.metadata;
	let metadataChanged = false;
	if (requestedUiLocale && requestedUiLocale !== existingUiLocale) {
		conversationMetadata = setUiLocaleInMetadata(
			conversationMetadata,
			requestedUiLocale,
		);
		metadataChanged = true;
	}
	const inferredRepo = extractGithubRepoFromText(message);
	if (
		inferredRepo &&
		inferredRepo !== getGithubRepoFromMetadata(conversationMetadata)
	) {
		conversationMetadata = setGithubRepoInMetadata(
			conversationMetadata,
			inferredRepo,
		);
		metadataChanged = true;
	}
	if (metadataChanged) {
		await updateConversation(conversationId, {
			metadata: conversationMetadata ?? {},
		});
	}
	const conversationForPrompt =
		conversationMetadata === conversation.metadata
			? conversation
			: { ...conversation, metadata: conversationMetadata };

	initializeTools();

	// Save user message
	const normalizedAttachments = normalizeMessageAttachments(attachments);
	const userMessage = await saveMessage({
		conversationId,
		role: "user",
		content: message,
		attachments:
			normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
	});
	if (!userMessage) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to save user message",
		});
	}
	const userMessageId = userMessage.messageId;

	// Get conversation history
	const history = await getMessages({ conversationId, limit: 20 });

	// Build messages array for AI
	let messages: CoreMessage[] = history
		.map(messageToCoreMessage)
		.filter(Boolean) as CoreMessage[];

	const provider = selectAIProvider(aiSettings);
	const model = provider(aiSettings.model);
	const providerOptions = getOpenAIResponsesProviderOptions(aiSettings);

	let playbookPrompt = "";
	try {
		const embeddingProvider = await resolveEmbeddingProviderConfig({
			organizationId: conversation.organizationId,
			aiSettings,
		});
		const playbooks = await findRelevantPlaybooks({
			organizationId: conversation.organizationId,
			embeddingProvider,
			queryText: message,
		});
		playbookPrompt = buildPlaybookMemoryPrompt(playbooks);
	} catch {}

	const toolExposurePlan = buildToolExposurePlan({
		userMessage: message,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	});
	const baseSystemPrompt = [
		buildSystemPrompt(conversationForPrompt, toolExposurePlan.promptTools),
		playbookPrompt,
	]
		.filter((s) => typeof s === "string" && s.trim().length > 0)
		.join("\n\n");
	let systemPrompt = baseSystemPrompt;
	const refreshSystemPrompt = async () => {
		const toolExecutionContextMessage = await buildToolExecutionContextMessage({
			conversationId,
		});
		systemPrompt =
			toolExecutionContextMessage.trim().length > 0
				? `${baseSystemPrompt}\n\n${toolExecutionContextMessage.trim()}`
				: baseSystemPrompt;
	};
	await refreshSystemPrompt();

	// Build tool context
	const toolContext: ToolContext = {
		organizationId,
		userId,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	};

	const toolApprovalsDisabled =
		getToolApprovalsDisabledFromMetadata(conversationMetadata);
	const toolBudgetMode = getToolBudgetModeFromMetadata(conversationMetadata);
	const toolStepBudget = getToolStepBudget(toolBudgetMode);
	const tools = buildChatTools({
		conversationId,
		toolContext,
		messageId: userMessageId,
		toolApprovalsDisabled,
	});
	const activeTools = resolveActiveToolNames(
		tools,
		toolExposurePlan.activeMetaTools,
	);

	const initialSystemMode = getInitialSystemMode(aiSettings);

	const isLikelyActionRequest = (text: string): boolean => {
		if (!AUTO_EXECUTE_ACTION_REQUESTS) return false;
		const t = text.trim();
		if (t.length === 0) return false;
		const hasAction =
			/(备份|backup|卷备份|volume\s*backup|恢复|restore|迁移|migrate|部署|deploy|创建|新建|create|删除|移除|remove|delete|更新|修改|edit|update|设置|set|配置|config|启动|start|停止|stop|重启|restart|导入|import|导出|export|挂载|mount|日志|log|logs|容器|container|docker)/i.test(
				t,
			);
		if (!hasAction) return false;

		const looksLikeQuestion =
			/(\?|？|为什么|如何|怎么|是否|能否|可以吗|有吗|是什么|区别)/i.test(t);
		if (looksLikeQuestion) return false;

		return true;
	};

	const deriveTrpcSearchQueryHint = (text: string): string => {
		const tokens = new Set<string>();
		const add = (arr: string[]) => {
			for (const t of arr) {
				const trimmed = t.trim();
				if (trimmed) tokens.add(trimmed);
			}
		};

		if (/(备份|backup)/i.test(text)) add(["backup"]);
		if (/(卷备份|volume\s*backup)/i.test(text)) add(["volume", "backup"]);
		if (/(挂载|mount|卷|volume)/i.test(text)) add(["mount", "volume"]);
		if (/(日志|logs?)/i.test(text)) add(["logs", "log"]);
		if (/(容器|container|docker)/i.test(text)) add(["docker", "container"]);
		if (/(部署|deployment)/i.test(text)) add(["deployment"]);
		if (/(文件|file)/i.test(text)) add(["file"]);
		if (/(s3|r2|minio|对象存储|bucket|存储桶|destination)/i.test(text))
			add(["s3", "destination"]);
		if (/(计划|定时|cron|schedule)/i.test(text)) add(["schedule", "cron"]);
		if (/(保留|留存|retention|keep)/i.test(text)) add(["retention"]);
		if (/(项目|project)/i.test(text)) add(["project"]);
		if (/(环境|environment|env)/i.test(text)) add(["environment"]);
		if (/(环境变量|env\s*vars?|environment\s*variables?)/i.test(text))
			add(["env", "environment", "variables"]);
		if (/(域名|domain|dns)/i.test(text)) add(["domain", "dns"]);
		if (/(证书|certificate|ssl|https|tls)/i.test(text))
			add(["certificate", "ssl", "https", "tls"]);
		if (
			/(traefik|特雷菲克|反向代理|反代|网关|代理|转发|路由|ingress|reverse\s*proxy)/i.test(
				text,
			)
		)
			add(["traefik", "proxy", "router", "ingress"]);
		if (/(github|仓库|repo|repository|git)/i.test(text))
			add(["github", "repo"]);
		if (/(数据库|database|\bdb\b)/i.test(text)) add(["database", "db"]);
		if (/(postgres|postgresql|\bpg\b|pgsql|postgre)/i.test(text))
			add(["postgres", "pg"]);
		if (/(mysql)/i.test(text)) add(["mysql"]);
		if (/(mariadb)/i.test(text)) add(["mariadb"]);
		if (/(mongo|mongodb)/i.test(text)) add(["mongo", "mongodb"]);
		if (/(redis)/i.test(text)) add(["redis"]);

		const hint = Array.from(tokens).join(" ");
		if (hint.length > 0) return hint;
		const trimmed = text.trim();
		return trimmed.length > 0 ? trimmed.slice(0, 200) : "backup";
	};

	const runGenerate = async (
		withTools: boolean,
		systemMode: "system" | "inline" = "system",
		overrideSystemPrompt?: string,
	) => {
		const effectiveSystemPrompt = overrideSystemPrompt ?? systemPrompt;
		const nextMessages =
			systemMode === "inline"
				? [
						{
							role: "user" as const,
							content: `SYSTEM INSTRUCTIONS (treat as system):\n${effectiveSystemPrompt}`,
						},
						...messages,
					]
				: messages;
		return await generateText({
			model,
			providerOptions,
			system: systemMode === "system" ? effectiveSystemPrompt : undefined,
			messages: nextMessages,
			tools: withTools ? tools : undefined,
			activeTools: withTools ? activeTools : undefined,
			stopWhen: stepCountIs(toolStepBudget),
		});
	};

	type GeneratedTurn = Awaited<ReturnType<typeof generateText>>;

	const buildAgentContinuePrompt = () => {
		const clipped = safeTruncateString(message.trim(), 500);
		return [
			"Continue the task based on the conversation so far.",
			`User request: ${clipped}`,
			"",
			"Rules:",
			"- Use the recent tool execution context to avoid repeating completed work.",
			"- If more actions are required, call tools.",
			"- If the task is complete, provide a concise final confirmation and DO NOT call any tools.",
			'- Never ask the user to "wait" or say you are still "processing".',
		].join("\n");
	};

	const runGenerateWithFallback = async (
		overrideSystemPrompt?: string,
	): Promise<GeneratedTurn> => {
		let result: GeneratedTurn;
		try {
			result = await runGenerate(true, initialSystemMode, overrideSystemPrompt);
		} catch (error) {
			const aborted = false;
			if (isSystemMessagePlacementError(error) && !aborted) {
				try {
					result = await runGenerate(true, "inline", overrideSystemPrompt);
				} catch (retryError) {
					if (isMissingToolUseIdError(retryError)) {
						result = await runGenerate(false, "inline", overrideSystemPrompt);
					} else {
						throw retryError;
					}
				}
			} else if (isMissingToolUseIdError(error) && !aborted) {
				try {
					result = await runGenerate(
						false,
						initialSystemMode,
						overrideSystemPrompt,
					);
				} catch (retryError) {
					if (isSystemMessagePlacementError(retryError)) {
						result = await runGenerate(false, "inline", overrideSystemPrompt);
					} else {
						throw retryError;
					}
				}
			} else throw error;
		}
		return result;
	};

	const safeSuccessTools = new Set([
		"trpc_procedure_search",
		"trpc_procedure_suggest",
		"trpc_procedure_describe",
		"tool_search",
		"tool_suggest",
		"tool_describe",
	]);
	const isSafeSuccessTool = (toolName: string) => {
		if (safeSuccessTools.has(toolName)) return true;
		const t = toolRegistry.get(toolName);
		return !!t && t.riskLevel === "low" && !t.requiresApproval;
	};

	const agenticEnabled = toolApprovalsDisabled;
	const maxTurns = agenticEnabled ? 4 : 1;
	const maxPlatformToolCalls = agenticEnabled ? toolStepBudget : 0;

	let finalText = "";
	const allToolCalls: NonNullable<GeneratedTurn["toolCalls"]> = [];
	const allToolResults: unknown[] = [];
	const aggregatedUsage: { inputTokens?: number; outputTokens?: number } = {
		inputTokens: 0,
		outputTokens: 0,
	};
	let platformToolCalls = 0;

	for (let turn = 0; turn < maxTurns; turn++) {
		await refreshSystemPrompt();
		let result = await runGenerateWithFallback(systemPrompt);

		if (isLikelyActionRequest(message)) {
			for (let repairAttempt = 0; repairAttempt < 2; repairAttempt++) {
				const toolResults = (result as unknown as { toolResults?: unknown })
					.toolResults;
				const retryable = getRetryableToolCallFailures(toolResults);
				const needsToolKickoff = !Array.isArray(result.toolCalls)
					? true
					: !result.toolCalls.some((tc) => tc.toolName === "tool_call");
				const onlySafeSuccesses =
					retryable.successfulTools.length === 0 ||
					retryable.successfulTools.every(isSafeSuccessTool);
				const needsParamRepair =
					retryable.failures.length > 0 &&
					!retryable.hasPendingApproval &&
					onlySafeSuccesses;

				if (!((turn === 0 && needsToolKickoff) || needsParamRepair)) break;

				const hint = deriveTrpcSearchQueryHint(message);
				const hintForPrompt = hint
					.replaceAll("\\", "\\\\")
					.replaceAll('"', '\\"')
					.replaceAll("\n", " ")
					.replaceAll("\r", " ");
				const failureDetails = needsParamRepair
					? safeJsonForPrompt(retryable.failures, 2500)
					: "";
				const extra = `\n\nCRITICAL: The user request requires real platform actions.\nYou MUST use tools (not a text-only plan).\n- If you already know the exact tool/procedure + params, call tool_call directly.\n- If you need to discover tRPC procedures, use trpc_procedure_suggest (query: \"${hintForPrompt}\") or trpc_procedure_search, then call trpc_procedure_call.\n- If a tool_call failed due to invalid params or unknown tool, fix and retry immediately (use data.exampleToolCall if present).\n${failureDetails ? `\nPrevious tool_call failures:\n${failureDetails}\n` : ""}\nIf blocked, ask exactly ONE question.`;

				try {
					result = await runGenerateWithFallback(`${systemPrompt}${extra}`);
				} catch {
					break;
				}
			}
		}

		const turnText =
			normalizeAssistantMessageContent(
				"assistant",
				typeof result.text === "string" ? result.text : "",
			) ?? "";
		finalText += turnText;
		if (Array.isArray(result.toolCalls)) allToolCalls.push(...result.toolCalls);
		const toolResults = (result as unknown as { toolResults?: unknown })
			.toolResults;
		if (Array.isArray(toolResults)) allToolResults.push(...toolResults);
		aggregatedUsage.inputTokens =
			(aggregatedUsage.inputTokens ?? 0) + (result.usage?.inputTokens ?? 0);
		aggregatedUsage.outputTokens =
			(aggregatedUsage.outputTokens ?? 0) + (result.usage?.outputTokens ?? 0);

		if (!agenticEnabled || turn >= maxTurns - 1) break;

		const retryable = getRetryableToolCallFailures(toolResults);
		const platformThisTurn = Array.isArray(result.toolCalls)
			? result.toolCalls.filter((tc) => tc.toolName === "tool_call").length
			: 0;
		platformToolCalls += platformThisTurn;

		if (retryable.hasPendingApproval) break;
		if (platformThisTurn <= 0) break;
		if (maxPlatformToolCalls > 0 && platformToolCalls >= maxPlatformToolCalls)
			break;

		const assistantSnippet = safeTruncateString(turnText.trim(), 4000);
		if (assistantSnippet.length > 0) {
			messages = messages.concat({
				role: "assistant",
				content: assistantSnippet,
			});
		}
		messages = messages.concat({
			role: "user",
			content: buildAgentContinuePrompt(),
		});
	}

	// Save assistant response
	const executionIdByToolCallId = new Map<string, string>();
	const invokedToolNameByToolCallId = new Map<string, string>();
	for (const tr of allToolResults) {
		if (!tr || typeof tr !== "object") continue;
		const resultValue = (tr as { result?: unknown }).result;
		if (!resultValue || typeof resultValue !== "object") continue;

		const toolCallId =
			(tr as { toolCallId?: unknown }).toolCallId ??
			(tr as { id?: unknown }).id;
		if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
			continue;
		}
		const toolCallIdKey = toolCallId.trim();

		const invokedTool =
			(resultValue as { invokedTool?: unknown }).invokedTool ??
			(resultValue as { toolName?: unknown }).toolName;
		if (typeof invokedTool === "string" && invokedTool.trim().length > 0) {
			invokedToolNameByToolCallId.set(toolCallIdKey, invokedTool.trim());
		}

		{
			const executionId = (resultValue as { executionId?: unknown })
				.executionId;
			const nestedExecutionId =
				(resultValue as { data?: unknown }).data &&
				typeof (resultValue as { data?: unknown }).data === "object"
					? ((resultValue as { data?: { executionId?: unknown } }).data
							?.executionId as unknown)
					: undefined;
			const picked =
				typeof executionId === "string"
					? executionId
					: typeof nestedExecutionId === "string"
						? nestedExecutionId
						: "";
			if (picked.trim().length > 0) {
				executionIdByToolCallId.set(toolCallIdKey, picked.trim());
			}
		}
	}

	const toolCallsToPersist = (allToolCalls ?? [])
		.filter((tc) => tc.toolName === "tool_call")
		.map((tc) => {
			const rawArgs =
				(tc as unknown as { args?: unknown; input?: unknown }).args ??
				(tc as unknown as { args?: unknown; input?: unknown }).input ??
				{};
			const toolNameFromArgs =
				rawArgs &&
				typeof rawArgs === "object" &&
				"toolName" in (rawArgs as any) &&
				typeof (rawArgs as any).toolName === "string"
					? String((rawArgs as any).toolName)
					: tc.toolName;
			const toolName =
				invokedToolNameByToolCallId.get(tc.toolCallId.trim()) ??
				toolNameFromArgs;
			const toolParams =
				rawArgs && typeof rawArgs === "object" && "params" in (rawArgs as any)
					? (rawArgs as any).params
					: rawArgs;
			return {
				id: tc.toolCallId,
				type: "function" as const,
				executionId: executionIdByToolCallId.get(tc.toolCallId),
				function: {
					name: toolName,
					arguments: JSON.stringify(toolParams ?? {}),
				},
			};
		});

	const assistantMessage = await saveMessage({
		conversationId,
		role: "assistant",
		content: finalText,
		toolCalls: toolCallsToPersist.length > 0 ? toolCallsToPersist : undefined,
		promptTokens: aggregatedUsage.inputTokens,
		completionTokens: aggregatedUsage.outputTokens,
	});

	scheduleConversationSummaryUpdate({
		conversationId,
		model,
		providerOptions,
	});

	// Set deterministic title for new conversation (non-blocking)
	if (history.length <= 2 && conversation.title === "New Conversation") {
		const title = String(message ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 50);
		if (title)
			void updateConversation(conversationId, { title }).catch(() => {});
	}

	const usage: ChatUsage | undefined =
		aggregatedUsage.inputTokens != null || aggregatedUsage.outputTokens != null
			? {
					inputTokens: aggregatedUsage.inputTokens,
					outputTokens: aggregatedUsage.outputTokens,
				}
			: undefined;

	return {
		message: assistantMessage,
		usage,
		toolResults: allToolResults as unknown,
	};
};

// ============================================
// Streaming Chat Function (SSE)
// ============================================

export type ChatStreamOptions = {
	abortSignal?: AbortSignal;
	onStart?: (info: {
		assistantMessageId: string;
		userMessageId?: string;
	}) => void;
	onTextDelta?: (delta: string) => void;
	onReasoningDelta?: (delta: string) => void;
	onToolCall?: (toolCallId: string, toolName: string, args: unknown) => void;
	onToolResult?: (
		toolCallId: string,
		toolName: string,
		result: unknown,
	) => void;
	onError?: (error: string) => void;
};

export const chatStream = async (
	{
		conversationId,
		message,
		attachments,
		aiId,
		organizationId,
		userId,
		uiLocale,
		persistUserMessage,
		historyBefore,
		assistantMessageId: overrideAssistantMessageId,
		sourceUserMessageId: overrideSourceUserMessageId,
	}: ChatParams,
	options: ChatStreamOptions = {},
) => {
	const aiSettings = await getAiSettingById(aiId);
	if (!aiSettings || !aiSettings.isEnabled) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AI features are not enabled for this configuration",
		});
	}

	if (aiSettings.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this AI configuration",
		});
	}

	const conversation = await getConversationById(conversationId);
	if (conversation.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this conversation",
		});
	}

	const requestedUiLocale = normalizeUiLocale(uiLocale);
	const existingUiLocale = getUiLocaleFromMetadata(conversation.metadata);
	const effectiveUiLocale = requestedUiLocale ?? existingUiLocale;
	let conversationMetadata = conversation.metadata;
	let metadataChanged = false;
	if (requestedUiLocale && requestedUiLocale !== existingUiLocale) {
		conversationMetadata = setUiLocaleInMetadata(
			conversationMetadata,
			requestedUiLocale,
		);
		metadataChanged = true;
	}
	const inferredRepo = extractGithubRepoFromText(message);
	if (
		inferredRepo &&
		inferredRepo !== getGithubRepoFromMetadata(conversationMetadata)
	) {
		conversationMetadata = setGithubRepoInMetadata(
			conversationMetadata,
			inferredRepo,
		);
		metadataChanged = true;
	}
	if (metadataChanged) {
		await updateConversation(conversationId, {
			metadata: conversationMetadata ?? {},
		});
	}
	const conversationForPrompt =
		conversationMetadata === conversation.metadata
			? conversation
			: { ...conversation, metadata: conversationMetadata };

	initializeTools();

	const shouldPersistUserMessage = persistUserMessage !== false;
	const normalizedAttachments = normalizeMessageAttachments(attachments);
	let userMessageId: string | undefined =
		!shouldPersistUserMessage &&
		typeof overrideSourceUserMessageId === "string" &&
		overrideSourceUserMessageId.trim().length > 0
			? overrideSourceUserMessageId.trim()
			: undefined;
	if (shouldPersistUserMessage) {
		const userMessage = await saveMessage({
			conversationId,
			role: "user",
			content: message,
			attachments:
				normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
		});
		if (!userMessage) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Failed to save user message",
			});
		}
		userMessageId = userMessage.messageId;
	}

	const history = await getMessages({
		conversationId,
		limit: 20,
		before: historyBefore?.before,
		beforeMessageId: historyBefore?.beforeMessageId,
	});
	let messages: CoreMessage[] = history
		.map(messageToCoreMessage)
		.filter(Boolean) as CoreMessage[];

	if (!shouldPersistUserMessage) {
		const trimmed = message.trim();
		if (trimmed.length > 0 || normalizedAttachments.length > 0) {
			const synthetic = messageToCoreMessage({
				role: "user",
				content: trimmed.length > 0 ? trimmed : "Continue.",
				attachments: normalizedAttachments,
				toolCalls: null,
			});
			if (synthetic) {
				messages = messages.concat(synthetic);
			}
		}
	}

	const normalizedOverrideAssistantMessageId =
		typeof overrideAssistantMessageId === "string"
			? overrideAssistantMessageId.trim()
			: "";
	let assistantMessage: AiMessageRow;
	if (normalizedOverrideAssistantMessageId.length > 0) {
		const existing = await db.query.aiMessages.findFirst({
			where: eq(aiMessages.messageId, normalizedOverrideAssistantMessageId),
			columns: {
				messageId: true,
				conversationId: true,
				role: true,
				createdAt: true,
			},
		});
		if (
			!existing ||
			existing.conversationId !== conversationId ||
			existing.role !== "assistant"
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Invalid assistant message",
			});
		}
		const updated = await updateMessage({
			messageId: normalizedOverrideAssistantMessageId,
			conversationId,
			role: "assistant",
			content: "",
			attachments: null,
			toolCalls: null,
			toolCallId: null,
			toolName: null,
			promptTokens: null,
			completionTokens: null,
		});
		if (!updated) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Assistant message not found",
			});
		}
		assistantMessage = updated;
	} else {
		const saved = await saveMessage({
			conversationId,
			role: "assistant",
			content: "",
		});
		if (!saved) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Failed to save assistant message",
			});
		}
		assistantMessage = saved;
	}

	const assistantMessageId = assistantMessage.messageId;

	await upsertDisplayMessageSnapshot({
		messageId: assistantMessageId,
		conversationId,
		sourceMessageId: assistantMessageId,
		role: "assistant",
		kind: "message",
		content: "",
		reasoning: null,
		toolCalls: null,
		status: "sending",
		error: null,
		createdAt: assistantMessage.createdAt,
	});

	try {
		options.onStart?.({ assistantMessageId, userMessageId });
	} catch {}

	let assistantRawTextContent = "";
	let assistantTextContent = "";
	let assistantReasoning = "";
	let latestToolCallsSnapshot: AiMessageRow["toolCalls"] | null | undefined =
		null;
	let latestToolResultsSnapshot: unknown[] = [];

	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	let lastPersistedSignature = "";
	let persistChain: Promise<unknown> = Promise.resolve();

	const enqueuePersist = () => {
		const content = assistantTextContent;
		const reasoning = assistantReasoning;
		persistChain = persistChain
			.then(async () => {
				await updateMessage({
					messageId: assistantMessageId,
					conversationId,
					content,
				});
				await upsertDisplayMessageSnapshot({
					messageId: assistantMessageId,
					conversationId,
					sourceMessageId: assistantMessageId,
					role: "assistant",
					kind: "message",
					content,
					reasoning,
					status: "sending",
					createdAt: assistantMessage.createdAt,
				});
			})
			.catch(() => undefined);
	};

	const schedulePersist = () => {
		if (persistTimer) return;
		persistTimer = setTimeout(() => {
			persistTimer = null;
			const signature = `${assistantTextContent.length}:${assistantReasoning.length}`;
			if (signature === lastPersistedSignature) return;
			lastPersistedSignature = signature;
			enqueuePersist();
		}, 300);
	};

	const flushPersist = async () => {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
		const signature = `${assistantTextContent.length}:${assistantReasoning.length}`;
		if (signature !== lastPersistedSignature) {
			lastPersistedSignature = signature;
			enqueuePersist();
		}
		try {
			await persistChain;
		} catch {}
	};

	const emitTextDelta = (delta: string) => {
		if (typeof delta !== "string" || delta.length === 0) return;
		assistantRawTextContent += delta;
		const nextVisibleText = stripAssistantToolMarkers(assistantRawTextContent);
		const visibleDelta = nextVisibleText.startsWith(assistantTextContent)
			? nextVisibleText.slice(assistantTextContent.length)
			: "";
		assistantTextContent = nextVisibleText;
		schedulePersist();
		if (visibleDelta.length === 0) return;
		try {
			options.onTextDelta?.(visibleDelta);
		} catch {
			// Ignore callback errors (e.g., client disconnected)
		}
	};

	const emitReasoningDelta = (delta: string) => {
		if (typeof delta !== "string" || delta.length === 0) return;
		assistantReasoning += delta;
		schedulePersist();
		try {
			options.onReasoningDelta?.(delta);
		} catch {
			// Ignore callback errors (e.g., client disconnected)
		}
	};

	const emitToolMarker = (_toolCallId: string) => {
		schedulePersist();
	};

	try {
		const provider = selectAIProvider(aiSettings);
		const model = provider(aiSettings.model);
		const providerOptions = getOpenAIResponsesProviderOptions(aiSettings);

		let playbookPrompt = "";
		try {
			const embeddingProvider = await resolveEmbeddingProviderConfig({
				organizationId: conversation.organizationId,
				aiSettings,
			});
			const playbooks = await findRelevantPlaybooks({
				organizationId: conversation.organizationId,
				embeddingProvider,
				queryText: message,
			});
			playbookPrompt = buildPlaybookMemoryPrompt(playbooks);
		} catch {}

		const toolExposurePlan = buildToolExposurePlan({
			userMessage: message,
			projectId: conversation.projectId || undefined,
			serverId: conversation.serverId || undefined,
		});
		const baseSystemPrompt = [
			buildSystemPrompt(conversationForPrompt, toolExposurePlan.promptTools),
			playbookPrompt,
		]
			.filter((s) => typeof s === "string" && s.trim().length > 0)
			.join("\n\n");
		let systemPrompt = baseSystemPrompt;
		const refreshSystemPrompt = async () => {
			const toolExecutionContextMessage =
				await buildToolExecutionContextMessage({
					conversationId,
				});
			systemPrompt =
				toolExecutionContextMessage.trim().length > 0
					? `${baseSystemPrompt}\n\n${toolExecutionContextMessage.trim()}`
					: baseSystemPrompt;
		};
		await refreshSystemPrompt();

		const toolContext: ToolContext = {
			organizationId,
			userId,
			projectId: conversation.projectId || undefined,
			serverId: conversation.serverId || undefined,
		};

		const toolApprovalsDisabled =
			getToolApprovalsDisabledFromMetadata(conversationMetadata);
		const toolBudgetMode = getToolBudgetModeFromMetadata(conversationMetadata);
		const toolStepBudget = getToolStepBudget(toolBudgetMode);
		const tools = buildChatTools({
			conversationId,
			toolContext,
			messageId: userMessageId,
			toolApprovalsDisabled,
		});
		const activeTools = resolveActiveToolNames(
			tools,
			toolExposurePlan.activeMetaTools,
		);

		const initialSystemMode = getInitialSystemMode(aiSettings);

		const isLikelyActionRequest = (text: string): boolean => {
			if (!AUTO_EXECUTE_ACTION_REQUESTS) return false;
			const t = text.trim();
			if (t.length === 0) return false;
			const hasAction =
				/(备份|backup|恢复|restore|迁移|migrate|部署|deploy|创建|create|删除|delete|移除|remove|更新|update|修改|编辑|设置|set|配置|config|启动|start|停止|stop|重启|restart|导入|import|导出|export|挂载|mount|日志|log|logs|容器|container|docker)/i.test(
					t,
				);
			if (!hasAction) return false;

			const imperative =
				/(帮我|请|麻烦|替我|给我|执行|操作|把.*(备份|backup|恢复|restore|迁移|migrate|部署|deploy|创建|create|删除|delete|更新|update|修改|edit|设置|set|配置|config|启动|start|停止|stop|重启|restart|导入|import|导出|export|日志|log|logs|容器|container|docker))/i.test(
					t,
				);
			if (imperative) return true;

			const looksLikeQuestion =
				/(\?|？|怎么|如何|为何|为什么|是什么|区别|原理|能不能|可以吗|是否)/i.test(
					t,
				);
			return !looksLikeQuestion;
		};

		const deriveTrpcSearchQueryHint = (text: string): string => {
			const q = text.toLowerCase();
			const tokens = new Set<string>();
			const add = (arr: string[]) => {
				for (const t of arr) {
					const trimmed = t.trim();
					if (trimmed) tokens.add(trimmed);
				}
			};

			if (/(备份|backup)/i.test(text)) add(["backup"]);
			if (/(卷备份|volume\s*backup)/i.test(text)) add(["volume", "backup"]);
			if (/(挂载|mount|卷|volume)/i.test(text)) add(["mount", "volume"]);
			if (/(日志|logs?)/i.test(text)) add(["logs", "log"]);
			if (/(容器|container|docker)/i.test(text)) add(["docker", "container"]);
			if (/(部署|deployment)/i.test(text)) add(["deployment"]);
			if (/(文件|file)/i.test(text)) add(["file"]);
			if (/(s3|r2|minio|对象存储|bucket|存储桶|destination)/i.test(text))
				add(["s3", "destination"]);
			if (/(每天|定时|cron|schedule)/i.test(text)) add(["schedule", "cron"]);
			if (/(最多|保留|retention|keep)/i.test(text)) add(["retention"]);
			if (/(项目|project)/i.test(text)) add(["project"]);
			if (/(环境|environment|env)/i.test(text)) add(["environment"]);
			if (/(环境变量|env\s*vars?|environment\s*variables?)/i.test(text))
				add(["env", "environment", "variables"]);
			if (/(域名|domain|dns)/i.test(text)) add(["domain", "dns"]);
			if (/(证书|certificate|ssl|https|tls)/i.test(text))
				add(["certificate", "ssl", "https", "tls"]);
			if (
				/(traefik|特雷菲克|反向代理|反代|网关|代理|转发|路由|ingress|reverse\s*proxy)/i.test(
					text,
				)
			)
				add(["traefik", "proxy", "router", "ingress"]);
			if (/(github|仓库|repo|repository|git)/i.test(text))
				add(["github", "repo"]);
			if (/(数据库|database|\bdb\b)/i.test(text)) add(["database", "db"]);
			if (/(postgres|postgresql|\bpg\b|pgsql|postgre)/i.test(text))
				add(["postgres", "pg"]);
			if (/(mysql)/i.test(text)) add(["mysql"]);
			if (/(mariadb)/i.test(text)) add(["mariadb"]);
			if (/(mongo|mongodb)/i.test(text)) add(["mongo", "mongodb"]);
			if (/(redis)/i.test(text)) add(["redis"]);

			const hint = Array.from(tokens).join(" ");
			if (hint.length > 0) return hint;
			const trimmed = q.trim();
			return trimmed.length > 0 ? trimmed.slice(0, 200) : "backup";
		};

		const runStream = async (
			withTools: boolean,
			systemMode: "system" | "inline" = "system",
			overrideSystemPrompt?: string,
		) => {
			const stopWhen = stepCountIs(toolStepBudget);
			const effectiveSystemPrompt = overrideSystemPrompt ?? systemPrompt;
			const nextMessages =
				systemMode === "inline"
					? [
							{
								role: "user" as const,
								content: `SYSTEM INSTRUCTIONS (treat as system):\n${effectiveSystemPrompt}`,
							},
							...messages,
						]
					: messages;
			const stream = streamText({
				model,
				providerOptions,
				system: systemMode === "system" ? effectiveSystemPrompt : undefined,
				messages: nextMessages,
				tools: withTools ? tools : undefined,
				activeTools: withTools ? activeTools : undefined,
				stopWhen,
				abortSignal: options.abortSignal,
			});

			let fullText = "";
			const toolCalls: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
				sourceToolName: string;
			}> = [];
			const toolNameByToolCallId = new Map<string, string>();
			let usage: { promptTokens?: number; completionTokens?: number } = {};
			let finishReason: string | null = null;
			const toolResults: Array<{
				toolCallId: string;
				toolName: string;
				result: unknown;
			}> = [];
			let streamError: string | null = null;
			let hasAnyOutput = false;

			const persistAssistantProgress = () => {
				const mergedToolCalls = buildPersistedToolCallsFromStreamState(
					[...allToolCalls, ...toolCalls],
					[...allToolResults, ...toolResults],
				);
				const mergedToolResults = [...allToolResults, ...toolResults];
				latestToolCallsSnapshot = mergedToolCalls;
				latestToolResultsSnapshot = mergedToolResults;
				persistChain = persistChain
					.then(async () => {
						await updateMessage({
							messageId: assistantMessageId,
							conversationId,
							content: assistantTextContent,
							toolCalls: mergedToolCalls.length > 0 ? mergedToolCalls : null,
						});
						await upsertDisplayMessageSnapshot({
							messageId: assistantMessageId,
							conversationId,
							sourceMessageId: assistantMessageId,
							role: "assistant",
							kind: "message",
							content: assistantTextContent,
							reasoning: assistantReasoning,
							toolCalls: buildDisplayToolCalls({
								toolCalls: mergedToolCalls,
								toolResults: mergedToolResults,
							}),
							status: "sending",
							createdAt: assistantMessage.createdAt,
						});
					})
					.catch(() => undefined);
			};

			try {
				for await (const chunk of stream.fullStream) {
					if (chunk.type === "text-delta") {
						const delta = typeof chunk.text === "string" ? chunk.text : "";
						if (delta.length === 0) continue;
						hasAnyOutput = true;

						fullText += delta;
						emitTextDelta(delta);
					} else if (chunk.type === "reasoning-delta") {
						const delta = typeof chunk.text === "string" ? chunk.text : "";
						if (delta.length === 0) continue;
						hasAnyOutput = true;
						emitReasoningDelta(delta);
					} else if (chunk.type === "tool-call") {
						hasAnyOutput = true;
						emitToolMarker(chunk.toolCallId);
						const args = (chunk as { input: unknown }).input;
						const normalizedToolName = (() => {
							if (chunk.toolName !== "tool_call") return chunk.toolName;
							if (!args || typeof args !== "object" || Array.isArray(args)) {
								return chunk.toolName;
							}
							const value = (args as { toolName?: unknown }).toolName;
							return typeof value === "string" && value.trim().length > 0
								? value.trim()
								: chunk.toolName;
						})();
						const normalizedArgs = (() => {
							if (chunk.toolName !== "tool_call") return args ?? {};
							if (!args || typeof args !== "object" || Array.isArray(args)) {
								return args ?? {};
							}
							const value = (args as { params?: unknown }).params;
							return value ?? {};
						})();
						toolNameByToolCallId.set(chunk.toolCallId, normalizedToolName);
						toolCalls.push({
							id: chunk.toolCallId,
							type: "function",
							function: {
								name: normalizedToolName,
								arguments: JSON.stringify(normalizedArgs ?? {}),
							},
							sourceToolName: chunk.toolName,
						});
						try {
							options.onToolCall?.(
								chunk.toolCallId,
								normalizedToolName,
								normalizedArgs ?? {},
							);
						} catch {
							// Ignore callback errors
						}
						persistAssistantProgress();
					} else if (chunk.type === "tool-result") {
						hasAnyOutput = true;
						const toolResult =
							(chunk as unknown as { result?: unknown }).result ??
							(chunk as unknown as { output?: unknown }).output ??
							chunk;
						const resolvedToolName = (() => {
							const current =
								toolNameByToolCallId.get(chunk.toolCallId) ?? chunk.toolName;
							if (!toolResult || typeof toolResult !== "object") return current;
							const invoked =
								(toolResult as { invokedTool?: unknown }).invokedTool ??
								(toolResult as { toolName?: unknown }).toolName;
							if (typeof invoked !== "string") return current;
							const trimmed = invoked.trim();
							return trimmed.length > 0 ? trimmed : current;
						})();
						if (
							typeof resolvedToolName === "string" &&
							resolvedToolName.trim().length > 0
						) {
							toolNameByToolCallId.set(chunk.toolCallId, resolvedToolName);
							const idx = toolCalls.findIndex(
								(tc) => tc.id === chunk.toolCallId,
							);
							if (idx >= 0) {
								const existing = toolCalls[idx];
								if (existing) {
									toolCalls[idx] = {
										...existing,
										function: { ...existing.function, name: resolvedToolName },
									};
								}
							}
						}
						toolResults.push({
							toolCallId: chunk.toolCallId,
							toolName: resolvedToolName,
							result: toolResult,
						});
						try {
							options.onToolResult?.(
								chunk.toolCallId,
								resolvedToolName,
								toolResult,
							);
						} catch {
							// Ignore callback errors
						}
						persistAssistantProgress();
					} else if (chunk.type === "finish") {
						const usageObj = (chunk as { totalUsage?: unknown }).totalUsage as
							| { inputTokens?: number; outputTokens?: number }
							| undefined;
						usage = {
							promptTokens: usageObj?.inputTokens,
							completionTokens: usageObj?.outputTokens,
						};
						const reason = (chunk as { finishReason?: unknown }).finishReason;
						finishReason = typeof reason === "string" ? reason : finishReason;
					} else if (chunk.type === "error") {
						streamError = normalizeUnknownToString(
							(chunk as unknown as { error?: unknown }).error,
						);
					}
				}
			} catch (error) {
				if ((error as Error).name === "AbortError") {
					// Client disconnected, save what we have
				} else {
					streamError = getProviderErrorText(error);
				}
			}

			if (
				streamError != null &&
				!options.abortSignal?.aborted &&
				!hasAnyOutput
			) {
				throw new Error(streamError);
			}

			return {
				fullText: stripAssistantToolMarkers(fullText),
				toolCalls,
				toolResults,
				usage,
				streamError,
				finishReason,
			};
		};

		type StreamedTurn = Awaited<ReturnType<typeof runStream>>;

		const buildPersistedToolCallsFromStreamState = (
			toolCalls: StreamedTurn["toolCalls"],
			toolResults: StreamedTurn["toolResults"],
		) => {
			const executionIdByToolCallId = new Map<string, string>();
			const invokedToolNameByToolCallId = new Map<string, string>();

			for (const tr of toolResults) {
				if (!tr || typeof tr !== "object") continue;
				const resultValue = (tr as { result?: unknown }).result;
				if (!resultValue || typeof resultValue !== "object") continue;

				const invokedTool =
					(resultValue as { invokedTool?: unknown }).invokedTool ??
					(resultValue as { toolName?: unknown }).toolName;
				if (typeof invokedTool === "string" && invokedTool.trim().length > 0) {
					invokedToolNameByToolCallId.set(tr.toolCallId, invokedTool.trim());
				}

				const executionId = (resultValue as { executionId?: unknown })
					.executionId;
				const nestedExecutionId =
					(resultValue as { data?: unknown }).data &&
					typeof (resultValue as { data?: unknown }).data === "object"
						? ((resultValue as { data?: { executionId?: unknown } }).data
								?.executionId as unknown)
						: undefined;
				const picked =
					typeof executionId === "string"
						? executionId
						: typeof nestedExecutionId === "string"
							? nestedExecutionId
							: "";
				if (picked.trim().length > 0) {
					executionIdByToolCallId.set(tr.toolCallId, picked.trim());
				}
			}

			return toolCalls.map((tc) => {
				const toolName =
					invokedToolNameByToolCallId.get(tc.id) ||
					tc.function.name ||
					"tool_call";
				return {
					id: tc.id,
					type: "function" as const,
					executionId: executionIdByToolCallId.get(tc.id),
					function: {
						name: toolName,
						arguments: tc.function.arguments,
					},
				};
			});
		};

		const buildAgentContinuePrompt = () => {
			const clipped = safeTruncateString(message.trim(), 500);
			return [
				"Continue the task based on the conversation so far.",
				`User request: ${clipped}`,
				"",
				"Rules:",
				"- Use the recent tool execution context to avoid repeating completed work.",
				"- If more actions are required, call tools.",
				"- If the task is complete, provide a concise final confirmation and DO NOT call any tools.",
				'- Never ask the user to "wait" or say you are still "processing".',
			].join("\n");
		};

		const runStreamWithFallback = async (
			overrideSystemPrompt?: string,
		): Promise<StreamedTurn> => {
			let streamed: StreamedTurn;
			try {
				streamed = await runStream(
					true,
					initialSystemMode,
					overrideSystemPrompt,
				);
			} catch (error) {
				const aborted = options.abortSignal?.aborted;
				if (!aborted && isSystemMessagePlacementError(error)) {
					try {
						streamed = await runStream(true, "inline", overrideSystemPrompt);
					} catch (retryError) {
						if (!aborted && isMissingToolUseIdError(retryError)) {
							streamed = await runStream(false, "inline", overrideSystemPrompt);
						} else {
							throw retryError;
						}
					}
				} else if (!aborted && isMissingToolUseIdError(error)) {
					try {
						streamed = await runStream(
							false,
							initialSystemMode,
							overrideSystemPrompt,
						);
					} catch (retryError) {
						if (!aborted && isSystemMessagePlacementError(retryError)) {
							streamed = await runStream(false, "inline", overrideSystemPrompt);
						} else {
							throw retryError;
						}
					}
				} else throw error;
			}
			return streamed;
		};

		const safeSuccessTools = new Set([
			"trpc_procedure_search",
			"trpc_procedure_suggest",
			"trpc_procedure_describe",
			"tool_search",
			"tool_suggest",
			"tool_describe",
		]);
		const isSafeSuccessTool = (toolName: string) => {
			if (safeSuccessTools.has(toolName)) return true;
			const t = toolRegistry.get(toolName);
			return !!t && t.riskLevel === "low" && !t.requiresApproval;
		};

		const agenticEnabled = toolApprovalsDisabled;
		const maxTurns = agenticEnabled ? 4 : 1;
		const maxPlatformToolCalls = agenticEnabled ? toolStepBudget : 0;

		let fullText = "";
		const allToolCalls: StreamedTurn["toolCalls"] = [];
		const allToolResults: StreamedTurn["toolResults"] = [];
		const aggregatedUsage: {
			promptTokens?: number;
			completionTokens?: number;
		} = {
			promptTokens: 0,
			completionTokens: 0,
		};
		let streamError: string | null = null;
		let lastFinishReason: string | null = null;
		let needsContinue = false;
		let platformToolCalls = 0;

		const likelyActionRequest = isLikelyActionRequest(message);

		for (let turn = 0; turn < maxTurns; turn++) {
			if (options.abortSignal?.aborted) break;

			await refreshSystemPrompt();
			const turnStreams: StreamedTurn[] = [];
			let streamed = await runStreamWithFallback(systemPrompt);
			turnStreams.push(streamed);

			if (!options.abortSignal?.aborted && likelyActionRequest) {
				for (let repairAttempt = 0; repairAttempt < 2; repairAttempt++) {
					const retryable = getRetryableToolCallFailures(streamed.toolResults);
					const needsToolKickoff = streamed.toolCalls.every(
						(tc) => tc.sourceToolName !== "tool_call",
					);
					const onlySafeSuccesses =
						retryable.successfulTools.length === 0 ||
						retryable.successfulTools.every(isSafeSuccessTool);
					const needsParamRepair =
						retryable.failures.length > 0 &&
						!retryable.hasPendingApproval &&
						onlySafeSuccesses;

					if (!((turn === 0 && needsToolKickoff) || needsParamRepair)) break;

					const hint = deriveTrpcSearchQueryHint(message);
					const hintForPrompt = hint
						.replaceAll("\\", "\\\\")
						.replaceAll('"', '\\"')
						.replaceAll("\n", " ")
						.replaceAll("\r", " ");
					const failureDetails = needsParamRepair
						? safeJsonForPrompt(retryable.failures, 2500)
						: "";
					const extra = `\n\nCRITICAL: The user request requires real platform actions.\nYou MUST use tools (not a text-only plan).\n- If you already know the exact tool/procedure + params, call tool_call directly.\n- If you need to discover tRPC procedures, use trpc_procedure_suggest (query: \"${hintForPrompt}\") or trpc_procedure_search, then call trpc_procedure_call.\n- If a tool_call failed due to invalid params or unknown tool, fix and retry immediately (use data.exampleToolCall if present).\n${failureDetails ? `\nPrevious tool_call failures:\n${failureDetails}\n` : ""}\nIf blocked, ask exactly ONE question.`;
					try {
						await refreshSystemPrompt();
						streamed = await runStreamWithFallback(`${systemPrompt}${extra}`);
						turnStreams.push(streamed);
					} catch {
						break;
					}
				}
			}

			const turnToolCalls: StreamedTurn["toolCalls"] = [];
			const turnToolResults: StreamedTurn["toolResults"] = [];
			for (const streamedChunk of turnStreams) {
				fullText += streamedChunk.fullText;
				allToolCalls.push(...streamedChunk.toolCalls);
				allToolResults.push(...streamedChunk.toolResults);
				turnToolCalls.push(...streamedChunk.toolCalls);
				turnToolResults.push(...streamedChunk.toolResults);
				if (typeof streamedChunk.finishReason === "string") {
					lastFinishReason = streamedChunk.finishReason;
				}
				aggregatedUsage.promptTokens =
					(aggregatedUsage.promptTokens ?? 0) +
					(streamedChunk.usage.promptTokens ?? 0);
				aggregatedUsage.completionTokens =
					(aggregatedUsage.completionTokens ?? 0) +
					(streamedChunk.usage.completionTokens ?? 0);
				if (
					typeof streamedChunk.streamError === "string" &&
					streamedChunk.streamError.length > 0
				) {
					streamError = streamedChunk.streamError;
				}
			}

			if (!agenticEnabled || turn >= maxTurns - 1) break;

			const retryable = getRetryableToolCallFailures(turnToolResults);
			const platformThisTurn = turnToolCalls.filter(
				(tc) => tc.sourceToolName === "tool_call",
			).length;
			platformToolCalls += platformThisTurn;

			if (retryable.hasPendingApproval) break;
			if (platformThisTurn <= 0) break;
			if (
				maxPlatformToolCalls > 0 &&
				platformToolCalls >= maxPlatformToolCalls
			) {
				needsContinue = true;
				break;
			}

			const assistantSnippet = safeTruncateString(
				streamed.fullText.trim(),
				4000,
			);
			if (assistantSnippet.length > 0) {
				messages = messages.concat({
					role: "assistant",
					content: assistantSnippet,
				});
			}
			messages = messages.concat({
				role: "user",
				content: buildAgentContinuePrompt(),
			});
		}

		await flushPersist();

		const toolCallsToPersist = buildPersistedToolCallsFromStreamState(
			allToolCalls,
			allToolResults,
		);
		latestToolCallsSnapshot = toolCallsToPersist;
		latestToolResultsSnapshot = allToolResults;

		const persistedContent = stripAssistantToolMarkers(
			assistantTextContent.length > 0 ? assistantTextContent : fullText,
		);

		const updatedAssistantMessage = await updateMessage({
			messageId: assistantMessageId,
			conversationId,
			role: "assistant",
			content: persistedContent,
			toolCalls: toolCallsToPersist.length > 0 ? toolCallsToPersist : null,
			promptTokens: aggregatedUsage.promptTokens ?? null,
			completionTokens: aggregatedUsage.completionTokens ?? null,
		});

		const finalAssistantStatus: DisplayMessageStatus = options.abortSignal
			?.aborted
			? "stopped"
			: "sent";
		await syncDisplayMessageFromRawMessage(updatedAssistantMessage, {
			reasoning: assistantReasoning,
			status: finalAssistantStatus,
			toolResults: allToolResults,
		});

		const usage: ChatUsage | undefined =
			aggregatedUsage.promptTokens != null ||
			aggregatedUsage.completionTokens != null
				? {
						inputTokens: aggregatedUsage.promptTokens,
						outputTokens: aggregatedUsage.completionTokens,
					}
				: undefined;

		scheduleConversationSummaryUpdate({
			conversationId,
			model,
			providerOptions,
		});

		// Set deterministic title for new conversation (non-blocking)
		if (history.length <= 2 && conversation.title === "New Conversation") {
			const title = String(message ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 50);
			if (title)
				void updateConversation(conversationId, { title }).catch(() => {});
		}

		if (
			!options.abortSignal?.aborted &&
			(lastFinishReason === "tool-calls" || lastFinishReason === "length")
		) {
			needsContinue = true;
		}

		return {
			message: updatedAssistantMessage ?? assistantMessage,
			usage,
			toolResults: [],
			needsContinue,
			finishReason: lastFinishReason ?? undefined,
		};
	} catch (error) {
		try {
			await flushPersist();
		} catch {}

		try {
			await updateMessage({
				messageId: assistantMessageId,
				conversationId,
				role: "assistant",
				content: assistantTextContent,
			});
			await upsertDisplayMessageSnapshot({
				messageId: assistantMessageId,
				conversationId,
				sourceMessageId: assistantMessageId,
				role: "assistant",
				kind: "message",
				content: assistantTextContent,
				reasoning: assistantReasoning,
				toolCalls: buildDisplayToolCalls({
					toolCalls: latestToolCallsSnapshot,
					toolResults: latestToolResultsSnapshot,
				}),
				status: options.abortSignal?.aborted ? "stopped" : "error",
				error: options.abortSignal?.aborted
					? null
					: getProviderErrorText(error),
				createdAt: assistantMessage.createdAt,
			});
		} catch {}
		throw error;
	} finally {
		if (persistTimer) {
			clearTimeout(persistTimer);
			persistTimer = null;
		}
	}
};

type PlaybookStep = {
	toolName: string;
	procedureName?: string;
	inputKeys?: string[];
};

function addDaysIso(days: number, from = new Date()): string {
	const ms = Math.max(0, Number(days) || 0) * 24 * 60 * 60 * 1000;
	return new Date(from.getTime() + ms).toISOString();
}

function normalizePlaybookInputKeys(inputKeys?: string[]): string[] {
	if (!Array.isArray(inputKeys)) return [];
	return Array.from(
		new Set(
			inputKeys
				.map((key) => String(key ?? "").trim())
				.filter((key) => key.length > 0),
		),
	)
		.sort((left, right) => left.localeCompare(right))
		.slice(0, 40);
}

function buildPlaybookSignature(steps: PlaybookStep[]): string {
	const text = steps
		.map((step) => {
			const inputKeys = normalizePlaybookInputKeys(step.inputKeys);
			return [
				step.toolName.trim(),
				step.procedureName?.trim() ?? "",
				inputKeys.join(","),
			].join(":");
		})
		.join("|");
	return createHash("sha256").update(text).digest("hex");
}

function extractTopLevelKeys(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return normalizePlaybookInputKeys(Object.keys(value));
}

function derivePlaybookTagsFromSteps(steps: PlaybookStep[]): string[] {
	const tags = new Set<string>();
	for (const step of steps) {
		const proc =
			typeof step.procedureName === "string" ? step.procedureName : "";
		const prefix = proc.includes(".") ? proc.split(".")[0] : "";
		if (prefix) tags.add(prefix);
	}
	return Array.from(tags).slice(0, 12);
}

function buildPlaybookVectorText(params: {
	intent: string;
	steps: PlaybookStep[];
	tags: string[];
}): string {
	const stepText = params.steps
		.map((step) => {
			const inputKeys = normalizePlaybookInputKeys(step.inputKeys);
			const parts = [step.toolName];
			if (step.procedureName) parts.push(step.procedureName);
			if (inputKeys.length > 0) parts.push(`inputs:${inputKeys.join(",")}`);
			return parts.join(" ");
		})
		.join("\n");
	const tagText =
		params.tags.length > 0 ? `\nTags: ${params.tags.join(", ")}` : "";
	return `${params.intent.trim()}\n${stepText}${tagText}`.trim();
}

type PlaybookMatchSource = "embedding" | "hash";
type PlaybookMatchRow = {
	playbookId: string;
	intent: string;
	summary: string | null;
	steps: PlaybookStep[];
	successCount: number;
	failCount: number;
	lastUsedAt: string | null;
	signature: string;
	distance: number;
	source: PlaybookMatchSource;
};

const PLAYBOOK_CLEANUP_TTL_MS = 60 * 60 * 1000;
const playbookCleanupThrottle = new Map<string, number>();

function isIndexedEmbeddingDimension(dim: number): boolean {
	if (!Number.isInteger(dim) || dim <= 0) return false;
	if (dim > PLAYBOOK_MAX_INDEXABLE_EMBEDDING_DIMENSIONS) return false;
	return PLAYBOOK_INDEXED_EMBEDDING_DIMENSIONS.includes(
		dim as (typeof PLAYBOOK_INDEXED_EMBEDDING_DIMENSIONS)[number],
	);
}

function buildEmbeddingDistanceExpr(vector: number[], dim: number) {
	const literal = JSON.stringify(vector);
	if (isIndexedEmbeddingDimension(dim)) {
		return sql<number>`${sql.raw(
			`(("ai_agent_playbook"."embeddingVector")::halfvec(${dim}) <=> '${literal}'::halfvec(${dim}))`,
		)}`.as("distance");
	}
	return sql<number>`${aiAgentPlaybooks.embeddingVector} <=> ${literal}::vector`.as(
		"distance",
	);
}

function getPlaybookReliabilityScore(playbook: {
	successCount: number;
	failCount: number;
}): number {
	return (
		(Number(playbook.successCount) || 0) - (Number(playbook.failCount) || 0)
	);
}

function comparePlaybookMatches(
	left: PlaybookMatchRow,
	right: PlaybookMatchRow,
): number {
	if (left.source !== right.source) {
		return left.source === "embedding" ? -1 : 1;
	}
	const leftDistance = Number.isFinite(left.distance)
		? left.distance
		: Number.POSITIVE_INFINITY;
	const rightDistance = Number.isFinite(right.distance)
		? right.distance
		: Number.POSITIVE_INFINITY;
	if (leftDistance !== rightDistance) return leftDistance - rightDistance;
	const reliabilityDiff =
		getPlaybookReliabilityScore(right) - getPlaybookReliabilityScore(left);
	if (reliabilityDiff !== 0) return reliabilityDiff;
	return String(right.lastUsedAt ?? "").localeCompare(
		String(left.lastUsedAt ?? ""),
	);
}

function uniquePlaybookIds(ids: string[]): string[] {
	return Array.from(
		new Set(
			ids.map((id) => String(id ?? "").trim()).filter((id) => id.length > 0),
		),
	);
}

function scheduleExpiredPlaybookCleanup(organizationId: string) {
	const orgId = String(organizationId ?? "").trim();
	if (!orgId) return;
	const now = Date.now();
	const nextAllowedAt = playbookCleanupThrottle.get(orgId) ?? 0;
	if (nextAllowedAt > now) return;
	playbookCleanupThrottle.set(orgId, now + PLAYBOOK_CLEANUP_TTL_MS);
	void db
		.delete(aiAgentPlaybooks)
		.where(
			and(
				eq(aiAgentPlaybooks.organizationId, orgId),
				lt(aiAgentPlaybooks.expiresAt, new Date().toISOString()),
			),
		)
		.catch(() => {
			playbookCleanupThrottle.set(orgId, Date.now() + 5 * 60 * 1000);
		});
}

async function incrementPlaybookFailureCounts(params: {
	organizationId: string;
	playbookIds: string[];
}): Promise<void> {
	const playbookIds = uniquePlaybookIds(params.playbookIds);
	if (playbookIds.length === 0) return;
	try {
		await db
			.update(aiAgentPlaybooks)
			.set({
				failCount: sql`${aiAgentPlaybooks.failCount} + 1`,
				lastUsedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(aiAgentPlaybooks.organizationId, params.organizationId),
					inArray(aiAgentPlaybooks.playbookId, playbookIds),
				),
			);
	} catch {}
}

async function findRelevantPlaybooks(params: {
	organizationId: string;
	embeddingProvider?: EmbeddingProviderConfig | null;
	queryText: string;
	limit?: number;
}): Promise<
	Array<{
		playbookId: string;
		intent: string;
		summary: string | null;
		steps: PlaybookStep[];
		successCount: number;
		failCount: number;
		lastUsedAt: string | null;
		signature: string;
		distance: number;
	}>
> {
	const limit = Math.max(
		1,
		Math.min(
			10,
			Number(params.limit ?? PLAYBOOK_DEFAULT_TOP_K) || PLAYBOOK_DEFAULT_TOP_K,
		),
	);
	const candidateLimit = Math.max(
		limit,
		limit * PLAYBOOK_QUERY_CANDIDATE_MULTIPLIER,
	);
	const nowIso = new Date().toISOString();

	const embedding = await tryEmbedText({
		embeddingProvider: params.embeddingProvider,
		text: params.queryText,
	});

	const queryEmbedding = async () => {
		if (!embedding) return [];
		try {
			const distanceExpr = buildEmbeddingDistanceExpr(
				embedding.vector,
				embedding.dim,
			);
			return await db
				.select({
					playbookId: aiAgentPlaybooks.playbookId,
					intent: aiAgentPlaybooks.intent,
					summary: aiAgentPlaybooks.summary,
					steps: aiAgentPlaybooks.steps,
					successCount: aiAgentPlaybooks.successCount,
					failCount: aiAgentPlaybooks.failCount,
					lastUsedAt: aiAgentPlaybooks.lastUsedAt,
					signature: aiAgentPlaybooks.signature,
					distance: distanceExpr,
				})
				.from(aiAgentPlaybooks)
				.where(
					and(
						eq(aiAgentPlaybooks.organizationId, params.organizationId),
						gt(aiAgentPlaybooks.expiresAt, nowIso),
						eq(aiAgentPlaybooks.embeddingModel, embedding.model),
						eq(aiAgentPlaybooks.embeddingDim, embedding.dim),
						isNotNull(aiAgentPlaybooks.embeddingVector),
					),
				)
				.orderBy(distanceExpr, desc(aiAgentPlaybooks.lastUsedAt))
				.limit(candidateLimit);
		} catch {
			return [];
		}
	};

	const queryHash = async () => {
		const vec = hashTextToUnitVector(
			params.queryText,
			PLAYBOOK_HASH_DIMENSIONS,
		);
		try {
			const distanceExpr =
				sql<number>`${aiAgentPlaybooks.hashVector} <=> ${JSON.stringify(
					vec,
				)}::vector`.as("distance");
			return await db
				.select({
					playbookId: aiAgentPlaybooks.playbookId,
					intent: aiAgentPlaybooks.intent,
					summary: aiAgentPlaybooks.summary,
					steps: aiAgentPlaybooks.steps,
					successCount: aiAgentPlaybooks.successCount,
					failCount: aiAgentPlaybooks.failCount,
					lastUsedAt: aiAgentPlaybooks.lastUsedAt,
					signature: aiAgentPlaybooks.signature,
					distance: distanceExpr,
				})
				.from(aiAgentPlaybooks)
				.where(
					and(
						eq(aiAgentPlaybooks.organizationId, params.organizationId),
						gt(aiAgentPlaybooks.expiresAt, nowIso),
					),
				)
				.orderBy(distanceExpr, desc(aiAgentPlaybooks.lastUsedAt))
				.limit(candidateLimit);
		} catch {
			return [];
		}
	};

	const [embeddingRows, hashRows] = await Promise.all([
		queryEmbedding(),
		queryHash(),
	]);
	const merged = new Map<string, PlaybookMatchRow>();

	for (const row of embeddingRows || []) {
		if (
			!Number.isFinite(row.distance) ||
			row.distance > PLAYBOOK_EMBEDDING_MAX_DISTANCE
		) {
			continue;
		}
		merged.set(row.playbookId, { ...row, source: "embedding" });
	}

	for (const row of hashRows || []) {
		if (
			!Number.isFinite(row.distance) ||
			row.distance > PLAYBOOK_HASH_MAX_DISTANCE
		) {
			continue;
		}
		if (!merged.has(row.playbookId)) {
			merged.set(row.playbookId, { ...row, source: "hash" });
		}
	}

	const picked = Array.from(merged.values())
		.sort(comparePlaybookMatches)
		.slice(0, limit);

	if (picked.length > 0) {
		const ids = uniquePlaybookIds(
			picked.map((playbook) => playbook.playbookId),
		);
		const nextExpiry = addDaysIso(PLAYBOOK_RETENTION_DAYS);
		if (ids.length > 0) {
			try {
				await db
					.update(aiAgentPlaybooks)
					.set({ lastUsedAt: nowIso, expiresAt: nextExpiry })
					.where(
						and(
							eq(aiAgentPlaybooks.organizationId, params.organizationId),
							inArray(aiAgentPlaybooks.playbookId, ids),
						),
					);
			} catch {}
		}
	}

	return picked.map((p) => ({
		...p,
		steps: Array.isArray(p.steps) ? (p.steps as PlaybookStep[]) : [],
	}));
}

function buildPlaybookMemoryPrompt(
	playbooks: Array<{
		intent: string;
		summary: string | null;
		steps: PlaybookStep[];
		successCount: number;
		failCount: number;
		lastUsedAt: string | null;
		distance: number;
	}>,
): string {
	if (!Array.isArray(playbooks) || playbooks.length === 0) return "";

	const items = playbooks
		.map((p, idx) => {
			const title = safeTruncateString(
				p.summary?.trim() || p.intent.trim(),
				140,
			);
			const meta = [
				`success=${Number(p.successCount) || 0}`,
				`fail=${Number(p.failCount) || 0}`,
				p.lastUsedAt ? `lastUsed=${p.lastUsedAt}` : "",
			]
				.filter(Boolean)
				.join(" ");

			const steps = p.steps
				.slice(0, 12)
				.map((s) => {
					if (s.toolName === "trpc_procedure_call" && s.procedureName) {
						const keys =
							Array.isArray(s.inputKeys) && s.inputKeys.length > 0
								? ` (input keys: ${s.inputKeys.join(", ")})`
								: "";
						return `- ${s.toolName}: ${s.procedureName}${keys}`;
					}
					return `- ${s.toolName}${s.procedureName ? `: ${s.procedureName}` : ""}`;
				})
				.join("\n");

			return [
				`#${idx + 1} ${title}${meta ? ` [${meta}]` : ""}`,
				steps.length > 0 ? steps : "- (no steps recorded)",
			].join("\n");
		})
		.join("\n\n");

	return [
		"PLAYBOOK MEMORY (organization-scoped, from past successful runs):",
		"- If the user request matches a playbook below, follow its steps directly and SKIP exploratory calls (tool_search/trpc_procedure_search/suggest) unless needed.",
		"- Prefer calling trpc_procedure_call with the correct procedureName and input. Use trpc_procedure_describe only if you need the latest schema.",
		"- If a required tool needs approval and approvals are manual, create the pending_approval tool_call and stop.",
		"",
		items,
	].join("\n");
}

async function upsertPlaybookFromSuccessfulRun(params: {
	organizationId: string;
	embeddingProvider?: EmbeddingProviderConfig | null;
	goal: string;
	runId: string;
	finalSummary: string;
}): Promise<void> {
	const goal = params.goal.trim();
	if (!goal) return;

	const executions = await db.query.aiToolExecutions.findMany({
		where: eq(aiToolExecutions.runId, params.runId),
		orderBy: desc(aiToolExecutions.createdAt),
		limit: 200,
	});
	if (executions.length === 0) return;

	const ordered = executions.slice().reverse();
	const steps: PlaybookStep[] = [];
	for (const exec of ordered) {
		if (exec.status !== "completed") continue;
		const result = exec.result as unknown as { success?: unknown } | undefined;
		if (!result || result.success !== true) continue;

		if (exec.toolName === "trpc_procedure_call") {
			const paramsObj = exec.parameters as unknown as
				| Record<string, unknown>
				| undefined;
			const procedureName =
				paramsObj && typeof paramsObj.procedureName === "string"
					? paramsObj.procedureName.trim()
					: "";
			if (!procedureName) continue;
			const input =
				paramsObj && typeof paramsObj.input !== "undefined"
					? paramsObj.input
					: paramsObj && typeof paramsObj.params !== "undefined"
						? paramsObj.params
						: undefined;
			steps.push({
				toolName: "trpc_procedure_call",
				procedureName,
				inputKeys: extractTopLevelKeys(input),
			});
		}
	}

	if (steps.length === 0) return;

	scheduleExpiredPlaybookCleanup(params.organizationId);

	const tags = derivePlaybookTagsFromSteps(steps);
	const vectorText = buildPlaybookVectorText({ intent: goal, steps, tags });
	const hashVector = hashTextToUnitVector(vectorText, PLAYBOOK_HASH_DIMENSIONS);
	const signature = buildPlaybookSignature(steps);

	const now = new Date();
	const nowIso = now.toISOString();
	const expiresAt = addDaysIso(PLAYBOOK_RETENTION_DAYS, now);

	const embedding = await tryEmbedText({
		embeddingProvider: params.embeddingProvider,
		text: vectorText,
	});
	const nextSet: {
		intent: string;
		summary: string;
		tags: string[];
		steps: PlaybookStep[];
		lastUsedAt: string;
		expiresAt: string;
		hashVector: number[];
		successCount: ReturnType<typeof sql>;
		embeddingModel?: string;
		embeddingDim?: number;
		embeddingVector?: number[];
	} = {
		intent: goal,
		summary: safeTruncateString(params.finalSummary.trim(), 600),
		tags,
		steps,
		lastUsedAt: nowIso,
		expiresAt,
		hashVector,
		successCount: sql`${aiAgentPlaybooks.successCount} + 1`,
	};
	if (embedding) {
		nextSet.embeddingModel = embedding.model;
		nextSet.embeddingDim = embedding.dim;
		nextSet.embeddingVector = embedding.vector;
	}

	await db
		.insert(aiAgentPlaybooks)
		.values({
			organizationId: params.organizationId,
			signature,
			intent: goal,
			summary: safeTruncateString(params.finalSummary.trim(), 600),
			tags,
			steps,
			successCount: 1,
			failCount: 0,
			lastUsedAt: nowIso,
			expiresAt,
			hashVector,
			embeddingModel: embedding?.model ?? null,
			embeddingDim: embedding?.dim ?? null,
			embeddingVector: embedding?.vector ?? null,
		})
		.onConflictDoUpdate({
			target: [aiAgentPlaybooks.organizationId, aiAgentPlaybooks.signature],
			set: nextSet,
		});
}

function buildSystemPrompt(
	conversation: Awaited<ReturnType<typeof getConversationById>>,
	availableTools: ToolPromptInfo[],
) {
	let context = "";
	if (conversation.projectId) {
		context += `\nUser is viewing project: ${conversation.projectId}`;
	}
	if (conversation.serverId) {
		context += `\nUser is on server: ${conversation.serverId}`;
	}
	const githubRepo = getGithubRepoFromMetadata(conversation.metadata);
	if (githubRepo) {
		context += `\nDefault GitHub repo: ${githubRepo}`;
	}
	context += `\nPlatform mode: ${IS_CLOUD ? "cloud" : "self-hosted"}`;
	context += `\nTool approvals: ${getToolApprovalsDisabledFromMetadata(conversation.metadata) ? "disabled" : "manual"}`;

	const memorySummary =
		conversation.metadata &&
		typeof conversation.metadata === "object" &&
		"summary" in conversation.metadata &&
		typeof (conversation.metadata as { summary?: unknown }).summary === "string"
			? String((conversation.metadata as { summary?: unknown }).summary)
			: "";
	const uiLocale = getUiLocaleFromMetadata(conversation.metadata);
	const availableToolNames = new Set(availableTools.map((tool) => tool.name));

	const toolList = availableTools
		.map((t) => {
			const header = `- ${t.name}: ${t.description} (Risk: ${t.riskLevel}${t.requiresApproval ? ", requires approval" : ""})`;
			const params =
				typeof t.parameters === "string" && t.parameters.trim().length > 0
					? `\n  Parameters:\n${t.parameters
							.split("\n")
							.map((line) => `  ${line}`)
							.join("\n")}`
					: "";
			return `${header}${params}`;
		})
		.join("\n");

	const toolUsageGuideline = (() => {
		const hasSuggest = availableToolNames.has("tool_suggest");
		const hasSearch = availableToolNames.has("tool_search");
		const hasDescribe = availableToolNames.has("tool_describe");

		if (hasSearch) {
			return "Tools: if you know the exact tool + params, call tool_call directly; otherwise use tool_suggest/tool_search/tool_describe, then tool_call.";
		}
		if (hasSuggest && hasDescribe) {
			return "Tools: if you know the exact tool + params, call tool_call directly; otherwise use tool_suggest and tool_describe to stay within the preselected tool set, then tool_call.";
		}
		if (hasDescribe) {
			return "Tools: prefer the preselected tools above. If one seems correct but params are unclear, use tool_describe, then tool_call.";
		}
		return "Tools: prefer the preselected tools above and call tool_call directly when you know the exact tool + params.";
	})();

	const toolScopeGuideline = availableToolNames.has("tool_search")
		? "Tool scope: only the tools listed above are preselected for this turn; if you need something else, use tool_suggest/tool_search first."
		: "Tool scope: only the tools listed above are preselected for this turn; prefer them first and avoid broad exploration unless blocked.";

	const guidelines = `Guidelines:
- Language: ${buildReplyLanguageInstruction(uiLocale)}
- Be concise; ask at most 1-3 focused questions only if blocking.
- ${toolUsageGuideline}
- ${toolScopeGuideline}
- tRPC: procedures are NOT tools. To find procedures, use tool_call -> trpc_procedure_suggest (preferred) or trpc_procedure_search (params must include {query}). To call a procedure, use tool_call -> trpc_procedure_call OR call tool_call with toolName="<router>.<procedure>" and params=<procedure input> (it will be routed to trpc_procedure_call). Queries run without approval; mutations may require approval.
- MCP: MCP servers expose tools dynamically. MCP tool names use the format "mcp/<mcpServerId>/<toolName>". Use tool_search (query: "mcp" or server/tool name) to discover them, tool_describe for schemas, then tool_call with params as the MCP tool arguments object.
 - Approvals (critical): if a tool requires approval AND tool approvals are manual, you MUST create a tool_call that returns status="pending_approval" (do not ask in natural language without a tool_call). Include ALL required params (including any confirm literal); do NOT send empty params as a placeholder. Tell the user to approve/reject in the UI (or type "批准/拒绝"). If tool approvals are disabled for this conversation, proceed without asking for approval.
- Tool UX: do not narrate tool names or internal errors; focus on outcomes. If a tool fails due to invalid params/unknown tool, correct and retry (use tool_describe/tool_search as needed). Ask the user only when blocked.
- Context: reuse recent tool results; do not re-run the same read-only checks/config reads unnecessarily.
- ServerId: self-hosted defaults to the local Dokploy host when serverId is missing; only require serverId for remote targets. Cloud mode requires serverId for server operations.
- Containers: project_containers relies on services.appName. If it returns "No Dokploy services with appName", do NOT conclude there are no running containers. Continue by re-running project_containers with includeUnmatched=true, calling docker.getContainers (via trpc_procedure_call), or asking for serverId/container name.
- Safety: run low-risk read tools immediately; for medium/high-risk actions, explain before executing; if approval is required, create the pending_approval tool_call first.
- Accuracy: never invent tool names; never guess IDs. Use list/find/get tools; ask the user to confirm only when ambiguous.
- Idempotency: before creating backups/schedules (or other recurring resources), list existing items first and avoid duplicates; prefer updating an existing item when it matches the intent.
- Volume backups: to back up ALL mounts, set volumeName="ALL" (internally it maps to "dokploy_all_mounts"; accept both). For compose + ALL mounts, serviceName is required; for application + ALL mounts, applicationId is required.
- Defaults: if the user says "直接执行/用默认/别问/少问", proceed with safe defaults and ask at most 1 blocking question to avoid harm.
- Results: clearly report tool outcomes; if the toolset is insufficient, say what's missing and the next best step.
- Repo/code changes: if you must change a Git repo, ask whether to create a PR; read files first and show a unified diff before writing (approval required).
- Deploy/debug: start with deployment status/logs; explain root cause and evidence if it cannot be fixed.
- DB deploy: identify project/environment first; for PostgreSQL 17 prefer image "postgres:17".`;

	return `You are Dokploy AI Assistant (DevOps for the Dokploy PaaS).
You can call tools that perform real operations on the platform.

Current Context:${context || " General conversation"}

Conversation Memory Summary:${memorySummary ? `\n${memorySummary}` : " (none)"}

Available Tools (selected for this request):
${toolList}

${guidelines}`;
}

// ============================================
// Agent Operations
// ============================================

export const createRun = async (params: {
	conversationId: string;
	goal: string;
}) => {
	const [run] = await db
		.insert(aiRuns)
		.values({
			conversationId: params.conversationId,
			goal: params.goal,
			status: "planning",
		})
		.returning();
	return run;
};

export const getRunById = async (runId: string) => {
	const run = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, runId),
		with: {
			toolExecutions: true,
		},
	});
	if (!run) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Run not found",
		});
	}
	return run;
};

export const updateRun = async (
	runId: string,
	data: Partial<{
		status:
			| "pending"
			| "planning"
			| "waiting_approval"
			| "executing"
			| "verifying"
			| "completed"
			| "failed"
			| "cancelled";
		plan: {
			steps: Array<{
				id: string;
				toolName: string;
				description: string;
				parameters: Record<string, unknown>;
				requiresApproval: boolean;
			}>;
		};
		result: { success: boolean; summary: string; data?: unknown };
		error: string;
		startedAt: string;
		completedAt: string;
	}>,
) => {
	const [updated] = await db
		.update(aiRuns)
		.set(data)
		.where(eq(aiRuns.runId, runId))
		.returning();
	return updated;
};

const agentRunAbortControllers = new Map<string, AbortController>();

function getOrCreateAgentRunAbortController(runId: string): AbortController {
	const normalized = typeof runId === "string" ? runId.trim() : "";
	const existing = normalized
		? agentRunAbortControllers.get(normalized)
		: undefined;
	if (existing && !existing.signal.aborted) return existing;
	const controller = new AbortController();
	if (normalized) agentRunAbortControllers.set(normalized, controller);
	return controller;
}

function abortAgentRun(runId: string) {
	const normalized = typeof runId === "string" ? runId.trim() : "";
	if (!normalized) return;
	const controller = agentRunAbortControllers.get(normalized);
	if (!controller || controller.signal.aborted) return;
	try {
		controller.abort();
	} catch {}
}

function clearAgentRunAbortController(runId: string) {
	const normalized = typeof runId === "string" ? runId.trim() : "";
	if (!normalized) return;
	agentRunAbortControllers.delete(normalized);
}

function isAbortLikeError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	return "name" in error && (error as { name?: unknown }).name === "AbortError";
}

export const cancelRun = async (runId: string) => {
	const normalized = typeof runId === "string" ? runId.trim() : "";
	if (!normalized) return null;

	abortAgentRun(normalized);

	const run = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, normalized),
		columns: { conversationId: true },
	});
	const conversationId =
		typeof run?.conversationId === "string" ? run.conversationId : "";
	const updated = await updateRun(normalized, {
		status: "cancelled",
		completedAt: new Date().toISOString(),
	});

	if (conversationId) {
		try {
			const assistantMessageId = buildAgentRunAssistantMessageId(normalized);
			const existingAssistant = assistantMessageId
				? await db.query.aiMessages.findFirst({
						where: eq(aiMessages.messageId, assistantMessageId),
						columns: { content: true },
					})
				: null;
			const current =
				typeof existingAssistant?.content === "string"
					? existingAssistant.content
					: "";
			if (current.trim().length === 0) {
				await ensureAgentAssistantMessage({
					conversationId,
					runId: normalized,
				});
			}
			await upsertDisplayMessageSnapshot({
				messageId: assistantMessageId,
				conversationId,
				sourceMessageId: assistantMessageId,
				runId: normalized,
				role: "assistant",
				kind: "agent",
				content: current.trim().length > 0 ? current : null,
				status: "stopped",
				error: null,
			});
		} catch {}

		try {
			await saveAgentEventMessage({
				conversationId,
				payload: {
					type: "agent.run.finish",
					runId: normalized,
					status: "cancelled",
				},
			});
		} catch {}
	}

	return updated;
};

const saveAgentEventMessage = async (params: {
	conversationId: string;
	payload: Record<string, unknown>;
}) => {
	await db.insert(aiMessages).values({
		conversationId: params.conversationId,
		role: "system",
		content: JSON.stringify(params.payload),
	});
};

function buildAgentRunAssistantMessageId(runId: string): string {
	const normalized = typeof runId === "string" ? runId.trim() : "";
	return normalized.length > 0 ? `agent-run-${normalized}` : "";
}

async function ensureAgentAssistantMessage(params: {
	conversationId: string;
	runId: string;
}): Promise<string> {
	const messageId = buildAgentRunAssistantMessageId(params.runId);
	if (!messageId) return "";
	try {
		const existing = await db.query.aiMessages.findFirst({
			where: eq(aiMessages.messageId, messageId),
			columns: { messageId: true },
		});
		if (existing?.messageId) return messageId;
	} catch {}
	try {
		await saveMessage({
			messageId,
			conversationId: params.conversationId,
			role: "assistant",
			content: "",
		});
	} catch {}
	return messageId;
}

function buildPersistedToolCallsFromResults(params: {
	toolCalls: unknown[];
	toolResults: unknown[];
}): Array<{
	id: string;
	type: "function";
	executionId?: string;
	function: { name: string; arguments: string };
}> {
	const executionIdByToolCallId = new Map<string, string>();
	const invokedToolNameByToolCallId = new Map<string, string>();
	for (const tr of params.toolResults) {
		if (!tr || typeof tr !== "object") continue;
		const resultValue = (tr as { result?: unknown }).result;
		if (!resultValue || typeof resultValue !== "object") continue;

		const toolCallId =
			(tr as { toolCallId?: unknown }).toolCallId ??
			(tr as { id?: unknown }).id;
		if (typeof toolCallId !== "string" || toolCallId.trim().length === 0)
			continue;
		const toolCallIdKey = toolCallId.trim();

		const invokedTool =
			(resultValue as { invokedTool?: unknown }).invokedTool ??
			(resultValue as { toolName?: unknown }).toolName;
		if (typeof invokedTool === "string" && invokedTool.trim().length > 0) {
			invokedToolNameByToolCallId.set(toolCallIdKey, invokedTool.trim());
		}

		const executionId = (resultValue as { executionId?: unknown }).executionId;
		const nestedExecutionId =
			(resultValue as { data?: unknown }).data &&
			typeof (resultValue as { data?: unknown }).data === "object"
				? ((resultValue as { data?: { executionId?: unknown } }).data
						?.executionId as unknown)
				: undefined;
		const picked =
			typeof executionId === "string"
				? executionId
				: typeof nestedExecutionId === "string"
					? nestedExecutionId
					: "";
		if (picked.trim().length > 0) {
			executionIdByToolCallId.set(toolCallIdKey, picked.trim());
		}
	}

	const out: Array<{
		id: string;
		type: "function";
		executionId?: string;
		function: { name: string; arguments: string };
	}> = [];
	const seen = new Set<string>();

	for (const tc of params.toolCalls) {
		if (!tc || typeof tc !== "object") continue;
		if ((tc as any).toolName !== "tool_call") continue;
		const toolCallId =
			typeof (tc as any).toolCallId === "string"
				? (tc as any).toolCallId.trim()
				: "";
		if (!toolCallId) continue;
		if (seen.has(toolCallId)) continue;
		seen.add(toolCallId);

		const rawArgs = (tc as any).args ?? (tc as any).input ?? {};
		const toolNameFromArgs =
			rawArgs &&
			typeof rawArgs === "object" &&
			"toolName" in rawArgs &&
			typeof (rawArgs as any).toolName === "string"
				? String((rawArgs as any).toolName)
				: (tc as any).toolName;
		const toolName =
			invokedToolNameByToolCallId.get(toolCallId) ??
			String(toolNameFromArgs ?? "tool");
		const toolParams =
			rawArgs && typeof rawArgs === "object" && "params" in rawArgs
				? (rawArgs as any).params
				: rawArgs;
		out.push({
			id: toolCallId,
			type: "function" as const,
			executionId: executionIdByToolCallId.get(toolCallId),
			function: {
				name: toolName,
				arguments: JSON.stringify(toolParams ?? {}),
			},
		});
	}

	return out;
}

const AGENT_RUN_MAX_CONCURRENCY = Math.max(
	1,
	Number(process.env.DOKPLOY_AI_AGENT_MAX_CONCURRENCY ?? "2") || 2,
);
let agentRunActive = 0;
const agentRunQueue: Array<() => Promise<void>> = [];
const agentRunInFlight = new Set<string>();

function drainAgentRunQueue() {
	while (
		agentRunActive < AGENT_RUN_MAX_CONCURRENCY &&
		agentRunQueue.length > 0
	) {
		const next = agentRunQueue.shift();
		if (!next) break;
		agentRunActive++;
		void (async () => {
			try {
				await next();
			} finally {
				agentRunActive = Math.max(0, agentRunActive - 1);
				drainAgentRunQueue();
			}
		})();
	}
}

function enqueueAgentRun(runId: string, task: () => Promise<void>) {
	if (!runId) return;
	if (agentRunInFlight.has(runId)) return;
	agentRunInFlight.add(runId);
	agentRunQueue.push(async () => {
		try {
			await task();
		} finally {
			agentRunInFlight.delete(runId);
		}
	});
	drainAgentRunQueue();
}

async function runLlmAgentRun(runId: string, ctx: ToolContext): Promise<void> {
	initializeTools();

	const runAbortController = getOrCreateAgentRunAbortController(runId);
	let selectedPlaybookIds: string[] = [];
	let selectedPlaybookOrganizationId = "";
	const markSelectedPlaybooksFailed = async () => {
		if (!selectedPlaybookOrganizationId || selectedPlaybookIds.length === 0)
			return;
		await incrementPlaybookFailureCounts({
			organizationId: selectedPlaybookOrganizationId,
			playbookIds: selectedPlaybookIds,
		});
		selectedPlaybookIds = [];
	};
	try {
		const run = await db.query.aiRuns.findFirst({
			where: eq(aiRuns.runId, runId),
		});
		if (!run) {
			throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
		}
		if (["completed", "failed", "cancelled"].includes(run.status)) return;

		const conversation = await getConversationById(run.conversationId);
		selectedPlaybookOrganizationId = conversation.organizationId;
		if (conversation.organizationId !== ctx.organizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this run",
			});
		}
		const uiLocale = getUiLocaleFromMetadata(conversation.metadata);
		const assistantMessageId = await ensureAgentAssistantMessage({
			conversationId: run.conversationId,
			runId,
		});
		if (assistantMessageId) {
			await upsertDisplayMessageSnapshot({
				messageId: assistantMessageId,
				conversationId: run.conversationId,
				sourceMessageId: assistantMessageId,
				runId,
				role: "assistant",
				kind: "agent",
				content: "",
				reasoning: null,
				status: "sending",
			});
		}

		const conversationAiId =
			typeof conversation.aiId === "string" ? conversation.aiId.trim() : "";
		if (!conversationAiId) {
			const msg = "Conversation has no AI configuration";
			await updateRun(runId, {
				status: "failed",
				error: msg,
				completedAt: new Date().toISOString(),
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: { type: "agent.run.finish", runId, status: "failed" },
			});
			if (assistantMessageId) {
				try {
					await updateMessage({
						messageId: assistantMessageId,
						conversationId: run.conversationId,
						role: "assistant",
						content: msg,
					});
					await upsertDisplayMessageSnapshot({
						messageId: assistantMessageId,
						conversationId: run.conversationId,
						sourceMessageId: assistantMessageId,
						runId,
						role: "assistant",
						kind: "agent",
						content: msg,
						status: "error",
						error: msg,
					});
				} catch {}
			}
			return;
		}

		const aiSettings = await getAiSettingById(conversationAiId);
		if (!aiSettings || !aiSettings.isEnabled) {
			const msg = "AI features are not enabled for this configuration";
			await updateRun(runId, {
				status: "failed",
				error: msg,
				completedAt: new Date().toISOString(),
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: { type: "agent.run.finish", runId, status: "failed" },
			});
			if (assistantMessageId) {
				try {
					await updateMessage({
						messageId: assistantMessageId,
						conversationId: run.conversationId,
						role: "assistant",
						content: msg,
					});
					await upsertDisplayMessageSnapshot({
						messageId: assistantMessageId,
						conversationId: run.conversationId,
						sourceMessageId: assistantMessageId,
						runId,
						role: "assistant",
						kind: "agent",
						content: msg,
						status: "error",
						error: msg,
					});
				} catch {}
			}
			return;
		}

		const toolApprovalsDisabled = getToolApprovalsDisabledFromMetadata(
			conversation.metadata,
		);
		const toolBudgetMode = getToolBudgetModeFromMetadata(conversation.metadata);
		const toolStepBudget = getToolStepBudget(toolBudgetMode);
		const agenticEnabled = toolApprovalsDisabled;
		const toolExposurePlan = buildToolExposurePlan({
			userMessage: typeof run.goal === "string" ? run.goal : "",
			projectId: conversation.projectId || undefined,
			serverId: conversation.serverId || undefined,
		});
		const tools = buildChatTools({
			conversationId: run.conversationId,
			runId,
			toolContext: ctx,
			messageId: assistantMessageId || undefined,
			toolApprovalsDisabled,
		});
		const activeTools = resolveActiveToolNames(
			tools,
			toolExposurePlan.activeMetaTools,
		);

		const provider = selectAIProvider(aiSettings);
		const model = provider(aiSettings.model);
		const providerOptions = getOpenAIResponsesProviderOptions(aiSettings);
		const goal = typeof run.goal === "string" ? run.goal : "";

		let lastOutputDelta = "";
		let lastReasoningDelta = "";

		// Execute any approved executions first (agent-mode approvals).
		{
			const pendingApproved = await db.query.aiToolExecutions.findMany({
				where: and(
					eq(aiToolExecutions.runId, runId),
					eq(aiToolExecutions.status, "approved"),
				),
				orderBy: desc(aiToolExecutions.createdAt),
				limit: 20,
			});
			for (const exec of pendingApproved.slice().reverse()) {
				if (!exec.toolName) continue;
				await updateToolExecution(exec.executionId, {
					status: "executing",
					startedAt: exec.startedAt || new Date().toISOString(),
				});
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.step.start",
						runId,
						stepId: exec.executionId,
						executionId: exec.executionId,
						toolName: exec.toolName,
						parametersPreview:
							exec.parameters != null
								? safeJsonForPrompt(exec.parameters, 4000)
								: undefined,
					},
				});
				let rawResult: unknown;
				try {
					rawResult = await executeToolByNameMaybeMcp(
						exec.toolName,
						exec.parameters || {},
						ctx,
					);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					await updateToolExecution(exec.executionId, {
						status: "failed",
						error: errorMessage,
						completedAt: new Date().toISOString(),
					});
					await saveAgentEventMessage({
						conversationId: run.conversationId,
						payload: {
							type: "agent.step.result",
							runId,
							stepId: exec.executionId,
							executionId: exec.executionId,
							toolName: exec.toolName,
							success: false,
							summary: errorMessage,
						},
					});
					await updateRun(runId, {
						status: "failed",
						error: errorMessage,
						completedAt: new Date().toISOString(),
					});
					await saveAgentEventMessage({
						conversationId: run.conversationId,
						payload: { type: "agent.run.finish", runId, status: "failed" },
					});
					if (assistantMessageId) {
						try {
							await updateMessage({
								messageId: assistantMessageId,
								conversationId: run.conversationId,
								role: "assistant",
								content: errorMessage,
							});
							await upsertDisplayMessageSnapshot({
								messageId: assistantMessageId,
								conversationId: run.conversationId,
								sourceMessageId: assistantMessageId,
								runId,
								role: "assistant",
								kind: "agent",
								content: errorMessage,
								status: "error",
								error: errorMessage,
							});
						} catch {}
					}
					return;
				}

				const result = normalizeToolResultForStorage(rawResult);
				await updateToolExecution(exec.executionId, {
					status: result.success ? "completed" : "failed",
					result,
					error: result.success ? undefined : result.error || result.message,
					completedAt: new Date().toISOString(),
				});
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.step.result",
						runId,
						stepId: exec.executionId,
						executionId: exec.executionId,
						toolName: exec.toolName,
						success: result.success,
						summary: result.message || (result.success ? "Success" : "Failed"),
						dataPreview:
							result.data != null
								? safeJsonForPrompt(result.data, 4000)
								: undefined,
					},
				});
				if (!result.success) {
					const errorMessage =
						result.error || result.message || "Tool execution failed";
					await markSelectedPlaybooksFailed();
					await updateRun(runId, {
						status: "failed",
						error: errorMessage,
						completedAt: new Date().toISOString(),
					});
					await saveAgentEventMessage({
						conversationId: run.conversationId,
						payload: { type: "agent.run.finish", runId, status: "failed" },
					});
					if (assistantMessageId) {
						try {
							await updateMessage({
								messageId: assistantMessageId,
								conversationId: run.conversationId,
								role: "assistant",
								content: errorMessage,
							});
							await upsertDisplayMessageSnapshot({
								messageId: assistantMessageId,
								conversationId: run.conversationId,
								sourceMessageId: assistantMessageId,
								runId,
								role: "assistant",
								kind: "agent",
								content: errorMessage,
								status: "error",
								error: errorMessage,
							});
						} catch {}
					}
					return;
				}
			}
		}

		const history = await getMessages({
			conversationId: run.conversationId,
			limit: 20,
		});
		let messages: CoreMessage[] = history
			.map(messageToCoreMessage)
			.filter(Boolean) as CoreMessage[];

		let playbookPrompt = "";
		try {
			const embeddingProvider = await resolveEmbeddingProviderConfig({
				organizationId: conversation.organizationId,
				aiSettings,
			});
			const playbooks = await findRelevantPlaybooks({
				organizationId: conversation.organizationId,
				embeddingProvider,
				queryText: goal,
			});
			selectedPlaybookIds = uniquePlaybookIds(
				playbooks.map((playbook) => playbook.playbookId),
			);
			playbookPrompt = buildPlaybookMemoryPrompt(playbooks);
		} catch {}

		const baseSystemPrompt = [
			buildSystemPrompt(conversation, toolExposurePlan.promptTools),
			playbookPrompt,
		]
			.filter((s) => typeof s === "string" && s.trim().length > 0)
			.join("\n\n");
		let systemPrompt = baseSystemPrompt;
		const refreshSystemPrompt = async () => {
			const toolExecutionContextMessage =
				await buildToolExecutionContextMessage({
					conversationId: run.conversationId,
				});
			systemPrompt =
				toolExecutionContextMessage.trim().length > 0
					? `${baseSystemPrompt}\n\n${toolExecutionContextMessage.trim()}`
					: baseSystemPrompt;
		};

		const initialSystemMode = getInitialSystemMode(aiSettings);

		const buildAgentContinuePrompt = () => {
			const clipped = safeTruncateString(goal.trim(), 500);
			return [
				"Continue the task based on the conversation so far.",
				`User request: ${clipped}`,
				"",
				"Rules:",
				"- Use the recent tool execution context to avoid repeating completed work.",
				"- If more actions are required, call tools.",
				"- If the task is complete, provide a concise final confirmation and DO NOT call any tools.",
				'- Never ask the user to \"wait\" or say you are still \"processing\".',
			].join("\n");
		};

		const runGenerate = async (
			withTools: boolean,
			systemMode: "system" | "inline" = "system",
			overrideSystemPrompt?: string,
		) => {
			const effectiveSystemPrompt = overrideSystemPrompt ?? systemPrompt;
			const nextMessages =
				systemMode === "inline"
					? [
							{
								role: "user" as const,
								content: `SYSTEM INSTRUCTIONS (treat as system):\n${effectiveSystemPrompt}`,
							},
							...messages,
						]
					: messages;
			return await generateText({
				model,
				providerOptions,
				system: systemMode === "system" ? effectiveSystemPrompt : undefined,
				messages: nextMessages,
				tools: withTools ? tools : undefined,
				activeTools: withTools ? activeTools : undefined,
				stopWhen: stepCountIs(toolStepBudget),
				abortSignal: runAbortController.signal,
			});
		};

		type GeneratedTurn = Awaited<ReturnType<typeof generateText>>;

		const runGenerateWithFallback = async (
			overrideSystemPrompt?: string,
		): Promise<GeneratedTurn> => {
			let result: GeneratedTurn;
			try {
				result = await runGenerate(
					true,
					initialSystemMode,
					overrideSystemPrompt,
				);
			} catch (error) {
				const aborted =
					runAbortController.signal.aborted || isAbortLikeError(error);
				if (isSystemMessagePlacementError(error) && !aborted) {
					try {
						result = await runGenerate(true, "inline", overrideSystemPrompt);
					} catch (retryError) {
						if (isMissingToolUseIdError(retryError)) {
							result = await runGenerate(false, "inline", overrideSystemPrompt);
						} else {
							throw retryError;
						}
					}
				} else if (isMissingToolUseIdError(error) && !aborted) {
					try {
						result = await runGenerate(
							false,
							initialSystemMode,
							overrideSystemPrompt,
						);
					} catch (retryError) {
						if (isSystemMessagePlacementError(retryError)) {
							result = await runGenerate(false, "inline", overrideSystemPrompt);
						} else {
							throw retryError;
						}
					}
				} else throw error;
			}
			return result;
		};

		const isLikelyActionRequest = (text: string): boolean => {
			if (!AUTO_EXECUTE_ACTION_REQUESTS) return false;
			const t = text.trim();
			if (t.length === 0) return false;
			const hasAction =
				/(备份|backup|恢复|restore|迁移|migrate|部署|deploy|创建|create|删除|delete|移除|remove|更新|update|设置|set|配置|config|启动|start|停止|stop|重启|restart|导入|import|导出|export|挂载|mount|日志|log|logs|容器|container|docker)/i.test(
					t,
				);
			if (!hasAction) return false;
			return !/(\?|？)/.test(t);
		};

		const safeSuccessTools = new Set([
			"trpc_procedure_search",
			"trpc_procedure_suggest",
			"trpc_procedure_describe",
			"tool_search",
			"tool_suggest",
			"tool_describe",
		]);
		const isSafeSuccessTool = (toolName: string) => {
			if (safeSuccessTools.has(toolName)) return true;
			const t = toolRegistry.get(toolName);
			return !!t && t.riskLevel === "low" && !t.requiresApproval;
		};

		const maxTurns = agenticEnabled ? 12 : 1;
		const maxPlatformToolCalls = agenticEnabled ? toolStepBudget : 0;
		let platformToolCalls = 0;

		let finalText = "";
		const allToolCalls: NonNullable<GeneratedTurn["toolCalls"]> = [];
		const allToolResults: unknown[] = [];
		const aggregatedUsage: { inputTokens?: number; outputTokens?: number } = {
			inputTokens: 0,
			outputTokens: 0,
		};

		await refreshSystemPrompt();
		await updateRun(runId, {
			status: "executing",
			startedAt: run.startedAt || new Date().toISOString(),
		});

		for (let turn = 0; turn < maxTurns; turn++) {
			if (runAbortController.signal.aborted) return;
			const refreshed = await db.query.aiRuns.findFirst({
				where: eq(aiRuns.runId, runId),
				columns: { status: true },
			});
			if (refreshed?.status === "cancelled") return;

			await refreshSystemPrompt();

			const turnResults: GeneratedTurn[] = [];
			let result = await runGenerateWithFallback(systemPrompt);
			turnResults.push(result);

			const reasoningSnippet = safeTruncateString(
				(typeof result.reasoningText === "string"
					? result.reasoningText
					: ""
				).trim(),
				8000,
			);
			if (
				reasoningSnippet.length > 0 &&
				reasoningSnippet !== lastReasoningDelta
			) {
				lastReasoningDelta = reasoningSnippet;
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.output.reasoning",
						runId,
						text: reasoningSnippet,
					},
				});
			}

			if (isLikelyActionRequest(goal)) {
				const toolResults = (result as unknown as { toolResults?: unknown })
					.toolResults;
				const retryable = getRetryableToolCallFailures(toolResults);
				const needsToolKickoff = !Array.isArray(result.toolCalls)
					? true
					: !result.toolCalls.some((tc) => tc.toolName === "tool_call");
				const onlySafeSuccesses =
					retryable.successfulTools.length === 0 ||
					retryable.successfulTools.every(isSafeSuccessTool);
				const needsParamRepair =
					retryable.failures.length > 0 &&
					!retryable.hasPendingApproval &&
					onlySafeSuccesses;

				if ((turn === 0 && needsToolKickoff) || needsParamRepair) {
					const hint = safeTruncateString(goal.trim(), 200);
					const hintForPrompt = hint
						.replaceAll("\\", "\\\\")
						.replaceAll('"', '\\"')
						.replaceAll("\n", " ")
						.replaceAll("\r", " ");
					const failureDetails = needsParamRepair
						? safeJsonForPrompt(retryable.failures, 2500)
						: "";
					const extra = `\n\nCRITICAL: The user request requires real platform actions.\nYou MUST use tools (not a text-only plan).\n- If you already know the exact tool/procedure + params, call tool_call directly.\n- If you need to discover tRPC procedures, use trpc_procedure_suggest (query: \"${hintForPrompt}\") or trpc_procedure_search, then call trpc_procedure_call.\n- If a tool_call failed due to invalid params or unknown tool, fix and retry immediately (use data.exampleToolCall if present).\n${failureDetails ? `\nPrevious tool_call failures:\n${failureDetails}\n` : ""}\nIf blocked, ask exactly ONE question.`;
					try {
						await refreshSystemPrompt();
						result = await runGenerateWithFallback(`${systemPrompt}${extra}`);
						turnResults.push(result);
					} catch {}
				}
			}

			const turnToolCalls: NonNullable<GeneratedTurn["toolCalls"]> = [];
			const turnToolResults: unknown[] = [];
			for (const r of turnResults) {
				const turnText =
					normalizeAssistantMessageContent(
						"assistant",
						typeof r.text === "string" ? r.text : "",
					) ?? "";
				finalText += turnText;
				if (Array.isArray(r.toolCalls)) {
					allToolCalls.push(...r.toolCalls);
					turnToolCalls.push(...r.toolCalls);
				}
				const toolResults = (r as unknown as { toolResults?: unknown })
					.toolResults;
				if (Array.isArray(toolResults)) {
					allToolResults.push(...toolResults);
					turnToolResults.push(...toolResults);
				}
				aggregatedUsage.inputTokens =
					(aggregatedUsage.inputTokens ?? 0) + (r.usage?.inputTokens ?? 0);
				aggregatedUsage.outputTokens =
					(aggregatedUsage.outputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
			}

			const assistantSnippet = safeTruncateString(
				(
					normalizeAssistantMessageContent(
						"assistant",
						typeof result.text === "string" ? result.text : "",
					) ?? ""
				).trim(),
				4000,
			);
			if (assistantSnippet.length > 0 && assistantSnippet !== lastOutputDelta) {
				lastOutputDelta = assistantSnippet;
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.output.delta",
						runId,
						delta: assistantSnippet,
					},
				});
			}

			if (assistantMessageId) {
				const toolCallsToPersistNow = buildPersistedToolCallsFromResults({
					toolCalls: allToolCalls,
					toolResults: allToolResults,
				});
				if (finalText.trim().length > 0 || toolCallsToPersistNow.length > 0) {
					const stopRequested = runAbortController.signal.aborted;
					try {
						const updatedAssistant = await updateMessage({
							messageId: assistantMessageId,
							conversationId: run.conversationId,
							role: "assistant",
							content: finalText.trim().length > 0 ? finalText : "",
							toolCalls:
								toolCallsToPersistNow.length > 0 ? toolCallsToPersistNow : null,
						});
						await syncDisplayMessageFromRawMessage(updatedAssistant, {
							reasoning: lastReasoningDelta || null,
							status: stopRequested ? "stopped" : "sending",
							kind: "agent",
							runId,
							toolResults: allToolResults,
						});
					} catch {}
					if (stopRequested) return;
				}
			}

			const retryable = getRetryableToolCallFailures(turnToolResults);
			if (retryable.hasPendingApproval) {
				let pendingExecutionId = "";
				let pendingToolName = "";
				for (const tr of turnToolResults) {
					if (!tr || typeof tr !== "object") continue;
					const resultValue =
						(tr as { result?: unknown }).result ??
						(tr as { output?: unknown }).output ??
						tr;
					if (!isRecord(resultValue)) continue;
					if (resultValue.success !== true) continue;
					if (resultValue.status !== "pending_approval") continue;
					if (typeof resultValue.executionId === "string") {
						pendingExecutionId = resultValue.executionId;
					}
					const invokedTool =
						typeof resultValue.invokedTool === "string"
							? resultValue.invokedTool
							: typeof resultValue.toolName === "string"
								? resultValue.toolName
								: "";
					pendingToolName = invokedTool;
					break;
				}
				const exec =
					pendingExecutionId.trim().length > 0
						? await db.query.aiToolExecutions.findFirst({
								where: eq(
									aiToolExecutions.executionId,
									pendingExecutionId.trim(),
								),
							})
						: null;
				await updateRun(runId, { status: "waiting_approval" });
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.step.wait_approval",
						runId,
						stepId: pendingExecutionId.trim(),
						executionId: pendingExecutionId.trim(),
						toolName: pendingToolName,
						parametersPreview:
							exec?.parameters != null
								? safeJsonForPrompt(exec.parameters, 4000)
								: undefined,
					},
				});
				return;
			}

			const platformThisTurn = turnToolCalls.filter(
				(tc) => tc.toolName === "tool_call",
			).length;
			platformToolCalls += platformThisTurn;
			if (
				maxPlatformToolCalls > 0 &&
				platformToolCalls >= maxPlatformToolCalls
			) {
				const msg = "Agent tool call budget exceeded";
				await markSelectedPlaybooksFailed();
				await updateRun(runId, {
					status: "failed",
					error: msg,
					completedAt: new Date().toISOString(),
				});
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: { type: "agent.run.finish", runId, status: "failed" },
				});
				if (assistantMessageId) {
					try {
						await updateMessage({
							messageId: assistantMessageId,
							conversationId: run.conversationId,
							role: "assistant",
							content: msg,
						});
						await upsertDisplayMessageSnapshot({
							messageId: assistantMessageId,
							conversationId: run.conversationId,
							sourceMessageId: assistantMessageId,
							runId,
							role: "assistant",
							kind: "agent",
							content: msg,
							status: "error",
							error: msg,
						});
					} catch {}
				}
				return;
			}

			{
				const executionIds = Array.from(
					new Set(
						turnToolResults
							.map((tr) => {
								if (!tr || typeof tr !== "object") return "";
								const directExecutionId =
									typeof (tr as { executionId?: unknown }).executionId ===
									"string"
										? (tr as { executionId: string }).executionId
										: "";
								if (directExecutionId.trim().length > 0) {
									return directExecutionId.trim();
								}
								const resultValue =
									(tr as { result?: unknown }).result ??
									(tr as { output?: unknown }).output ??
									tr;
								if (!isRecord(resultValue)) return "";
								if (typeof resultValue.executionId === "string") {
									return resultValue.executionId.trim();
								}
								const nested = resultValue.data;
								if (
									isRecord(nested) &&
									typeof nested.executionId === "string"
								) {
									return nested.executionId.trim();
								}
								return "";
							})
							.filter((id) => id.trim().length > 0),
					),
				).slice(0, 20);

				if (executionIds.length > 0) {
					const executions = await db.query.aiToolExecutions.findMany({
						where: inArray(aiToolExecutions.executionId, executionIds),
					});

					const currentRun = await db.query.aiRuns.findFirst({
						where: eq(aiRuns.runId, runId),
						columns: { plan: true },
					});
					const prevSteps = Array.isArray(currentRun?.plan?.steps)
						? currentRun?.plan?.steps
						: [];
					const nextSteps = prevSteps.slice();
					const existingIds = new Set(prevSteps.map((s) => s.id));

					for (const exec of executions) {
						if (!exec.executionId) continue;
						if (!existingIds.has(exec.executionId)) {
							existingIds.add(exec.executionId);
							nextSteps.push({
								id: exec.executionId,
								toolName: exec.toolName,
								description: `Execute ${exec.toolName}`,
								parameters: (exec.parameters || {}) as Record<string, unknown>,
								requiresApproval: !!exec.requiresApproval,
							});
						}

						const success =
							typeof exec.result?.success === "boolean"
								? exec.result.success
								: false;
						const summary =
							(typeof exec.result?.message === "string" &&
								exec.result.message) ||
							exec.error ||
							(success ? "Success" : "Failed");
						await saveAgentEventMessage({
							conversationId: run.conversationId,
							payload: {
								type: "agent.step.result",
								runId,
								stepId: exec.executionId,
								executionId: exec.executionId,
								toolName: exec.toolName,
								success,
								summary,
								dataPreview:
									exec.result?.data != null
										? safeJsonForPrompt(exec.result.data, 4000)
										: undefined,
							},
						});
					}

					if (nextSteps.length !== prevSteps.length) {
						await updateRun(runId, { plan: { steps: nextSteps } });
						await saveAgentEventMessage({
							conversationId: run.conversationId,
							payload: {
								type: "agent.plan",
								runId,
								plan: { steps: nextSteps },
							},
						});
					}
				}
			}

			if (turnToolCalls.length === 0) break;

			if (assistantSnippet.length > 0) {
				messages = messages.concat({
					role: "assistant",
					content: assistantSnippet,
				});
			}
			messages = messages.concat({
				role: "user",
				content: buildAgentContinuePrompt(),
			});
		}

		if (runAbortController.signal.aborted) return;

		{
			const toolCallsToPersist = buildPersistedToolCallsFromResults({
				toolCalls: allToolCalls,
				toolResults: allToolResults,
			});

			if (assistantMessageId) {
				try {
					const updatedAssistant = await updateMessage({
						messageId: assistantMessageId,
						conversationId: run.conversationId,
						role: "assistant",
						content: finalText,
						toolCalls:
							toolCallsToPersist.length > 0 ? toolCallsToPersist : null,
						promptTokens: aggregatedUsage.inputTokens ?? null,
						completionTokens: aggregatedUsage.outputTokens ?? null,
					});
					await syncDisplayMessageFromRawMessage(updatedAssistant, {
						reasoning: lastReasoningDelta || null,
						status: "sent",
						kind: "agent",
						runId,
						toolResults: allToolResults,
					});
				} catch {
					const savedAssistant = await saveMessage({
						messageId: assistantMessageId,
						conversationId: run.conversationId,
						role: "assistant",
						content: finalText,
						toolCalls:
							toolCallsToPersist.length > 0 ? toolCallsToPersist : undefined,
						promptTokens: aggregatedUsage.inputTokens,
						completionTokens: aggregatedUsage.outputTokens,
					});
					await syncDisplayMessageFromRawMessage(savedAssistant, {
						reasoning: lastReasoningDelta || null,
						status: "sent",
						kind: "agent",
						runId,
						toolResults: allToolResults,
					});
				}
			} else {
				const savedAssistant = await saveMessage({
					conversationId: run.conversationId,
					role: "assistant",
					content: finalText,
					toolCalls:
						toolCallsToPersist.length > 0 ? toolCallsToPersist : undefined,
					promptTokens: aggregatedUsage.inputTokens,
					completionTokens: aggregatedUsage.outputTokens,
				});
				await syncDisplayMessageFromRawMessage(savedAssistant, {
					reasoning: lastReasoningDelta || null,
					status: "sent",
					kind: "agent",
					runId,
					toolResults: allToolResults,
				});
			}
		}

		await updateRun(runId, {
			status: "completed",
			result: {
				success: true,
				summary: safeTruncateString(finalText.trim(), 2000),
			},
			completedAt: new Date().toISOString(),
		});
		await saveAgentEventMessage({
			conversationId: run.conversationId,
			payload: { type: "agent.run.finish", runId, status: "completed" },
		});

		void (async () => {
			const embeddingProvider = await resolveEmbeddingProviderConfig({
				organizationId: ctx.organizationId,
				aiSettings,
			});
			await upsertPlaybookFromSuccessfulRun({
				organizationId: ctx.organizationId,
				embeddingProvider,
				goal,
				runId,
				finalSummary: finalText,
			});
		})().catch(() => {});
	} catch (error) {
		if (runAbortController.signal.aborted || isAbortLikeError(error)) {
			return;
		}
		await markSelectedPlaybooksFailed();
		throw error;
	} finally {
		clearAgentRunAbortController(runId);
	}
}

export const startAgentRun = async (params: {
	conversationId: string;
	goal: string;
	attachments?: AiMessageAttachment[];
	aiId: string;
	organizationId: string;
	userId: string;
	uiLocale?: string;
}) => {
	const aiSetting = await getAiSettingById(params.aiId);
	if (aiSetting.organizationId !== params.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this AI configuration",
		});
	}

	const conversation = await getConversationById(params.conversationId);
	if (conversation.organizationId !== params.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this conversation",
		});
	}

	{
		const requestedUiLocale = normalizeUiLocale(params.uiLocale);
		const existingUiLocale = getUiLocaleFromMetadata(conversation.metadata);
		if (requestedUiLocale && requestedUiLocale !== existingUiLocale) {
			await updateConversation(params.conversationId, {
				metadata: setUiLocaleInMetadata(
					conversation.metadata,
					requestedUiLocale,
				),
			});
		}
	}

	initializeTools();

	const run = await createRun({
		conversationId: params.conversationId,
		goal: params.goal,
	});
	if (!run) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to create run",
		});
	}

	const normalizedAttachments = normalizeMessageAttachments(params.attachments);

	let userMessageId = "";
	try {
		const saved = await saveMessage({
			conversationId: params.conversationId,
			role: "user",
			content: params.goal,
			attachments:
				normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
		});
		userMessageId = typeof saved?.messageId === "string" ? saved.messageId : "";
	} catch {}

	const assistantMessageId = await ensureAgentAssistantMessage({
		conversationId: params.conversationId,
		runId: run.runId,
	});
	if (assistantMessageId) {
		await upsertDisplayMessageSnapshot({
			messageId: assistantMessageId,
			conversationId: params.conversationId,
			sourceMessageId: assistantMessageId,
			runId: run.runId,
			role: "assistant",
			kind: "agent",
			content: "",
			reasoning: null,
			status: "sending",
		});
	}

	if (conversation.title === "New Conversation") {
		const nextTitle = String(params.goal ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 50);
		if (nextTitle.length > 0) {
			try {
				await updateConversation(params.conversationId, { title: nextTitle });
			} catch {}
		}
	}
	await updateRun(run.runId, { plan: { steps: [] } });

	await saveAgentEventMessage({
		conversationId: params.conversationId,
		payload: {
			type: "agent.run.start",
			runId: run.runId,
			goal: params.goal,
		},
	});
	await saveAgentEventMessage({
		conversationId: params.conversationId,
		payload: {
			type: "agent.plan",
			runId: run.runId,
			plan: { steps: [] },
		},
	});

	const toolContext: ToolContext = {
		organizationId: params.organizationId,
		userId: params.userId,
		projectId: conversation.projectId ?? undefined,
		serverId: conversation.serverId ?? undefined,
	};

	enqueueAgentRun(run.runId, async () => {
		try {
			await runLlmAgentRun(run.runId, toolContext);
		} catch (e) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			await updateRun(run.runId, {
				status: "failed",
				error: errorMessage,
				completedAt: new Date().toISOString(),
			});
			await saveAgentEventMessage({
				conversationId: params.conversationId,
				payload: {
					type: "agent.run.finish",
					runId: run.runId,
					status: "failed",
					error: errorMessage,
				},
			});
		}
	});

	return { ...run, userMessageId, assistantMessageId };
};

export const resumeAgentRun = async (params: {
	runId: string;
	organizationId: string;
	userId: string;
}) => {
	const run = await getRunById(params.runId);
	const conversation = await getConversationById(run.conversationId);
	if (conversation.organizationId !== params.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this run",
		});
	}

	const toolContext: ToolContext = {
		organizationId: params.organizationId,
		userId: params.userId,
		projectId: conversation.projectId ?? undefined,
		serverId: conversation.serverId ?? undefined,
	};

	enqueueAgentRun(params.runId, async () => {
		try {
			await runLlmAgentRun(params.runId, toolContext);
		} catch {}
	});
};

// ============================================
// Tool Execution Management
// ============================================

export const createToolExecution = async (params: {
	conversationId?: string;
	runId?: string;
	messageId?: string;
	toolName: string;
	parameters: Record<string, unknown>;
	requiresApproval: boolean;
}) => {
	const [execution] = await db
		.insert(aiToolExecutions)
		.values({
			...params,
			status: params.requiresApproval ? "pending" : "executing",
			...(params.requiresApproval
				? {}
				: { startedAt: new Date().toISOString() }),
		})
		.returning();
	if (!execution) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to create tool execution",
		});
	}
	return execution;
};

export const getToolExecutionById = async (executionId: string) => {
	const execution = await db.query.aiToolExecutions.findFirst({
		where: eq(aiToolExecutions.executionId, executionId),
	});
	if (!execution) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Tool execution not found",
		});
	}
	return execution;
};

export const getToolExecutionsByIds = async (params: {
	executionIds: string[];
	organizationId: string;
}) => {
	const ids = Array.from(
		new Set(
			(params.executionIds || [])
				.map((id) => (typeof id === "string" ? id.trim() : ""))
				.filter((id) => id.length > 0),
		),
	).slice(0, 50);

	if (ids.length === 0) return [];

	const executions = await db.query.aiToolExecutions.findMany({
		where: inArray(aiToolExecutions.executionId, ids),
	});

	const conversationIds = Array.from(
		new Set(
			executions
				.map((e) =>
					typeof e.conversationId === "string" ? e.conversationId : "",
				)
				.filter((id) => id.length > 0),
		),
	);

	if (conversationIds.length > 0) {
		const conversations = await db.query.aiConversations.findMany({
			where: inArray(aiConversations.conversationId, conversationIds),
			columns: {
				conversationId: true,
				organizationId: true,
			},
		});
		const allowedConversationIds = new Set(
			conversations
				.filter((c) => c.organizationId === params.organizationId)
				.map((c) => c.conversationId),
		);

		for (const e of executions) {
			if (e.conversationId && !allowedConversationIds.has(e.conversationId)) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to one or more tool executions",
				});
			}
		}
	}

	return executions;
};

export const approveToolExecution = async (
	executionId: string,
	approved: boolean,
	approvedBy: string,
) => {
	const [updated] = await db
		.update(aiToolExecutions)
		.set({
			status: approved ? "approved" : "rejected",
			approvedBy,
			approvedAt: new Date().toISOString(),
		})
		.where(eq(aiToolExecutions.executionId, executionId))
		.returning();

	if (updated?.conversationId && approved) {
		try {
			const conversation = await getConversationById(updated.conversationId);
			await updateConversation(updated.conversationId, {
				metadata: setToolApprovalsDisabledInMetadata(
					conversation.metadata,
					true,
				),
			});
		} catch {}
	}

	return updated;
};

export const updateToolExecution = async (
	executionId: string,
	data: Partial<{
		status:
			| "pending"
			| "approved"
			| "rejected"
			| "executing"
			| "completed"
			| "failed";
		result: {
			success: boolean;
			message?: string;
			data?: unknown;
			error?: string;
		};
		error: string;
		startedAt: string;
		completedAt: string;
	}>,
) => {
	const [updated] = await db
		.update(aiToolExecutions)
		.set(data)
		.where(eq(aiToolExecutions.executionId, executionId))
		.returning();
	return updated;
};

// ============================================
// Execute Approved Tool
// ============================================

async function autoContinueAfterApprovedToolExecution(params: {
	conversationId: string;
	organizationId: string;
	userId: string;
	toolName: string;
	executionId: string;
	outcome: "completed" | "failed";
}): Promise<void> {
	const conversation = await getConversationById(params.conversationId);
	if (conversation.organizationId !== params.organizationId) return;
	if (conversation.status !== "active") return;

	const aiId =
		typeof conversation.aiId === "string" && conversation.aiId.trim().length > 0
			? conversation.aiId.trim()
			: "";
	if (!aiId) return;

	const aiSettings = await getAiSettingById(aiId);
	if (!aiSettings || !aiSettings.isEnabled) return;
	if (aiSettings.organizationId !== params.organizationId) return;
	const uiLocale = getUiLocaleFromMetadata(conversation.metadata);

	initializeTools();

	const history = await getMessages({
		conversationId: params.conversationId,
		limit: 20,
	});
	const messages: CoreMessage[] = history
		.map(messageToCoreMessage)
		.filter(Boolean) as CoreMessage[];

	const internalPrompt = [
		"Continue the task based on the conversation so far.",
		`The last approved tool execution has ${params.outcome}.`,
		`Tool: ${params.toolName}`,
		`Execution ID: ${params.executionId}`,
		"",
		"Rules:",
		"- Use the recent tool execution context to reuse IDs and avoid repeating completed actions.",
		"- If more actions are required, create tool_call(s) with all required params.",
		"- If the task is already complete, briefly confirm and stop.",
	].join("\n");

	const lastUserMessageForTools =
		[...history]
			.reverse()
			.find((m) => m.role === "user" && (m.content ?? "").trim().length > 0)
			?.content ?? internalPrompt;

	messages.push({ role: "user", content: internalPrompt });

	const toolExecutionContextMessage = await buildToolExecutionContextMessage({
		conversationId: params.conversationId,
	});

	const provider = selectAIProvider(aiSettings);
	const model = provider(aiSettings.model);
	const providerOptions = getOpenAIResponsesProviderOptions(aiSettings);

	let playbookPrompt = "";
	try {
		const embeddingProvider = await resolveEmbeddingProviderConfig({
			organizationId: conversation.organizationId,
			aiSettings,
		});
		const playbooks = await findRelevantPlaybooks({
			organizationId: conversation.organizationId,
			embeddingProvider,
			queryText: lastUserMessageForTools,
		});
		playbookPrompt = buildPlaybookMemoryPrompt(playbooks);
	} catch {}

	const toolExposurePlan = buildToolExposurePlan({
		userMessage: lastUserMessageForTools,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	});
	const baseSystemPrompt = [
		buildSystemPrompt(conversation, toolExposurePlan.promptTools),
		playbookPrompt,
	]
		.filter((s) => typeof s === "string" && s.trim().length > 0)
		.join("\n\n");
	const systemPrompt =
		toolExecutionContextMessage.trim().length > 0
			? `${baseSystemPrompt}\n\n${toolExecutionContextMessage.trim()}`
			: baseSystemPrompt;

	const toolContext: ToolContext = {
		organizationId: params.organizationId,
		userId: params.userId,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	};

	const tools = buildChatTools({
		conversationId: params.conversationId,
		toolContext,
		messageId: undefined,
		toolApprovalsDisabled: getToolApprovalsDisabledFromMetadata(
			conversation.metadata,
		),
	});
	const activeTools = resolveActiveToolNames(
		tools,
		toolExposurePlan.activeMetaTools,
	);
	const toolBudgetMode = getToolBudgetModeFromMetadata(conversation.metadata);
	const toolStepBudget = getToolStepBudget(toolBudgetMode);

	const initialSystemMode = getInitialSystemMode(aiSettings);

	const runGenerate = async (
		withTools: boolean,
		systemMode: "system" | "inline" = "system",
	) => {
		const nextMessages =
			systemMode === "inline"
				? [
						{
							role: "user" as const,
							content: `SYSTEM INSTRUCTIONS (treat as system):\n${systemPrompt}`,
						},
						...messages,
					]
				: messages;
		return await generateText({
			model,
			providerOptions,
			system: systemMode === "system" ? systemPrompt : undefined,
			messages: nextMessages,
			tools: withTools ? tools : undefined,
			activeTools: withTools ? activeTools : undefined,
			stopWhen: stepCountIs(toolStepBudget),
		});
	};

	let result: Awaited<ReturnType<typeof generateText>>;
	try {
		result = await runGenerate(true, initialSystemMode);
	} catch (error) {
		if (isSystemMessagePlacementError(error)) {
			try {
				result = await runGenerate(true, "inline");
			} catch (retryError) {
				if (isMissingToolUseIdError(retryError)) {
					result = await runGenerate(false, "inline");
				} else {
					throw retryError;
				}
			}
		} else if (isMissingToolUseIdError(error)) {
			try {
				result = await runGenerate(false, initialSystemMode);
			} catch (retryError) {
				if (isSystemMessagePlacementError(retryError)) {
					result = await runGenerate(false, "inline");
				} else {
					throw retryError;
				}
			}
		} else throw error;
	}

	const finalText =
		normalizeAssistantMessageContent(
			"assistant",
			typeof result.text === "string" ? result.text : "",
		) ?? "";

	const executionIdByToolCallId = new Map<string, string>();
	const invokedToolNameByToolCallId = new Map<string, string>();
	if (Array.isArray(result.toolResults)) {
		for (const tr of result.toolResults as unknown[]) {
			if (!tr || typeof tr !== "object") continue;
			const resultValue = (tr as { result?: unknown }).result;
			if (!resultValue || typeof resultValue !== "object") continue;

			const toolCallId =
				(tr as { toolCallId?: unknown }).toolCallId ??
				(tr as { id?: unknown }).id;
			if (typeof toolCallId !== "string" || toolCallId.trim().length === 0) {
				continue;
			}
			const toolCallIdKey = toolCallId.trim();

			const invokedTool =
				(resultValue as { invokedTool?: unknown }).invokedTool ??
				(resultValue as { toolName?: unknown }).toolName;
			if (typeof invokedTool === "string" && invokedTool.trim().length > 0) {
				invokedToolNameByToolCallId.set(toolCallIdKey, invokedTool.trim());
			}

			const executionId = (resultValue as { executionId?: unknown })
				.executionId;
			const nestedExecutionId =
				(resultValue as { data?: unknown }).data &&
				typeof (resultValue as { data?: unknown }).data === "object"
					? ((resultValue as { data?: { executionId?: unknown } }).data
							?.executionId as unknown)
					: undefined;
			const picked =
				typeof executionId === "string"
					? executionId
					: typeof nestedExecutionId === "string"
						? nestedExecutionId
						: "";
			if (picked.trim().length > 0) {
				executionIdByToolCallId.set(toolCallIdKey, picked.trim());
			}
		}
	}

	const toolCallsToPersist = (result.toolCalls ?? [])
		.filter((tc) => tc.toolName === "tool_call")
		.map((tc) => {
			const rawArgs =
				(tc as unknown as { args?: unknown; input?: unknown }).args ??
				(tc as unknown as { args?: unknown; input?: unknown }).input ??
				{};
			const toolNameFromArgs =
				rawArgs &&
				typeof rawArgs === "object" &&
				"toolName" in (rawArgs as any) &&
				typeof (rawArgs as any).toolName === "string"
					? String((rawArgs as any).toolName)
					: tc.toolName;
			const toolName =
				invokedToolNameByToolCallId.get(tc.toolCallId.trim()) ??
				toolNameFromArgs;
			const toolParams =
				rawArgs && typeof rawArgs === "object" && "params" in (rawArgs as any)
					? (rawArgs as any).params
					: rawArgs;
			return {
				id: tc.toolCallId,
				type: "function" as const,
				executionId: executionIdByToolCallId.get(tc.toolCallId),
				function: {
					name: toolName,
					arguments: JSON.stringify(toolParams ?? {}),
				},
			};
		});

	await saveMessage({
		conversationId: params.conversationId,
		role: "assistant",
		content: finalText,
		toolCalls: toolCallsToPersist.length > 0 ? toolCallsToPersist : undefined,
		promptTokens: result.usage?.inputTokens,
		completionTokens: result.usage?.outputTokens,
	});

	scheduleConversationSummaryUpdate({
		conversationId: params.conversationId,
		model,
		providerOptions,
	});
}

export const executeApprovedTool = async (
	executionId: string,
	ctx: ToolContext,
) => {
	const execution = await getToolExecutionById(executionId);

	if (execution.status !== "approved") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Tool execution is not approved. Current status: ${execution.status}`,
		});
	}

	const mcp = parseMcpVirtualToolName(execution.toolName);
	if (mcp) {
		await updateToolExecution(executionId, {
			status: "executing",
			startedAt: new Date().toISOString(),
		});

		const rawResult = await executeToolByNameMaybeMcp(
			execution.toolName,
			execution.parameters || {},
			ctx,
		);
		const result = normalizeToolResultForStorage(rawResult);
		const outcome = result.success ? "completed" : "failed";

		await updateToolExecution(executionId, {
			status: outcome,
			result,
			error: result.success ? undefined : result.error || result.message,
			completedAt: new Date().toISOString(),
		});
		await appendToolOutcomeAssistantMessage({
			conversationId: execution.conversationId,
			toolName: execution.toolName,
			executionId,
			outcome,
			result: result.success
				? { success: true, message: result.message }
				: {
						success: false,
						message: result.message,
						error: result.error || result.message,
					},
		});

		if (
			typeof execution.conversationId === "string" &&
			execution.conversationId.trim().length > 0 &&
			(!execution.runId || String(execution.runId).trim().length === 0)
		) {
			try {
				await autoContinueAfterApprovedToolExecution({
					conversationId: execution.conversationId,
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					toolName: execution.toolName,
					executionId,
					outcome,
				});
			} catch {}
		}

		return result;
	}

	initializeTools();
	const t = toolRegistry.get(execution.toolName);
	if (!t) {
		const errorMessage = `Tool "${execution.toolName}" not found`;
		await updateToolExecution(executionId, {
			status: "failed",
			error: errorMessage,
			result: {
				success: false,
				message: errorMessage,
				error: errorMessage,
			},
			completedAt: new Date().toISOString(),
		});
		await appendToolOutcomeAssistantMessage({
			conversationId: execution.conversationId,
			toolName: execution.toolName,
			executionId,
			outcome: "failed",
			result: { success: false, message: errorMessage, error: errorMessage },
		});
		throw new TRPCError({
			code: "NOT_FOUND",
			message: errorMessage,
		});
	}

	const validation = t.parameters.safeParse(execution.parameters);
	if (!validation.success) {
		const errorMessage = validation.error.message;
		await updateToolExecution(executionId, {
			status: "failed",
			error: errorMessage,
			result: {
				success: false,
				message: "Invalid parameters",
				error: errorMessage,
			},
			completedAt: new Date().toISOString(),
		});
		await appendToolOutcomeAssistantMessage({
			conversationId: execution.conversationId,
			toolName: execution.toolName,
			executionId,
			outcome: "failed",
			result: {
				success: false,
				message: "Invalid parameters",
				error: errorMessage,
			},
		});
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Invalid parameters for tool "${execution.toolName}": ${errorMessage}`,
		});
	}

	try {
		await updateToolExecution(executionId, {
			status: "executing",
			startedAt: new Date().toISOString(),
		});

		const result = await t.execute(validation.data, ctx);

		if (result.success) {
			await updateToolExecution(executionId, {
				status: "completed",
				result,
				completedAt: new Date().toISOString(),
			});
			await appendToolOutcomeAssistantMessage({
				conversationId: execution.conversationId,
				toolName: execution.toolName,
				executionId,
				outcome: "completed",
				result: { success: true, message: result.message },
			});
			if (
				typeof execution.conversationId === "string" &&
				execution.conversationId.trim().length > 0 &&
				(!execution.runId || String(execution.runId).trim().length === 0)
			) {
				try {
					await autoContinueAfterApprovedToolExecution({
						conversationId: execution.conversationId,
						organizationId: ctx.organizationId,
						userId: ctx.userId,
						toolName: execution.toolName,
						executionId,
						outcome: "completed",
					});
				} catch {}
			}
			return result;
		}

		await updateToolExecution(executionId, {
			status: "failed",
			result,
			error: result.error || result.message,
			completedAt: new Date().toISOString(),
		});
		await appendToolOutcomeAssistantMessage({
			conversationId: execution.conversationId,
			toolName: execution.toolName,
			executionId,
			outcome: "failed",
			result: {
				success: false,
				message: result.message,
				error: result.error || result.message,
			},
		});
		if (
			typeof execution.conversationId === "string" &&
			execution.conversationId.trim().length > 0 &&
			(!execution.runId || String(execution.runId).trim().length === 0)
		) {
			try {
				await autoContinueAfterApprovedToolExecution({
					conversationId: execution.conversationId,
					organizationId: ctx.organizationId,
					userId: ctx.userId,
					toolName: execution.toolName,
					executionId,
					outcome: "failed",
				});
			} catch {}
		}

		return result;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await updateToolExecution(executionId, {
			status: "failed",
			error: errorMessage,
			result: {
				success: false,
				message: "Tool execution failed",
				error: errorMessage,
			},
			completedAt: new Date().toISOString(),
		});
		await appendToolOutcomeAssistantMessage({
			conversationId: execution.conversationId,
			toolName: execution.toolName,
			executionId,
			outcome: "failed",
			result: {
				success: false,
				message: "Tool execution failed",
				error: errorMessage,
			},
		});

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Tool execution failed: ${errorMessage}`,
		});
	}
};
