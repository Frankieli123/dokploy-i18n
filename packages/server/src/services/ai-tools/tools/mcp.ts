import { z } from "zod";
import { callAiMcpTool, listAiMcpTools, listAiMcpServersByOrganizationId } from "../../ai/mcp-servers";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const mcpServerList: Tool<
	{ includeDisabled?: boolean },
	Array<{
		mcpServerId: string;
		name: string;
		serverUrl: string;
		isEnabled: boolean;
		headersCount: number;
	}>
> = {
	name: "mcp_server_list",
	description: "List configured MCP servers for the current organization",
	category: "settings",
	tags: ["mcp", "tools", "servers", "list"],
	parameters: z.object({
		includeDisabled: z.boolean().optional().default(false),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const rows = await listAiMcpServersByOrganizationId({
			organizationId: ctx.organizationId,
			limit: 100,
			offset: 0,
		});

		const filtered = params.includeDisabled
			? rows
			: rows.filter((r) => r.isEnabled);

		return {
			success: true,
			message: `Found ${filtered.length} MCP server(s)`,
			data: filtered.map((r) => ({
				mcpServerId: r.mcpServerId,
				name: r.name,
				serverUrl: r.serverUrl,
				isEnabled: r.isEnabled,
				headersCount:
					r.headers && typeof r.headers === "object"
						? Object.keys(r.headers as Record<string, unknown>).length
						: 0,
			})),
		};
	},
};

const mcpToolList: Tool<
	{ mcpServerId: string; includeSchemas?: boolean },
	Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }>
> = {
	name: "mcp_tool_list",
	description: "List tools from an MCP server (tools/list)",
	category: "settings",
	tags: ["mcp", "tools", "list"],
	parameters: z.object({
		mcpServerId: z.string().min(1),
		includeSchemas: z.boolean().optional().default(false),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const res = await listAiMcpTools({
			organizationId: ctx.organizationId,
			mcpServerId: params.mcpServerId,
		});

		const tools = res.tools.map((t) => ({
			name: t.name,
			description: t.description,
			...(params.includeSchemas
				? {
						inputSchema: t.inputSchema,
						outputSchema: t.outputSchema,
					}
				: {}),
		}));

		return {
			success: true,
			message: `Listed ${tools.length} MCP tool(s)`,
			data: tools,
		};
	},
};

const mcpToolCall: Tool<
	{
		mcpServerId: string;
		toolName: string;
		arguments?: unknown;
		args?: unknown;
	},
	unknown
> = {
	name: "mcp_tool_call",
	description:
		"Call a tool on an MCP server (tools/call). Use mcp_tool_list first to discover tool names and required arguments.",
	category: "settings",
	tags: ["mcp", "tools", "call", "invoke"],
	parameters: z.object({
		mcpServerId: z.string().min(1),
		toolName: z.string().min(1),
		arguments: z.any().optional(),
		args: z.any().optional(),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const toolName = params.toolName.trim();
		let args = typeof params.arguments !== "undefined" ? params.arguments : params.args;

		if (args === null) args = undefined;
		if (typeof args === "string") {
			const trimmed = args.trim();
			if (
				(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
				(trimmed.startsWith("[") && trimmed.endsWith("]"))
			) {
				try {
					args = JSON.parse(trimmed);
				} catch {
					// ignore
				}
			}
		}

		const isPlainObject =
			typeof args === "object" && args !== null && !Array.isArray(args);
		if (typeof args !== "undefined" && !isPlainObject) {
			return {
				success: false,
				message: `MCP tool "${toolName}" expects an arguments object`,
				error: "MCP_ARGUMENTS_OBJECT_EXPECTED",
				data: {
					toolName,
					hint: "Use mcp_tool_list(includeSchemas=true) to see required fields, then retry with an object.",
				},
			};
		}

		const result = await callAiMcpTool({
			organizationId: ctx.organizationId,
			mcpServerId: params.mcpServerId,
			toolName,
			arguments: (args ?? {}) as Record<string, unknown>,
		});

		if (result.isError === true) {
			return {
				success: false,
				message: `MCP tool "${toolName}" returned an error`,
				error: "MCP_TOOL_ERROR",
				data: result,
			};
		}

		return {
			success: true,
			message: `MCP tool "${toolName}" executed`,
			data: result,
		};
	},
};

export function registerMcpTools() {
	toolRegistry.register(mcpServerList);
	toolRegistry.register(mcpToolList);
	toolRegistry.register(mcpToolCall);
}
