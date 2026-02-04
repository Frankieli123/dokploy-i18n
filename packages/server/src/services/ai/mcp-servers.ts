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
	return String(value ?? "").trim().replace(/\/+$/, "");
}

async function withMcpClient<T>(params: {
	serverUrl: string;
	headers: Record<string, string>;
	fn: (client: McpClient) => Promise<T>;
}): Promise<T> {
	let Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
	let StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
	try {
		({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
		({ StreamableHTTPClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/streamableHttp.js"
		));
	} catch (error) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "MCP SDK is not available on this server",
			cause: error,
		});
	}

	const url = new URL(params.serverUrl);
	const transport = new StreamableHTTPClientTransport(url, {
		requestInit: {
			headers: params.headers,
		},
	});
	const client = new Client({ name: "dokploy", version: "1.0.0" });
	await client.connect(transport);
	try {
		return await params.fn(client);
	} finally {
		try {
			await client.close();
		} catch {}
		try {
			await transport.terminateSession();
		} catch {}
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
		throw new TRPCError({ code: "BAD_REQUEST", message: "MCP server id is required" });
	}

	const server = await db.query.aiMcpServers.findFirst({
		where: eq(aiMcpServers.mcpServerId, id),
	});
	if (!server || server.organizationId !== params.organizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
	}
	if (!server.isEnabled) {
		throw new TRPCError({ code: "FORBIDDEN", message: "MCP server is disabled" });
	}

	const serverUrl = normalizeMcpServerUrl(server.serverUrl);
	const headers = normalizeMcpHeaders(server.headers);

	const res = await withMcpClient({
		serverUrl,
		headers,
		fn: (client) => client.listTools({}),
	});

	const toolsRaw = Array.isArray((res as any)?.tools) ? (res as any).tools : [];
	const tools: AiMcpToolInfo[] = toolsRaw.map((t: any) => ({
		name: typeof t?.name === "string" ? t.name : "",
		description: typeof t?.description === "string" ? t.description : undefined,
		inputSchema: t?.inputSchema,
		outputSchema: t?.outputSchema,
		annotations: t?.annotations,
	})).filter((t: AiMcpToolInfo) => t.name.trim().length > 0);

	return { serverUrl, tools };
};

export const callAiMcpTool = async (params: {
	organizationId: string;
	mcpServerId: string;
	toolName: string;
	arguments?: Record<string, unknown>;
}): Promise<AiMcpToolCallResult> => {
	const id = String(params.mcpServerId ?? "").trim();
	if (!id) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "MCP server id is required" });
	}
	const toolName = String(params.toolName ?? "").trim();
	if (!toolName) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "MCP tool name is required" });
	}

	const server = await db.query.aiMcpServers.findFirst({
		where: eq(aiMcpServers.mcpServerId, id),
	});
	if (!server || server.organizationId !== params.organizationId) {
		throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
	}
	if (!server.isEnabled) {
		throw new TRPCError({ code: "FORBIDDEN", message: "MCP server is disabled" });
	}

	const serverUrl = normalizeMcpServerUrl(server.serverUrl);
	const headers = normalizeMcpHeaders(server.headers);
	const args =
		params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
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
