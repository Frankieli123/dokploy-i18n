import { db } from "@dokploy/server/db";
import {
	ai,
	aiConversations,
	aiMessages,
	aiRuns,
	aiToolExecutions,
} from "@dokploy/server/db/schema";
import { selectAIProvider } from "@dokploy/server/utils/ai/select-ai-provider";
import { TRPCError } from "@trpc/server";
import {
	type CoreMessage,
	generateObject,
	generateText,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { IS_CLOUD } from "../constants";
import { findOrganizationById } from "./admin";
import { orchestrateRun } from "./ai/agent/orchestrator";
import {
	initializeTools,
	type Tool,
	type ToolContext,
	toolRegistry,
} from "./ai-tools";
import { selectRelevantTools } from "./ai-tools/selector";
import { findServerById } from "./server";

type ToolPromptInfo = {
	name: string;
	description: string;
	riskLevel: string;
	requiresApproval: boolean;
};

const RISK_RANK = {
	low: 1,
	medium: 2,
	high: 3,
} as const;

const TOOL_SEARCH_DOMAINS = [
	"database",
	"project",
	"server",
	"application",
	"domain",
	"certificate",
	"proxy",
	"backup",
	"mount",
	"registry",
	"ssh",
	"cluster",
	"rollback",
	"schedule",
	"security",
	"git",
	"user",
	"settings",
	"billing",
	"logs",
	"deploy",
	"common",
] as const;

const TOOL_SEARCH_DOMAIN_CATEGORY_HINTS: Record<string, string[]> = {
	database: ["database", "postgres", "mysql", "mariadb", "mongo", "redis"],
	project: ["project", "environment"],
	server: ["server"],
	application: ["application", "compose"],
	domain: ["domain"],
	certificate: ["certificate", "server"],
	proxy: [
		"server",
		"domain",
		"certificate",
		"application",
		"compose",
		"settings",
	],
	backup: ["backup"],
	mount: ["server"],
	registry: ["deployment"],
	ssh: ["server"],
	cluster: ["server"],
	rollback: ["deployment"],
	schedule: ["server"],
	security: ["server"],
	git: ["github", "application", "compose"],
	user: ["user"],
	settings: ["settings"],
	billing: ["stripe"],
	logs: ["deployment", "server"],
	deploy: ["deployment", "application", "compose"],
};

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

function getZodTypeLabel(schema: z.ZodTypeAny): string {
	const typeName = (schema as unknown as { _def?: { typeName?: string } })._def
		?.typeName;
	if (typeof typeName !== "string") return "unknown";
	return typeName
		.replace(/^Zod/, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase();
}

function unwrapZodSchema(schema: z.ZodTypeAny): {
	schema: z.ZodTypeAny;
	flags: { optional: boolean; nullable: boolean; hasDefault: boolean };
} {
	let current: z.ZodTypeAny = schema;
	const flags = { optional: false, nullable: false, hasDefault: false };

	while (true) {
		if (current instanceof z.ZodOptional) {
			flags.optional = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodNullable) {
			flags.nullable = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodDefault) {
			flags.hasDefault = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodEffects) {
			current = current._def.schema;
			continue;
		}
		break;
	}

	return { schema: current, flags };
}

function describeZodParameters(schema: z.ZodTypeAny): string {
	const unwrapped = unwrapZodSchema(schema).schema;
	if (!(unwrapped instanceof z.ZodObject)) {
		return `Schema: ${getZodTypeLabel(unwrapped)}`;
	}

	const rawShape =
		typeof (unwrapped._def as unknown as { shape?: unknown }).shape ===
		"function"
			? (
					unwrapped._def as unknown as {
						shape: () => Record<string, z.ZodTypeAny>;
					}
				).shape()
			: (unwrapped as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;

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

function buildMetaToolPromptInfo(): ToolPromptInfo[] {
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
	];
}

function tokenizeToolSearchQuery(query: string): string[] {
	const q = query.trim().toLowerCase();
	const tokens: string[] = q.split(/\s+/g).filter(Boolean);

	const add = (arr: string[]) => {
		for (const t of arr) tokens.push(t);
	};

	// Lightweight CN->EN keyword hints so tool_search works well in Chinese conversations.
	if (/(数据库|database|\bdb\b)/i.test(q)) add(["database", "db"]);
	if (/(postgres|postgresql|\bpg\b|pgsql|postgre)/i.test(q))
		add(["postgres", "pg"]);
	if (/(mysql)/i.test(q)) add(["mysql"]);
	if (/(mariadb)/i.test(q)) add(["mariadb"]);
	if (/(mongo|mongodb)/i.test(q)) add(["mongo", "mongodb"]);
	if (/(redis)/i.test(q)) add(["redis"]);

	if (/(项目|project)/i.test(q)) add(["project"]);
	if (/(环境|environment|\benv\b)/i.test(q)) add(["environment", "env"]);
	if (/(服务器|主机|server|host)/i.test(q)) add(["server"]);
	if (/(应用|application|\bapp\b)/i.test(q)) add(["application", "app"]);
	if (/(域名|domain|dns)/i.test(q)) add(["domain", "dns"]);
	if (/(证书|certificate|ssl|https|tls)/i.test(q))
		add(["certificate", "ssl", "https", "tls"]);
	if (/(traefik|特雷菲克|反向代理|反代|网关|代理|转发|路由|ingress)/i.test(q))
		add(["traefik", "proxy", "router", "ingress"]);
	if (/(acme|let'?s\s*encrypt|续签|自动续期|证书续期|challenge)/i.test(q))
		add(["acme", "letsencrypt", "challenge"]);
	if (/(挂载|mount|bind\s*mount|绑定挂载|卷|volume)/i.test(q))
		add(["mount", "bind", "volume"]);
	if (/(对象存储|s3|r2|minio|bucket|存储桶|destination|备份目的地)/i.test(q))
		add(["destination", "s3", "bucket", "backup"]);
	if (/(卷备份|volume\s*backup)/i.test(q))
		add(["volume_backup", "volume", "backup"]);
	if (/(执行命令|命令行|终端|terminal|shell|exec)/i.test(q))
		add(["exec", "command", "server_exec"]);
	if (/(镜像仓库|registry|镜像|image|docker\s*hub|ghcr)/i.test(q))
		add(["registry", "image", "docker", "ghcr"]);
	if (/(ssh|ssh\s*key|密钥|密钥对|私钥|公钥)/i.test(q)) add(["ssh", "key"]);
	if (/(集群|cluster|swarm|节点|node)/i.test(q))
		add(["cluster", "swarm", "node"]);
	if (/(回滚|rollback|revert|恢复到上一版)/i.test(q))
		add(["rollback", "revert"]);
	if (/(github|GitHub|git hub)/i.test(q)) add(["github", "git"]);
	if (/(仓库|repo|repository)/i.test(q)) add(["repo", "repository"]);
	if (/(分支|branch)/i.test(q)) add(["branch"]);
	if (/(拉取请求|合并请求|pull request|\bpr\b)/i.test(q))
		add(["pull", "request", "pr"]);
	if (/(提交|commit)/i.test(q)) add(["commit"]);
	if (/(备份|backup)/i.test(q)) add(["backup"]);
	if (/(恢复|restore)/i.test(q)) add(["restore"]);
	if (/(日志|log)/i.test(q)) add(["log", "logs"]);
	if (/(重启|restart)/i.test(q)) add(["restart"]);
	if (/(部署|deploy|发布)/i.test(q)) add(["deploy"]);
	if (/(创建|新建|新增|create|add|new)/i.test(q)) add(["create", "new", "add"]);
	if (/(删除|移除|销毁|delete|remove|destroy)/i.test(q))
		add(["delete", "remove", "destroy"]);
	if (/(列表|list|查看|show|all)/i.test(q)) add(["list", "get", "show"]);
	if (/(详情|detail|info|inspect)/i.test(q)) add(["get", "info", "inspect"]);

	return Array.from(new Set(tokens));
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

function inferToolSearchDomains(query: string): string[] {
	const tokens = tokenizeToolSearchQuery(query);
	const domainSet = new Set<string>();
	for (const d of TOOL_SEARCH_DOMAINS) {
		if (tokens.includes(d)) domainSet.add(d);
	}
	return Array.from(domainSet);
}

function extractLiteralStringOptions(schema: z.ZodTypeAny): string[] {
	const unwrapped = unwrapZodSchema(schema).schema;

	if (unwrapped instanceof z.ZodLiteral) {
		const v = unwrapped._def.value;
		return typeof v === "string" ? [v] : [];
	}
	if (unwrapped instanceof z.ZodEnum) {
		return Array.isArray(unwrapped._def.values)
			? (unwrapped._def.values as unknown[]).filter(
					(v): v is string => typeof v === "string",
				)
			: [];
	}
	if (unwrapped instanceof z.ZodNativeEnum) {
		const values = Object.values(
			(unwrapped._def.values ?? {}) as Record<string, unknown>,
		);
		return values.filter((v): v is string => typeof v === "string");
	}
	if (unwrapped instanceof z.ZodUnion) {
		return Array.from(
			new Set(
				(unwrapped._def.options as z.ZodTypeAny[]).flatMap((opt) =>
					extractLiteralStringOptions(opt),
				),
			),
		);
	}
	if (unwrapped instanceof z.ZodIntersection) {
		return Array.from(
			new Set([
				...extractLiteralStringOptions(unwrapped._def.left),
				...extractLiteralStringOptions(unwrapped._def.right),
			]),
		);
	}

	return [];
}

function extractConfirmLiterals(schema: z.ZodTypeAny): string[] {
	const unwrapped = unwrapZodSchema(schema).schema;
	if (!(unwrapped instanceof z.ZodObject)) return [];

	const rawShape =
		typeof (unwrapped._def as unknown as { shape?: unknown }).shape ===
		"function"
			? (
					unwrapped._def as unknown as {
						shape: () => Record<string, z.ZodTypeAny>;
					}
				).shape()
			: (unwrapped as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;

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
	if (!(unwrapped instanceof z.ZodObject)) return {};

	const rawShape =
		typeof (unwrapped._def as unknown as { shape?: unknown }).shape ===
		"function"
			? (
					unwrapped._def as unknown as {
						shape: () => Record<string, z.ZodTypeAny>;
					}
				).shape()
			: (unwrapped as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;

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
	domain?: (typeof TOOL_SEARCH_DOMAINS)[number];
	category?: string;
	riskLevelMax?: "low" | "medium" | "high";
	requiresApproval?: boolean;
}): {
	success: boolean;
	message: string;
	meta: {
		query: string;
		matchedDomains: string[];
		nextCall?: {
			toolName: string;
			params: Record<string, unknown>;
			confirmLiterals: string[];
		};
		appliedFilters: {
			domain?: (typeof TOOL_SEARCH_DOMAINS)[number];
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
	const matchedDomains = inferToolSearchDomains(params.query);
	const hintedCategories = Array.from(
		new Set(
			matchedDomains.flatMap((d) => TOOL_SEARCH_DOMAIN_CATEGORY_HINTS[d] ?? []),
		),
	);
	const requestedDomain =
		typeof params.domain === "string" ? params.domain : undefined;
	const requestedDomainCategories =
		requestedDomain && TOOL_SEARCH_DOMAIN_CATEGORY_HINTS[requestedDomain]
			? TOOL_SEARCH_DOMAIN_CATEGORY_HINTS[requestedDomain]
			: [];
	const hintedCategorySet = new Set([
		...hintedCategories,
		...requestedDomainCategories,
	]);
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
		if (requestedDomain && requestedDomainCategories.length > 0) {
			if (!requestedDomainCategories.includes(t.category)) continue;
		}
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
		if (hintedCategorySet.size > 0 && hintedCategorySet.has(t.category)) {
			score += 2;
		}
		if (t.riskLevel === "low") score += 1;
		if (score > 0) scored.push({ t, score });
	}
	scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));

	const limit = params.limit ?? 12;
	const picked = (() => {
		if (scored.length > 0) return scored.slice(0, limit).map((x) => x.t);

		const pool =
			hintedCategorySet.size === 0
				? all
				: all.filter((t) => hintedCategorySet.has(t.category));

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
	const nextCall = bestTool
		? {
				toolName: bestTool.name,
				params: buildExampleParams(bestTool.parameters),
				confirmLiterals: extractConfirmLiterals(bestTool.parameters),
			}
		: undefined;

	return {
		success: true,
		message,
		meta: {
			query: params.query,
			matchedDomains,
			nextCall,
			appliedFilters: {
				domain: params.domain,
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
			prompt: `
        Act as advanced DevOps engineer and generate a list of open source projects what can cover users needs(up to 3 items).
        
        Return your response as a JSON object with the following structure:
        {
          "suggestions": [
            {
              "id": "project-slug",
              "name": "Project Name",
              "shortDescription": "Brief one-line description",
              "description": "Detailed description"
            }
          ]
        }
        
        Important rules for the response:
        1. Use slug format for the id field (lowercase, hyphenated)
        2. The description field should ONLY contain a plain text description of the project, its features, and use cases
        3. Do NOT include any code snippets, configuration examples, or installation instructions in the description
        4. The shortDescription should be a single-line summary focusing on the main technologies
        5. All projects should be installable in docker and have docker compose support
        
        User wants to create a new project with the following details:
        
        ${input}
      `,
		});

		if (object?.suggestions?.length) {
			const result = [];
			for (const suggestion of object.suggestions) {
				try {
					const { object: docker } = await generateObject({
						model,
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
						prompt: `
              Act as advanced DevOps engineer and generate docker compose with environment variables and domain configurations needed to install the following project.
              
              Return your response as a JSON object with this structure:
              {
                "dockerCompose": "yaml string here",
                "envVariables": [{"name": "VAR_NAME", "value": "example_value"}],
                "domains": [{"host": "domain.com", "port": 3000, "serviceName": "service"}],
                "configFiles": [{"content": "file content", "filePath": "path/to/file"}]
              }
              
              Note: configFiles is optional - only include it if configuration files are absolutely required.
              
              Follow these rules:

              Docker Compose Rules:
              1. Use placeholder like \${VARIABLE_NAME-default} for generated variables in the docker-compose.yml
              2. Use complex values for passwords/secrets variables
              3. Don't set container_name field in services
              4. Don't set version field in the docker compose
              5. Don't set ports like 'ports: 3000:3000', use 'ports: "3000"' instead
              6. If a service depends on a database or other service, INCLUDE that service in the docker-compose
              7. Make sure all required services are defined in the docker-compose

			  Volume Mounting and Configuration Rules:
              1. DO NOT create configuration files unless the service CANNOT work without them
              2. Most services can work with just environment variables - USE THEM FIRST
              3. Ask yourself: "Can this be configured with an environment variable instead?"
              4. If and ONLY IF a config file is absolutely required:
                 - Keep it minimal with only critical settings
                 - Use "../files/" prefix for all mounts
                 - Format: "../files/folder:/container/path"
              5. DO NOT add configuration files for:
                 - Default configurations that work out of the box
                 - Settings that can be handled by environment variables
                 - Proxy or routing configurations (these are handled elsewhere)

			  Environment Variables Rules:
              1. For the envVariables array, provide ACTUAL example values, not placeholders
              2. Use realistic example values (e.g., "admin@example.com" for emails, "mypassword123" for passwords)
			  3. DO NOT use \${VARIABLE_NAME-default} syntax in the envVariables values
              4. ONLY include environment variables that are actually used in the docker-compose
              5. Every environment variable referenced in the docker-compose MUST have a corresponding entry in envVariables
              6. Do not include environment variables for services that don't exist in the docker-compose
                     
              For each service that needs to be exposed to the internet:
              1. Define a domain configuration with:
                - host: the domain name for the service in format: {service-name}-{random-3-chars-hex}-${ip ? ip.replaceAll(".", "-") : ""}.traefik.me
                - port: the internal port the service runs on
                - serviceName: the name of the service in the docker-compose
              2. Make sure the service is properly configured to work with the specified port
              
              Project details:
              ${suggestion?.description}
            `,
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
}) => {
	const normalizedAiId =
		typeof params.aiId === "string" && params.aiId.trim().length > 0
			? params.aiId
			: undefined;

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
	} else if (typeof params.serverId === "string" && params.serverId.length > 0) {
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
				prompt: `Update the conversation memory summary for the Dokploy AI assistant.\n\nRules:\n- Keep it short (max 10 lines).\n- Capture stable facts, user preferences, selected project/server context, and decisions.\n- Do NOT include secrets (API keys, tokens, passwords).\n- Write in the same language as the conversation (if most lines are Chinese, write Chinese).\n\nExisting summary:\n${existingSummary || "(none)"}\n\nRecent conversation (most recent last):\n${transcript}\n\nReturn ONLY the updated summary.`,
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
}) => {
	const conditions = [eq(aiMessages.conversationId, params.conversationId)];
	if (params.before) {
		conditions.push(lt(aiMessages.createdAt, params.before));
	}

	const messages = await db.query.aiMessages.findMany({
		where: and(...conditions),
		orderBy: desc(aiMessages.createdAt),
		limit: params.limit || 50,
	});
	return messages.reverse();
};

export const saveMessage = async (params: {
	conversationId: string;
	role: "user" | "assistant" | "system" | "tool";
	content?: string;
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
	const [message] = await db.insert(aiMessages).values(params).returning();

	// Update conversation timestamp
	await db
		.update(aiConversations)
		.set({ updatedAt: new Date().toISOString() })
		.where(eq(aiConversations.conversationId, params.conversationId));

	return message;
};

// ============================================
// Chat Function
// ============================================

interface ChatParams {
	conversationId: string;
	message: string;
	aiId: string;
	organizationId: string;
	userId: string;
}

type ChatUsage = {
	inputTokens?: number;
	outputTokens?: number;
};

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
	try {
		return safeTruncateString(JSON.stringify(value, null, 2), maxLen);
	} catch {
		return safeTruncateString(String(value), maxLen);
	}
}

function buildEmptyModelOutputFallback(userMessage: string): string {
	const looksChinese = /[\u4e00-\u9fff]/.test(userMessage);
	if (looksChinese) {
		return (
			"我这次没有拿到模型的任何输出（可能是模型接口/网络波动）。\n" +
			"请点“重试”再试一次；如果持续出现，建议切换模型或检查 AI 配置。"
		);
	}
	return (
		"I didn't receive any output from the model (provider/network hiccup).\n" +
		"Please retry once. If it keeps happening, switch the model or check the AI configuration."
	);
}

async function guessConversationLanguage(
	conversationId: string,
): Promise<"zh" | "en"> {
	try {
		const recent = await getMessages({ conversationId, limit: 12 });
		for (let i = recent.length - 1; i >= 0; i--) {
			const msg = recent[i];
			if (msg?.role !== "user") continue;
			const content = (msg.content ?? "").trim();
			if (content.length === 0) continue;
			return /[\u4e00-\u9fff]/.test(content) ? "zh" : "en";
		}
	} catch {
		// Ignore language detection errors
	}
	return "en";
}

function formatToolOutcomeAssistantMessage(params: {
	lang: "zh" | "en";
	toolName: string;
	executionId: string;
	outcome: "completed" | "failed" | "rejected";
	result?: { success: boolean; message?: string; error?: string };
}): string {
	const toolName = params.toolName.trim();
	const executionId = params.executionId.trim();
	if (!toolName || !executionId) return "";

	const message = params.result?.message?.trim() ?? "";
	const error = params.result?.error?.trim() ?? "";

	const detailHint =
		params.lang === "zh"
			? "（详情见工具执行卡片）"
			: "(See the tool execution card for details)";

	if (params.outcome === "rejected") {
		return params.lang === "zh"
			? `已拒绝执行：${toolName}\n执行ID：${executionId}\n${detailHint}`
			: `Rejected: ${toolName}\nExecution ID: ${executionId}\n${detailHint}`;
	}

	if (params.outcome === "failed") {
		const reason = safeTruncateString(error || message || "Unknown error", 500);
		return params.lang === "zh"
			? `❌ 执行失败：${toolName}\n执行ID：${executionId}\n原因：${reason}\n${detailHint}`
			: `❌ Failed: ${toolName}\nExecution ID: ${executionId}\nReason: ${reason}\n${detailHint}`;
	}

	const doneText = message ? safeTruncateString(message, 500) : "";
	return params.lang === "zh"
		? `✅ 已完成：${toolName}\n执行ID：${executionId}${doneText ? `\n结果：${doneText}` : ""}\n${detailHint}`
		: `✅ Completed: ${toolName}\nExecution ID: ${executionId}${doneText ? `\nResult: ${doneText}` : ""}\n${detailHint}`;
}

async function appendToolOutcomeAssistantMessage(params: {
	conversationId?: string | null;
	toolName: string;
	executionId: string;
	outcome: "completed" | "failed" | "rejected";
	result?: { success: boolean; message?: string; error?: string };
}) {
	const conversationId =
		typeof params.conversationId === "string" && params.conversationId.length > 0
			? params.conversationId
			: "";
	if (!conversationId) return;

	const lang = await guessConversationLanguage(conversationId);
	const content = formatToolOutcomeAssistantMessage({
		lang,
		toolName: params.toolName,
		executionId: params.executionId,
		outcome: params.outcome,
		result: params.result,
	});
	if (!content) return;

	try {
		await saveMessage({
			conversationId,
			role: "assistant",
			content,
		});
	} catch {
		// Best-effort: do not fail tool execution if chat message cannot be saved
	}
}

async function generateToolOutcomeSummary(params: {
	model: unknown;
	userMessage: string;
	toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
	toolResults: Array<{ toolCallId: string; toolName: string; result: unknown }>;
	streamError?: string | null;
}): Promise<string> {
	const toolCallsText = params.toolCalls
		.map((tc) => {
			return `tool_call_id: ${tc.id}\ntool: ${tc.name}\nargs:\n${safeJsonForPrompt(tc.arguments, 2000)}`;
		})
		.join("\n\n");

	const toolResultsText = params.toolResults
		.map((tr) => {
			return `tool_call_id: ${tr.toolCallId}\ntool: ${tr.toolName}\nresult:\n${safeJsonForPrompt(tr.result, 3000)}`;
		})
		.join("\n\n");

	const streamErrorText =
		typeof params.streamError === "string" &&
		params.streamError.trim().length > 0
			? params.streamError.trim()
			: "";

	const prompt = `You are Dokploy AI Assistant.

Write the final user-facing response for the turn based on the user's request and the tool execution details.

Rules:
- Use the same language as the user's request.
- Be concise (3-8 lines).
- If any tool result indicates pending approval (e.g., status = "pending_approval"), clearly ask the user to approve/reject.
- If any tool failed (success=false or contains error), explain what failed and what the user can do next.
- If tools succeeded, confirm completion and summarize the outcome.
- Do not include secrets.
- Output plain text only.

User request:
${safeTruncateString(params.userMessage, 1200)}

Tool calls:
${toolCallsText || "(none)"}

Tool results:
${toolResultsText || "(none)"}

${streamErrorText ? `Model streaming error (non-fatal):\n${safeTruncateString(streamErrorText, 1200)}\n` : ""}

Return ONLY the final response.`;

	const text = await generatePromptText({
		model: params.model,
		prompt,
		maxOutputTokens: 260,
	});

	return text.trim();
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
	const maxExecutions = Math.min(Math.max(params.maxExecutions ?? 10, 1), 30);
	const maxChars = Math.min(Math.max(params.maxChars ?? 14000, 2000), 50000);

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
					? `params:\n${safeJsonForPrompt(e.parameters, 2000)}`
					: "";

			const resultText =
				e.result && typeof e.result === "object"
					? `result:\n${safeJsonForPrompt(e.result, 4000)}`
					: e.error
						? `error:\n${safeTruncateString(String(e.error), 2000)}`
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
	prompt: string;
	maxOutputTokens?: number;
}): Promise<string> {
	try {
		const result = await generateText({
			model: params.model as any,
			prompt: params.prompt,
			maxOutputTokens: params.maxOutputTokens,
		});
		return typeof result.text === "string" ? result.text : "";
	} catch (error) {
		if (!isInvalidJsonLikelySse(error)) throw error;

		const stream = streamText({
			model: params.model as any,
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
	aiId,
	organizationId,
	userId,
}: ChatParams): Promise<ChatResult> => {
	const aiSettings = await getAiSettingById(aiId);
	if (!aiSettings || !aiSettings.isEnabled) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "AI features are not enabled for this configuration",
		});
	}

	// Initialize tools on first use
	initializeTools();

	// Save user message
	await saveMessage({
		conversationId,
		role: "user",
		content: message,
	});

	// Get conversation history
	const history = await getMessages({ conversationId, limit: 20 });

	// Build messages array for AI
	const messages: CoreMessage[] = history
		.map((msg) => {
			if (msg.role === "tool") return null;
			const content = (msg.content || "").trim();
			if (content.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content,
				};
			}
			const toolNames = (msg.toolCalls ?? [])
				.map((tc) => tc.function?.name)
				.filter(Boolean)
				.join(", ");
			if (toolNames.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content: `[tool_calls: ${toolNames}]`,
				};
			}
			return null;
		})
		.filter(Boolean) as CoreMessage[];

	const toolExecutionContextMessage = await buildToolExecutionContextMessage({
		conversationId,
	});
	const messagesWithToolContext = injectToolExecutionContextMessage(
		messages,
		toolExecutionContextMessage,
	);

	const provider = selectAIProvider(aiSettings);
	const model = provider(aiSettings.model);

	// Get system prompt with context
	const conversation = await getConversationById(conversationId);
	const systemPrompt = buildSystemPrompt(
		conversation,
		buildMetaToolPromptInfo(),
	);

	// Build tool context
	const toolContext: ToolContext = {
		organizationId,
		userId,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	};

	const tools: Record<string, any> = {
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
			execute: async (params: { query: string; limit?: number }) => {
				const limit = params.limit ?? 15;
				const selected = selectRelevantTools(params.query, {
					projectId: toolContext.projectId,
					serverId: toolContext.serverId,
					minTools: 0,
					maxTools: limit,
				});
				return {
					success: true,
					message:
						selected.length > 0
							? `Suggested ${selected.length} tool(s) for "${params.query}"`
							: `No direct suggestions for "${params.query}". Use tool_search to explore the full catalog.`,
					data: selected.map((t) => ({
						name: t.name,
						description: t.description,
						category: t.category,
						riskLevel: t.riskLevel,
						requiresApproval: t.requiresApproval,
					})),
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
				domain: z
					.enum(TOOL_SEARCH_DOMAINS)
					.optional()
					.describe("Optional domain filter"),
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
			execute: async (params: {
				query: string;
				limit?: number;
				domain?: (typeof TOOL_SEARCH_DOMAINS)[number];
				category?: string;
				riskLevelMax?: "low" | "medium" | "high";
				requiresApproval?: boolean;
			}) => {
				return searchToolCatalog(params);
			},
		}),
		tool_describe: tool({
			description:
				"Describe a specific tool, including parameter hints extracted from its schema.",
			inputSchema: z.object({
				toolName: z
					.string()
					.min(1)
					.describe("Exact tool name, e.g. postgres_create"),
			}),
			execute: async (params: { toolName: string }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return buildUnknownToolSuggestionResult(params.toolName);
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
				"Execute a tool by name with params. Enforces validation and approval. Use tool_describe first if unsure about parameters.",
			inputSchema: z.object({
				toolName: z.string().min(1).describe("Exact tool name to execute"),
				params: z
					.record(z.any())
					.optional()
					.default({})
					.describe("Parameters object for the tool"),
			}),
			execute: async (params: { toolName: string; params?: unknown }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return buildUnknownToolSuggestionResult(params.toolName);
				}

				const rawParams = (params.params ?? {}) as Record<string, unknown>;
				const validation = t.parameters.safeParse(rawParams);
				if (!validation.success) {
					return {
						success: false,
						message: "Invalid parameters",
						error: validation.error.message,
						data: {
							toolName: t.name,
							confirmLiterals: extractConfirmLiterals(t.parameters),
							exampleParams: buildExampleParams(t.parameters),
						},
					};
				}

				const validatedParams = validation.data as unknown as Record<
					string,
					unknown
				>;

				const execution = await createToolExecution({
					conversationId,
					messageId: undefined,
					toolName: t.name,
					parameters: validatedParams,
					requiresApproval: t.requiresApproval,
				});

				if (t.requiresApproval) {
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

				try {
					const result = await t.execute(validation.data as never, toolContext);

					const completionUpdate: Record<string, unknown> = {
						status: result.success ? "completed" : "failed",
						result,
						completedAt: new Date().toISOString(),
					};
					if (!result.success) {
						completionUpdate.error = result.error || result.message;
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

	const runGenerate = async (withTools: boolean) => {
		return await generateText({
			model,
			system: systemPrompt,
			messages: messagesWithToolContext,
			tools: withTools ? tools : undefined,
			stopWhen: stepCountIs(10),
		});
	};

	let result: Awaited<ReturnType<typeof generateText>>;
	try {
		result = await runGenerate(true);
	} catch (error) {
		if (isMissingToolUseIdError(error)) {
			result = await runGenerate(false);
		} else {
			throw error;
		}
	}

	let finalText = typeof result.text === "string" ? result.text : "";
	if (
		finalText.trim().length === 0 &&
		Array.isArray(result.toolCalls) &&
		result.toolCalls.length > 0
	) {
		const summary = await generateToolOutcomeSummary({
			model,
			userMessage: message,
			toolCalls: result.toolCalls.map((tc) => ({
				id: tc.toolCallId,
				name: tc.toolName,
				arguments:
					(tc as unknown as { args?: unknown; input?: unknown }).args ??
					(tc as unknown as { args?: unknown; input?: unknown }).input ??
					{},
			})),
			toolResults: Array.isArray(result.toolResults)
				? (result.toolResults as unknown[]).map((tr) => {
						const toolCallId =
							(tr as { toolCallId?: unknown }).toolCallId ??
							(tr as { id?: unknown }).id;
						const toolName =
							(tr as { toolName?: unknown }).toolName ??
							(tr as { name?: unknown }).name;
						const resultValue =
							(tr as { result?: unknown }).result ??
							(tr as { output?: unknown }).output ??
							tr;
						return {
							toolCallId: typeof toolCallId === "string" ? toolCallId : "",
							toolName: typeof toolName === "string" ? toolName : "",
							result: resultValue,
						};
					})
				: [],
		});
		finalText = summary || finalText;
	}
	if (
		finalText.trim().length === 0 &&
		(!Array.isArray(result.toolCalls) || result.toolCalls.length === 0)
	) {
		finalText = buildEmptyModelOutputFallback(message);
	}

	// Save assistant response
	const executionIdByToolCallId = new Map<string, string>();
	if (Array.isArray(result.toolResults)) {
		for (const tr of result.toolResults as unknown[]) {
			if (!tr || typeof tr !== "object") continue;
			const resultValue = (tr as { result?: unknown }).result;
			if (resultValue && typeof resultValue === "object") {
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
					const toolCallId =
						(tr as { toolCallId?: unknown }).toolCallId ??
						(tr as { id?: unknown }).id;
					if (typeof toolCallId === "string" && toolCallId.trim().length > 0) {
						executionIdByToolCallId.set(toolCallId, picked.trim());
					}
				}
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
			const toolName =
				rawArgs &&
				typeof rawArgs === "object" &&
				"toolName" in (rawArgs as any) &&
				typeof (rawArgs as any).toolName === "string"
					? String((rawArgs as any).toolName)
					: tc.toolName;
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
		promptTokens: result.usage?.inputTokens,
		completionTokens: result.usage?.outputTokens,
	});

	scheduleConversationSummaryUpdate({
		conversationId,
		model,
	});

	// Auto-generate title if first response (non-blocking)
	if (history.length <= 2 && conversation.title === "New Conversation") {
		try {
			const titleText = await generatePromptText({
				model,
				prompt: `Generate a short title (max 50 chars, no quotes) for this conversation. User message: "${message}". Reply with ONLY the title, nothing else.`,
				maxOutputTokens: 60,
			});
			const title = titleText.trim().slice(0, 50);
			if (title) {
				await updateConversation(conversationId, { title });
			}
		} catch (e) {
			console.error("Failed to generate title:", e);
		}
	}

	const usage: ChatUsage | undefined = result.usage
		? {
				inputTokens: result.usage.inputTokens,
				outputTokens: result.usage.outputTokens,
			}
		: undefined;

	return {
		message: assistantMessage,
		usage,
		toolResults: (result.toolResults ?? []) as unknown,
	};
};

// ============================================
// Streaming Chat Function (SSE)
// ============================================

export type ChatStreamOptions = {
	abortSignal?: AbortSignal;
	onTextDelta?: (delta: string) => void;
	onToolCall?: (toolCallId: string, toolName: string, args: unknown) => void;
	onToolResult?: (
		toolCallId: string,
		toolName: string,
		result: unknown,
	) => void;
	onError?: (error: string) => void;
};

export const chatStream = async (
	{ conversationId, message, aiId, organizationId, userId }: ChatParams,
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

	initializeTools();

	await saveMessage({
		conversationId,
		role: "user",
		content: message,
	});

	const history = await getMessages({ conversationId, limit: 20 });
	const messages: CoreMessage[] = history
		.map((msg) => {
			if (msg.role === "tool") return null;
			const content = (msg.content ?? "").trim();
			if (content.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content,
				};
			}
			const toolNames = (msg.toolCalls ?? [])
				.map((tc) => tc.function?.name)
				.filter(Boolean)
				.join(", ");
			if (toolNames.length > 0) {
				return {
					role: msg.role as "user" | "assistant" | "system",
					content: `[tool_calls: ${toolNames}]`,
				};
			}
			return null;
		})
		.filter(Boolean) as CoreMessage[];

	const toolExecutionContextMessage = await buildToolExecutionContextMessage({
		conversationId,
	});
	const messagesWithToolContext = injectToolExecutionContextMessage(
		messages,
		toolExecutionContextMessage,
	);

	const provider = selectAIProvider(aiSettings);
	const model = provider(aiSettings.model);
	const systemPrompt = buildSystemPrompt(
		conversation,
		buildMetaToolPromptInfo(),
	);

	const toolContext: ToolContext = {
		organizationId,
		userId,
		projectId: conversation.projectId || undefined,
		serverId: conversation.serverId || undefined,
	};

	const tools: Record<string, any> = {
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
			execute: async (params: { query: string; limit?: number }) => {
				const limit = params.limit ?? 15;
				const selected = selectRelevantTools(params.query, {
					projectId: toolContext.projectId,
					serverId: toolContext.serverId,
					minTools: 0,
					maxTools: limit,
				});
				return {
					success: true,
					message:
						selected.length > 0
							? `Suggested ${selected.length} tool(s) for "${params.query}"`
							: `No direct suggestions for "${params.query}". Use tool_search to explore the full catalog.`,
					data: selected.map((t) => ({
						name: t.name,
						description: t.description,
						category: t.category,
						riskLevel: t.riskLevel,
						requiresApproval: t.requiresApproval,
					})),
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
				domain: z
					.enum(TOOL_SEARCH_DOMAINS)
					.optional()
					.describe("Optional domain filter"),
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
			execute: async (params: {
				query: string;
				limit?: number;
				domain?: (typeof TOOL_SEARCH_DOMAINS)[number];
				category?: string;
				riskLevelMax?: "low" | "medium" | "high";
				requiresApproval?: boolean;
			}) => {
				return searchToolCatalog(params);
			},
		}),
		tool_describe: tool({
			description:
				"Describe a specific tool, including parameter hints extracted from its schema.",
			inputSchema: z.object({
				toolName: z
					.string()
					.min(1)
					.describe("Exact tool name, e.g. postgres_create"),
			}),
			execute: async (params: { toolName: string }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return buildUnknownToolSuggestionResult(params.toolName);
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
				"Execute a tool by name with params. Enforces validation and approval. Use tool_describe first if unsure about parameters.",
			inputSchema: z.object({
				toolName: z.string().min(1).describe("Exact tool name to execute"),
				params: z
					.record(z.any())
					.optional()
					.default({})
					.describe("Parameters object for the tool"),
			}),
			execute: async (params: { toolName: string; params?: unknown }) => {
				const t = toolRegistry.get(params.toolName);
				if (!t) {
					return buildUnknownToolSuggestionResult(params.toolName);
				}

				const rawParams = (params.params ?? {}) as Record<string, unknown>;
				const validation = t.parameters.safeParse(rawParams);
				if (!validation.success) {
					return {
						success: false,
						message: "Invalid parameters",
						error: validation.error.message,
						data: {
							toolName: t.name,
							confirmLiterals: extractConfirmLiterals(t.parameters),
							exampleParams: buildExampleParams(t.parameters),
						},
					};
				}

				const validatedParams = validation.data as unknown as Record<
					string,
					unknown
				>;

				const execution = await createToolExecution({
					conversationId,
					messageId: undefined,
					toolName: t.name,
					parameters: validatedParams,
					requiresApproval: t.requiresApproval,
				});

				if (t.requiresApproval) {
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

				try {
					const result = await t.execute(validation.data as never, toolContext);

					const completionUpdate: Record<string, unknown> = {
						status: result.success ? "completed" : "failed",
						result,
						completedAt: new Date().toISOString(),
					};
					if (!result.success) {
						completionUpdate.error = result.error || result.message;
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

	const runStream = async (withTools: boolean) => {
		const stopWhen = stepCountIs(10);
		const stream = streamText({
			model,
			system: systemPrompt,
			messages: messagesWithToolContext,
			tools: withTools ? tools : undefined,
			stopWhen,
			abortSignal: options.abortSignal,
		});

		let fullText = "";
		const toolCalls: Array<{
			id: string;
			type: "function";
			function: { name: string; arguments: string };
		}> = [];
		const toolNameByToolCallId = new Map<string, string>();
		let usage: { promptTokens?: number; completionTokens?: number } = {};
		const toolResults: Array<{
			toolCallId: string;
			toolName: string;
			result: unknown;
		}> = [];
		let streamError: string | null = null;
		let hasAnyOutput = false;

		try {
			for await (const chunk of stream.fullStream) {
				if (chunk.type === "text-delta") {
					const delta = typeof chunk.text === "string" ? chunk.text : "";
					if (delta.length === 0) continue;
					hasAnyOutput = true;

					fullText += delta;
					try {
						options.onTextDelta?.(delta);
					} catch {
						// Ignore callback errors (e.g., client disconnected)
					}
				} else if (chunk.type === "tool-call") {
					hasAnyOutput = true;
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
				} else if (chunk.type === "tool-result") {
					hasAnyOutput = true;
					const normalizedToolName =
						toolNameByToolCallId.get(chunk.toolCallId) ?? chunk.toolName;
					const toolResult =
						(chunk as unknown as { result?: unknown }).result ??
						(chunk as unknown as { output?: unknown }).output ??
						chunk;
					toolResults.push({
						toolCallId: chunk.toolCallId,
						toolName: normalizedToolName,
						result: toolResult,
					});
					try {
						options.onToolResult?.(
							chunk.toolCallId,
							normalizedToolName,
							toolResult,
						);
					} catch {
						// Ignore callback errors
					}
				} else if (chunk.type === "finish") {
					const usageObj = (chunk as { usage?: unknown }).usage as
						| { inputTokens?: number; outputTokens?: number }
						| undefined;
					usage = {
						promptTokens: usageObj?.inputTokens,
						completionTokens: usageObj?.outputTokens,
					};
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

		if (streamError != null && !options.abortSignal?.aborted && !hasAnyOutput) {
			throw new Error(streamError);
		}

		if (
			!hasAnyOutput &&
			fullText.length === 0 &&
			!options.abortSignal?.aborted
		) {
			fullText = buildEmptyModelOutputFallback(message);
			hasAnyOutput = true;
			try {
				options.onTextDelta?.(fullText);
			} catch {
				// Ignore callback errors
			}
		}

		return { fullText, toolCalls, toolResults, usage, streamError };
	};

	let streamed: Awaited<ReturnType<typeof runStream>>;
	try {
		streamed = await runStream(true);
	} catch (error) {
		if (isMissingToolUseIdError(error) && !options.abortSignal?.aborted) {
			streamed = await runStream(false);
		} else {
			throw error;
		}
	}

	if (
		streamed.fullText.trim().length === 0 &&
		Array.isArray(streamed.toolCalls) &&
		streamed.toolCalls.length > 0 &&
		!options.abortSignal?.aborted
	) {
		const summary = await generateToolOutcomeSummary({
			model,
			userMessage: message,
			toolCalls: streamed.toolCalls.map((tc) => ({
				id: tc.id,
				name: tc.function.name,
				arguments: (() => {
					try {
						return JSON.parse(tc.function.arguments);
					} catch {
						return tc.function.arguments;
					}
				})(),
			})),
			toolResults: streamed.toolResults,
			streamError: streamed.streamError,
		});

		if (summary.length > 0) {
			try {
				options.onTextDelta?.(summary);
			} catch {
				// Ignore callback errors
			}
			streamed.fullText = summary;
		}
	}

	const executionIdByToolCallId = new Map<string, string>();
	for (const tr of streamed.toolResults) {
		if (!tr || typeof tr !== "object") continue;
		const resultValue = (tr as { result?: unknown }).result;
		if (resultValue && typeof resultValue === "object") {
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
	}

	const toolCallsToPersist = streamed.toolCalls
		.map((tc) => ({
			...tc,
			executionId: executionIdByToolCallId.get(tc.id),
		}))
		.filter((tc) => tc.function.name !== "tool_call");

	const assistantMessage = await saveMessage({
		conversationId,
		role: "assistant",
		content: streamed.fullText,
		toolCalls: toolCallsToPersist.length > 0 ? toolCallsToPersist : undefined,
		promptTokens: streamed.usage.promptTokens,
		completionTokens: streamed.usage.completionTokens,
	});

	const usage: ChatUsage | undefined =
		streamed.usage.promptTokens != null ||
		streamed.usage.completionTokens != null
			? {
					inputTokens: streamed.usage.promptTokens,
					outputTokens: streamed.usage.completionTokens,
				}
			: undefined;

	scheduleConversationSummaryUpdate({
		conversationId,
		model,
	});

	if (history.length <= 2 && conversation.title === "New Conversation") {
		void (async () => {
			try {
				const titleText = await generatePromptText({
					model,
					prompt: `Generate a short title (max 50 chars, no quotes) for this conversation. User message: "${message}". Reply with ONLY the title, nothing else.`,
					maxOutputTokens: 60,
				});
				const title = titleText.trim().slice(0, 50);
				if (title) {
					await updateConversation(conversationId, { title });
				}
			} catch (e) {
				console.error("Failed to generate title:", e);
			}
		})();
	}

	return {
		message: assistantMessage,
		usage,
		toolResults: [],
	};
};

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
	context += `\nPlatform mode: ${IS_CLOUD ? "cloud" : "self-hosted"}`;

	const memorySummary =
		conversation.metadata &&
		typeof conversation.metadata === "object" &&
		"summary" in conversation.metadata &&
		typeof (conversation.metadata as { summary?: unknown }).summary === "string"
			? String((conversation.metadata as { summary?: unknown }).summary)
			: "";

	const toolList = availableTools
		.map(
			(t) =>
				`- ${t.name}: ${t.description} (Risk: ${t.riskLevel}${t.requiresApproval ? ", requires approval" : ""})`,
		)
		.join("\n");

	const guidelines = `Guidelines:
- Be concise and helpful
- You can access ALL platform capabilities through a tool catalog.
- Workflow:
  - Use tool_suggest to get a quick shortlist of likely relevant tools.
  - Use tool_search to find the best tool(s) for the user's intent.
  - Use tool_describe to see parameter hints for the chosen tool.
  - Use tool_call to create a tool execution by name.
  - If you already know the exact toolName and params, skip tool_suggest/tool_search/tool_describe and call tool_call directly.
- Approval workflow (critical):
  - If an action requires approval, you MUST call tool_call first to create a pending approval request (status = "pending_approval"). Do NOT ask for approval in natural language without a tool_call.
  - After you receive pending_approval, tell the user to approve/reject using the UI buttons (or by typing "批准/拒绝").
  - After approval, continue with the remaining steps (the platform may auto-resume execution).
- Context reuse:
  - If recent tool results already include what you need, reuse them instead of re-running read-only tools.
- Server context:
  - In self-hosted mode, if serverId is not provided, default to the local Dokploy host. Only ask for/require serverId when the user explicitly wants to target a remote server.
  - In cloud mode, serverId is required for server operations.
- For complex requests (especially GitHub deployments and debugging), always propose at least two viable plans and ask the user to choose one before any write action. The plans should help the user decide key choices like naming (project/appName), deployment method (application vs compose), repo/branch, and buildPath/composePath.
- Naming strategy:
  - If the user does not provide names, auto-generate them from the repository (owner/repo) without asking.
  - Defaults:
    - project name: repo name
    - application display name / compose display name: repo name
    - application appName / compose appName: repo name + short suffix (e.g., "repo-xxxx") to reduce collisions
  - If a create call fails due to name conflicts, retry once with a different suffix. Only ask the user if conflicts persist or if they have a naming preference.
- GitHub repository code changes (optional):
  - If the fix requires changing repository code, first ask the user whether they want you to create a PR.
  - If the user agrees, then use github_file_get to read the current file content, show a unified diff and explain why, and only then call github_branch_create/github_file_upsert/github_pull_request_create (approval required).
- Deployment debugging workflow:
  - Use deployment_list and deployment_log_tail to retrieve the failing deployment and its logs.
  - Prefer fixing Dokploy configuration first (e.g., application_update_github_source/compose_update_github_source).
  - If the fix requires repository code changes, ask the user whether they want a PR.
  - If you cannot fix the issue, clearly explain the root cause, what evidence you used (log excerpts), and what information or access is missing.
- Do NOT invent tool names. Always use tool_search/tool_describe first if unsure.
- For any request that can change platform state (create/deploy/restart/delete/update), first restate the user's intent in one sentence, then list any missing required details, then proceed.
- If the user's request is ambiguous, do NOT assume. Ask focused clarifying questions. Prefer asking 1-3 questions max per turn.
- If the user says “直接执行/用默认/别问/少问”, proceed with safe defaults and state them briefly; ask at most 1 blocking question only if required to avoid harm.
- Never guess IDs (projectId/serverId/environmentId/applicationId/etc). Use *find*/*list* tools to locate candidates, then ask the user to confirm when ambiguous.
- Do not ask the user for information you can retrieve via tools.
- Prefer read-only tools first (list/get/status/check/find) to understand the current state.
- For low-risk operations (list, get, status, check, find), execute immediately.
- For medium/high risk operations:
  - If requiresApproval=false, explain what will happen BEFORE calling tool_call (it will execute immediately).
  - If requiresApproval=true, you may call tool_call immediately to create a pending approval request (this does NOT execute yet), then ask the user to approve/reject.
- Always report the results of tool executions clearly
- If you do not have the necessary tool in the Available Tools list, do NOT claim the platform cannot do it. Instead: explain that the current toolset for this request is insufficient, state what tool/category is missing, and suggest the next best step (e.g., use list/find tools, or ask an admin to enable the capability).
- Database provisioning flow:
  - If user wants to deploy a database, first identify the target project/environment using tools (project_list/project_find, environment_list/environment_find).
  - If the user asks for PostgreSQL 17, prefer docker image "postgres:17".
  - Only call create/deploy tools after you have the environmentId and the user has explicitly confirmed the exact action.`;

	return `You are Dokploy AI Assistant, an expert DevOps assistant for the Dokploy PaaS platform.

You help users manage their applications, databases, and infrastructure through natural language.
You have access to tools that can execute real operations on the platform.

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

export const cancelRun = async (runId: string) => {
	return updateRun(runId, {
		status: "cancelled",
		completedAt: new Date().toISOString(),
	});
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

export const startAgentRun = async (params: {
	conversationId: string;
	goal: string;
	aiId: string;
	organizationId: string;
	userId: string;
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

	initializeTools();
	const picked = searchToolCatalog({ query: params.goal, limit: 1 });
	const nextCall = picked.meta.nextCall;
	if (!nextCall) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Unable to derive an initial plan for goal: ${params.goal}`,
		});
	}

	const tool = toolRegistry.get(nextCall.toolName);
	if (!tool) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Planned tool not found: ${nextCall.toolName}`,
		});
	}

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

	const stepId = nanoid();
	const plan = {
		steps: [
			{
				id: stepId,
				toolName: tool.name,
				description: `Execute ${tool.name} for goal: ${params.goal}`,
				parameters: nextCall.params,
				requiresApproval: tool.requiresApproval,
			},
		],
	};

	await updateRun(run.runId, { plan });

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
			plan,
		},
	});

	const toolContext: ToolContext = {
		organizationId: params.organizationId,
		userId: params.userId,
		projectId: conversation.projectId ?? undefined,
		serverId: conversation.serverId ?? undefined,
	};

	void (async () => {
		try {
			await orchestrateRun(run.runId, toolContext);
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
	})();

	return run;
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

	void (async () => {
		try {
			await orchestrateRun(params.runId, toolContext);
		} catch {}
	})();
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

	if (updated && !approved) {
		await appendToolOutcomeAssistantMessage({
			conversationId: updated.conversationId,
			toolName: updated.toolName,
			executionId: updated.executionId,
			outcome: "rejected",
			result: { success: false, message: "Rejected" },
		});
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
			result: { success: false, message: "Invalid parameters", error: errorMessage },
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
			result: { success: false, message: "Tool execution failed", error: errorMessage },
		});

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Tool execution failed: ${errorMessage}`,
		});
	}
};
