import { createHash } from "node:crypto";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { db } from "@dokploy/server/db";
import { aiMcpServers } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";

type McpClient = import("@modelcontextprotocol/sdk/client/index.js").Client;

export type AiMcpServerTestResult = {
	status: "ok" | "error";
	toolCount?: number;
	toolNames?: string[];
	latencyMs?: number;
	error?: string;
};

export type AiMcpToolInfo = {
	name: string;
	description?: string;
	inputSchema?: unknown;
	outputSchema?: unknown;
	annotations?: unknown;
};

export type AiMcpToolCallResult = {
	content?: unknown;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	raw?: unknown;
};

type AiMcpToolListCacheEntry = {
	serverUrl: string;
	tools: AiMcpToolInfo[];
	fetchedAt: number;
	expiresAt: number;
	error?: string;
};

const MCP_TOOL_LIST_TTL_MS = 5 * 60 * 1000;
const MCP_TOOL_LIST_ERROR_TTL_MS = 15 * 1000;
const MCP_TOOL_LIST_CACHE_MAX_ENTRIES = 200;
const mcpToolListCache = new Map<string, AiMcpToolListCacheEntry>();
const mcpToolListInFlight = new Map<string, Promise<AiMcpToolListCacheEntry>>();

function getMcpToolListCacheKey(params: {
	organizationId: string;
	mcpServerId: string;
}): string {
	const orgId = String(params.organizationId ?? "").trim();
	const serverId = String(params.mcpServerId ?? "").trim();
	return `${orgId}:${serverId}`;
}

function touchMcpToolListCacheEntry(
	key: string,
	entry: AiMcpToolListCacheEntry,
) {
	mcpToolListCache.delete(key);
	mcpToolListCache.set(key, entry);
}

function enforceMcpToolListCacheLimit() {
	while (mcpToolListCache.size > MCP_TOOL_LIST_CACHE_MAX_ENTRIES) {
		const oldestKey = mcpToolListCache.keys().next().value as string | undefined;
		if (!oldestKey) break;
		mcpToolListCache.delete(oldestKey);
	}
}

export type AiMcpInputValidationIssue = {
	path: string;
	message: string;
	keyword?: string;
};

const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
type AjvValidatorCacheEntry = { validate: ValidateFunction; expiresAt: number };
const MCP_INPUT_VALIDATOR_TTL_MS = 10 * 60 * 1000;
const MCP_INPUT_VALIDATOR_CACHE_MAX_ENTRIES = 500;
const mcpInputValidatorCache = new Map<string, AjvValidatorCacheEntry>();

function hashSchemaKey(schema: unknown): string | null {
	try {
		const json = JSON.stringify(schema);
		return createHash("sha256").update(json).digest("hex");
	} catch {
		return null;
	}
}

function getAjvValidator(schema: unknown): ValidateFunction | null {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;

	const key = hashSchemaKey(schema);
	if (!key) return null;

	const now = Date.now();
	const cached = mcpInputValidatorCache.get(key);
	if (cached && cached.expiresAt > now) {
		mcpInputValidatorCache.delete(key);
		mcpInputValidatorCache.set(key, cached);
		return cached.validate;
	}
	if (cached) mcpInputValidatorCache.delete(key);

	try {
		const validate = ajv.compile(schema as any);
		mcpInputValidatorCache.set(key, {
			validate,
			expiresAt: now + MCP_INPUT_VALIDATOR_TTL_MS,
		});
		while (mcpInputValidatorCache.size > MCP_INPUT_VALIDATOR_CACHE_MAX_ENTRIES) {
			const oldestKey = mcpInputValidatorCache.keys().next()
				.value as string | undefined;
			if (!oldestKey) break;
			mcpInputValidatorCache.delete(oldestKey);
		}
		return validate;
	} catch {
		return null;
	}
}

function decodeJsonPointerSegment(seg: string): string {
	return seg.replaceAll("~1", "/").replaceAll("~0", "~");
}

function jsonPointerToPath(pointer: string): string {
	if (!pointer) return "";
	const parts = pointer
		.split("/")
		.slice(1)
		.map((p) => decodeJsonPointerSegment(p));

	let out = "";
	for (const part of parts) {
		if (!part) continue;
		if (/^\d+$/.test(part)) {
			out += `[${part}]`;
			continue;
		}
		out += out.length > 0 ? `.${part}` : part;
	}
	return out;
}

function ajvErrorToIssue(err: ErrorObject): AiMcpInputValidationIssue {
	const keyword = typeof err.keyword === "string" ? err.keyword : undefined;
	const instancePath =
		typeof err.instancePath === "string" ? err.instancePath : "";
	const base = jsonPointerToPath(instancePath);

	const message = typeof err.message === "string" ? err.message : "Invalid value";
	if (keyword === "required") {
		const missing = (err.params as { missingProperty?: unknown } | undefined)
			?.missingProperty;
		const missingKey = typeof missing === "string" ? missing : "";
		const fullPath =
			missingKey.length > 0 ? (base ? `${base}.${missingKey}` : missingKey) : base;
		return { path: fullPath || "<root>", message, keyword };
	}
	if (keyword === "additionalProperties") {
		const extra = (err.params as { additionalProperty?: unknown } | undefined)
			?.additionalProperty;
		const extraKey = typeof extra === "string" ? extra : "";
		const fullPath =
			extraKey.length > 0 ? (base ? `${base}.${extraKey}` : extraKey) : base;
		return { path: fullPath || "<root>", message, keyword };
	}

	return { path: base || "<root>", message, keyword };
}

export function validateAiMcpToolArguments(params: {
	inputSchema?: unknown;
	arguments?: unknown;
}):
	| { ok: true }
	| { ok: false; issues: AiMcpInputValidationIssue[]; errorText: string } {
	const schema = params.inputSchema;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { ok: true };

	const validate = getAjvValidator(schema);
	if (!validate) return { ok: true };

	const ok = validate(params.arguments);
	if (ok) return { ok: true };

	const issues = (validate.errors ?? [])
		.slice(0, 12)
		.map(ajvErrorToIssue)
		.filter((x) => x.message.trim().length > 0);
	const errorText =
		issues.length > 0
			? issues.map((x) => `${x.path}: ${x.message}`).join("\n")
			: "Invalid parameters";
	return { ok: false, issues, errorText };
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

function normalizeMcpHeaders(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		const key = String(k ?? "").trim();
		if (!key) continue;
		const val = typeof v === "string" ? v : v == null ? "" : String(v);
		headers[key] = val;
	}
	return headers;
}

function normalizeMcpServerUrl(value: unknown): string {
	return String(value ?? "")
		.trim()
		.replace(/\/+$/, "");
}

function inferMcpTransportFromUrl(
	serverUrl: string,
): "streamable" | "sse" | null {
	try {
		const parsed = new URL(serverUrl);
		const transportHint = (
			parsed.searchParams.get("mcp_transport") ??
			parsed.searchParams.get("transport") ??
			""
		)
			.trim()
			.toLowerCase();

		if (transportHint === "sse") return "sse";
		if (transportHint === "streamable" || transportHint === "streamable_http") {
			return "streamable";
		}

		const pathname = parsed.pathname.toLowerCase();
		if (/(^|\/)sse(\/|$)/.test(pathname)) return "sse";
		return null;
	} catch {
		return null;
	}
}

function shouldFallbackToSse(error: unknown): boolean {
	const code = Number((error as { code?: unknown })?.code);
	if (Number.isFinite(code) && code === 405) return true;

	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/error posting to endpoint/i.test(message)) {
		if (/\b405\b|method not allowed/i.test(message)) return true;
	}
	return false;
}

function formatTransportError(error: unknown): string {
	if (!error) return "Unknown error";
	if (error instanceof Error) return error.message;
	return String(error);
}

async function closeMcpTransport(transport: {
	terminateSession?: () => Promise<void> | void;
	close?: () => Promise<void> | void;
}) {
	try {
		if (typeof transport.terminateSession === "function") {
			await transport.terminateSession();
			return;
		}
		if (typeof transport.close === "function") {
			await transport.close();
		}
	} catch {}
}

async function withMcpClient<T>(params: {
	serverUrl: string;
	headers: Record<string, string>;
	fn: (client: McpClient) => Promise<T>;
}): Promise<T> {
	let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
	let StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
	let SSEClientTransport: typeof import("@modelcontextprotocol/sdk/client/sse.js").SSEClientTransport;
	try {
		({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
		({ StreamableHTTPClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/streamableHttp.js"
		));
		({ SSEClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/sse.js"
		));
	} catch (error) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "MCP SDK is not available on this server",
			cause: error,
		});
	}

	const url = new URL(params.serverUrl);
	const requestInit = { headers: params.headers };

	const runWithTransport = async (
		transportType: "streamable" | "sse",
	): Promise<T> => {
		const transport =
			transportType === "sse"
				? new SSEClientTransport(url, { requestInit })
				: new StreamableHTTPClientTransport(url, { requestInit });
		const mcpTransport = transport as Parameters<McpClient["connect"]>[0] & {
			terminateSession?: () => Promise<void> | void;
			close?: () => Promise<void> | void;
		};
		const client = new Client({ name: "dokploy", version: "1.0.0" });

		try {
			await client.connect(mcpTransport);
			return await params.fn(client);
		} finally {
			try {
				await client.close();
			} catch {}
			await closeMcpTransport(mcpTransport);
		}
	};

	const hintedTransport = inferMcpTransportFromUrl(params.serverUrl);
	if (hintedTransport === "sse") {
		return await runWithTransport("sse");
	}
	if (hintedTransport === "streamable") {
		return await runWithTransport("streamable");
	}

	try {
		return await runWithTransport("streamable");
	} catch (streamableError) {
		if (!shouldFallbackToSse(streamableError)) throw streamableError;
		try {
			return await runWithTransport("sse");
		} catch (sseError) {
			throw new Error(
				`MCP transport negotiation failed. Streamable HTTP: ${formatTransportError(
					streamableError,
				)}; SSE fallback: ${formatTransportError(sseError)}`,
			);
		}
	}
}

export const listAiMcpServersByOrganizationId = async (params: {
	organizationId: string;
	limit?: number;
	offset?: number;
}) => {
	const limit = Math.max(1, Math.min(100, Number(params.limit ?? 50)));
	const offset = Math.max(0, Number(params.offset ?? 0));
	return await db.query.aiMcpServers.findMany({
		where: eq(aiMcpServers.organizationId, params.organizationId),
		orderBy: desc(aiMcpServers.updatedAt),
		limit,
		offset,
	});
};

export const createAiMcpServer = async (
	organizationId: string,
	input: {
		name: string;
		serverUrl: string;
		headers?: Record<string, string>;
		isEnabled?: boolean;
	},
) => {
	const name = String(input.name ?? "").trim();
	const serverUrl = normalizeMcpServerUrl(input.serverUrl);
	const headers = normalizeMcpHeaders(input.headers);
	const isEnabled = input.isEnabled !== false;

	if (!name || !serverUrl) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "MCP server name and URL are required",
		});
	}

	const [row] = await db
		.insert(aiMcpServers)
		.values({
			organizationId,
			name,
			serverUrl,
			headers,
			isEnabled,
		})
		.returning();

	if (!row) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to create MCP server",
		});
	}

	return row;
};

export const updateAiMcpServer = async (
	organizationId: string,
	input: {
		mcpServerId: string;
		name?: string;
		serverUrl?: string;
		headers?: Record<string, string>;
		isEnabled?: boolean;
	},
) => {
	const mcpServerId = String(input.mcpServerId ?? "").trim();
	if (!mcpServerId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "MCP server id is required",
		});
	}

	const existing = await db.query.aiMcpServers.findFirst({
		where: eq(aiMcpServers.mcpServerId, mcpServerId),
	});
	if (!existing || existing.organizationId !== organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "MCP server not found",
		});
	}

	const update: Record<string, unknown> = {
		updatedAt: new Date().toISOString(),
	};
	if (typeof input.name === "string") {
		const name = input.name.trim();
		if (!name) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "MCP server name is required",
			});
		}
		update.name = name;
	}
	if (typeof input.serverUrl === "string") {
		const serverUrl = normalizeMcpServerUrl(input.serverUrl);
		if (!serverUrl) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "MCP server URL is required",
			});
		}
		update.serverUrl = serverUrl;
	}
	if (typeof input.isEnabled === "boolean") {
		update.isEnabled = input.isEnabled;
	}
	if (typeof input.headers !== "undefined") {
		update.headers = normalizeMcpHeaders(input.headers);
	}

	const [row] = await db
		.update(aiMcpServers)
		.set(update)
		.where(eq(aiMcpServers.mcpServerId, mcpServerId))
		.returning();

	if (!row) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to update MCP server",
		});
	}

	return row;
};

export const deleteAiMcpServer = async (
	organizationId: string,
	mcpServerId: string,
) => {
	const id = String(mcpServerId ?? "").trim();
	if (!id) return;
	const existing = await db.query.aiMcpServers.findFirst({
		where: eq(aiMcpServers.mcpServerId, id),
		columns: {
			mcpServerId: true,
			organizationId: true,
		},
	});
	if (!existing || existing.organizationId !== organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "MCP server not found",
		});
	}
	await db.delete(aiMcpServers).where(eq(aiMcpServers.mcpServerId, id));
};

export const testAiMcpServer = async (params: {
	organizationId: string;
	mcpServerId: string;
}): Promise<AiMcpServerTestResult> => {
	const id = String(params.mcpServerId ?? "").trim();
	if (!id) {
		return { status: "error", error: "MCP server id is required" };
	}

	const server = await db.query.aiMcpServers.findFirst({
		where: eq(aiMcpServers.mcpServerId, id),
	});
	if (!server || server.organizationId !== params.organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "MCP server not found",
		});
	}

	const serverUrl = normalizeMcpServerUrl(server.serverUrl);
	const headers = normalizeMcpHeaders(server.headers);
	const startedAt = Date.now();

	try {
		const res = await withMcpClient({
			serverUrl,
			headers,
			fn: (client) => client.listTools({}),
		});
		const tools = Array.isArray((res as any)?.tools) ? (res as any).tools : [];
		const toolNames = tools
			.map((t: any) => (typeof t?.name === "string" ? t.name : ""))
			.filter((n: string) => n.trim().length > 0)
			.slice(0, 20);
		return {
			status: "ok",
			toolCount: tools.length,
			toolNames,
			latencyMs: Date.now() - startedAt,
		};
	} catch (error) {
		return {
			status: "error",
			error: getProviderErrorText(error) || "MCP test failed",
			latencyMs: Date.now() - startedAt,
		};
	}
};

export const listAiMcpTools = async (params: {
	organizationId: string;
	mcpServerId: string;
}): Promise<{ serverUrl: string; tools: AiMcpToolInfo[] }> => {
	const id = String(params.mcpServerId ?? "").trim();
	if (!id) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "MCP server id is required",
		});
	}

	const server = await db.query.aiMcpServers.findFirst({
		where: eq(aiMcpServers.mcpServerId, id),
	});
	if (!server || server.organizationId !== params.organizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
	}
	if (!server.isEnabled) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "MCP server is disabled",
		});
	}

	const serverUrl = normalizeMcpServerUrl(server.serverUrl);
	const headers = normalizeMcpHeaders(server.headers);

	const res = await withMcpClient({
		serverUrl,
		headers,
		fn: (client) => client.listTools({}),
	});

	const toolsRaw = Array.isArray((res as any)?.tools) ? (res as any).tools : [];
	const tools: AiMcpToolInfo[] = toolsRaw
		.map((t: any) => ({
			name: typeof t?.name === "string" ? t.name : "",
			description:
				typeof t?.description === "string" ? t.description : undefined,
			inputSchema: t?.inputSchema,
			outputSchema: t?.outputSchema,
			annotations: t?.annotations,
		}))
		.filter((t: AiMcpToolInfo) => t.name.trim().length > 0);

	return { serverUrl, tools };
};

export const listAiMcpToolsCached = async (params: {
	organizationId: string;
	mcpServerId: string;
	forceRefresh?: boolean;
}): Promise<{
	serverUrl: string;
	tools: AiMcpToolInfo[];
	cached: boolean;
	error?: string;
}> => {
	const id = String(params.mcpServerId ?? "").trim();
	if (!id) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "MCP server id is required",
		});
	}

	const orgId = String(params.organizationId ?? "").trim();
	if (!orgId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Organization id is required",
		});
	}

	const cacheKey = getMcpToolListCacheKey({
		organizationId: orgId,
		mcpServerId: id,
	});
	const now = Date.now();
	const cached = params.forceRefresh ? undefined : mcpToolListCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		touchMcpToolListCacheEntry(cacheKey, cached);
		return {
			serverUrl: cached.serverUrl,
			tools: cached.tools,
			cached: true,
			error: cached.error,
		};
	}
	if (cached) mcpToolListCache.delete(cacheKey);

	const inFlight = mcpToolListInFlight.get(cacheKey);
	if (inFlight) {
		const entry = await inFlight;
		if (entry.expiresAt > Date.now()) {
			touchMcpToolListCacheEntry(cacheKey, entry);
		}
		return {
			serverUrl: entry.serverUrl,
			tools: entry.tools,
			cached: true,
			error: entry.error,
		};
	}

	const promise = (async (): Promise<AiMcpToolListCacheEntry> => {
		const fetchedAt = Date.now();
		try {
			const res = await listAiMcpTools({
				organizationId: orgId,
				mcpServerId: id,
			});
			const entry: AiMcpToolListCacheEntry = {
				serverUrl: res.serverUrl,
				tools: res.tools,
				fetchedAt,
				expiresAt: fetchedAt + MCP_TOOL_LIST_TTL_MS,
			};
			mcpToolListCache.set(cacheKey, entry);
			enforceMcpToolListCacheLimit();
			return entry;
		} catch (error) {
			const entry: AiMcpToolListCacheEntry = {
				serverUrl: "",
				tools: [],
				fetchedAt,
				expiresAt: fetchedAt + MCP_TOOL_LIST_ERROR_TTL_MS,
				error: getProviderErrorText(error) || "MCP tool list failed",
			};
			mcpToolListCache.set(cacheKey, entry);
			enforceMcpToolListCacheLimit();
			return entry;
		} finally {
			mcpToolListInFlight.delete(cacheKey);
		}
	})();

	mcpToolListInFlight.set(cacheKey, promise);
	const entry = await promise;
	return {
		serverUrl: entry.serverUrl,
		tools: entry.tools,
		cached: false,
		error: entry.error,
	};
};

export const callAiMcpTool = async (params: {
	organizationId: string;
	mcpServerId: string;
	toolName: string;
	arguments?: Record<string, unknown>;
}): Promise<AiMcpToolCallResult> => {
	const id = String(params.mcpServerId ?? "").trim();
	if (!id) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "MCP server id is required",
		});
	}
	const toolName = String(params.toolName ?? "").trim();
	if (!toolName) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "MCP tool name is required",
		});
	}

	const server = await db.query.aiMcpServers.findFirst({
		where: eq(aiMcpServers.mcpServerId, id),
	});
	if (!server || server.organizationId !== params.organizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
	}
	if (!server.isEnabled) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "MCP server is disabled",
		});
	}

	const serverUrl = normalizeMcpServerUrl(server.serverUrl);
	const headers = normalizeMcpHeaders(server.headers);
	const args =
		params.arguments &&
		typeof params.arguments === "object" &&
		!Array.isArray(params.arguments)
			? params.arguments
			: {};

	const res = await withMcpClient({
		serverUrl,
		headers,
		fn: (client) => client.callTool({ name: toolName, arguments: args }),
	});

	const value = res as any;
	return {
		content: value?.content,
		structuredContent:
			value?.structuredContent && typeof value.structuredContent === "object"
				? value.structuredContent
				: undefined,
		isError: typeof value?.isError === "boolean" ? value.isError : undefined,
		raw: res,
	};
};
