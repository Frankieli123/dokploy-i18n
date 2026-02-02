import { z } from "zod";
import { TrpcBridgeSubscriptionError, getTrpcBridge } from "../../ai/trpc-bridge";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const bridgeNotConfigured = () => ({
	success: false as const,
	message:
		"tRPC bridge is not configured (dokploy app must call setTrpcBridge at runtime)",
	error: "TRPC_BRIDGE_NOT_CONFIGURED",
});

const trpcRouterList: Tool<
	Record<string, never>,
	Array<{
		name: string;
		total: number;
		queries: number;
		mutations: number;
		subscriptions: number;
	}>
> = {
	name: "trpc_router_list",
	description: "List top-level tRPC routers and procedure counts",
	category: "settings",
	tags: ["trpc", "api", "routers", "list"],
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async () => {
		const bridge = getTrpcBridge();
		if (!bridge) return bridgeNotConfigured();

		try {
			const routers = await bridge.listRouters();
			return {
				success: true,
				message: `Found ${routers.length} tRPC router(s)`,
				data: routers,
			};
		} catch (error) {
			return {
				success: false,
				message: "Failed to list tRPC routers",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

const trpcProcedureSearch: Tool<
	{ query: string; limit?: number },
	Array<{ name: string; type: string }>
> = {
	name: "trpc_procedure_search",
	description:
		"Search tRPC procedure names. Prefer trpc_procedure_suggest to get examples immediately.",
	category: "settings",
	tags: ["trpc", "api", "procedure", "search"],
	parameters: z.object({
		query: z.string().min(1).describe("Search keyword (e.g. project create)"),
		limit: z.number().min(1).max(50).optional().default(20),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const bridge = getTrpcBridge();
		if (!bridge) return bridgeNotConfigured();

		try {
			const results = await bridge.searchProcedures({
				query: params.query,
				limit: params.limit ?? 20,
			});
			return {
				success: true,
				message: `Found ${results.length} tRPC procedure(s)`,
				data: results,
			};
		} catch (error) {
			return {
				success: false,
				message: "Failed to search tRPC procedures",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

const trpcProcedureSuggest: Tool<
	{ query: string; limit?: number },
	Array<{
		name: string;
		type: string;
		inputExample: Record<string, unknown> | null;
		fields?: Array<{ name: string; type: string; required: boolean }>;
	}>
> = {
	name: "trpc_procedure_suggest",
	description:
		"Search tRPC procedure names and include input examples for the top matches. Preferred over simple search.",
	category: "settings",
	tags: ["trpc", "api", "procedure", "suggest", "help", "schema"],
	parameters: z.object({
		query: z.string().min(1).describe("Search keyword (e.g. backup, domain create)"),
		limit: z.number().min(1).max(20).optional().default(8),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const bridge = getTrpcBridge();
		if (!bridge) return bridgeNotConfigured();

		try {
			const results = await bridge.searchProcedures({
				query: params.query,
				limit: params.limit ?? 8,
			});
			const described = await Promise.all(
				results.map(async (r) => {
					try {
						return await bridge.describeProcedure(r.name);
					} catch {
						return {
							name: r.name,
							type: r.type,
							inputExample: null,
						};
					}
				}),
			);

			return {
				success: true,
				message: `Suggested ${described.length} tRPC procedure(s)`,
				data: described,
			};
		} catch (error) {
			return {
				success: false,
				message: "Failed to suggest tRPC procedures",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

const trpcProcedureDescribe: Tool<
	{ procedureName: string },
	{
		name: string;
		type: string;
		inputExample: Record<string, unknown> | null;
		fields?: Array<{ name: string; type: string; required: boolean }>;
	}
> = {
	name: "trpc_procedure_describe",
	description:
		"Describe a tRPC procedure input shape and provide an example input object.",
	category: "settings",
	tags: ["trpc", "api", "procedure", "describe", "schema"],
	parameters: z.object({
		procedureName: z
			.string()
			.min(1)
			.describe('Procedure name (e.g. "project.create")'),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const bridge = getTrpcBridge();
		if (!bridge) return bridgeNotConfigured();

		try {
			const desc = await bridge.describeProcedure(params.procedureName);
			return {
				success: true,
				message: `Procedure "${desc.name}" described`,
				data: desc,
			};
		} catch (error) {
			return {
				success: false,
				message: `Failed to describe tRPC procedure "${params.procedureName}"`,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

const trpcProcedureCall: Tool<
	{ procedureName: string; input?: unknown; params?: unknown },
	unknown
> = {
	name: "trpc_procedure_call",
	description:
		"Call any tRPC procedure by name (runs as current user). Use trpc_procedure_describe first to get the input shape. Queries run without approval; mutations are approval-gated unless approvals are disabled for the conversation. Subscriptions collect emitted values until completion/timeout and return them as an object.",
	category: "settings",
	tags: ["trpc", "api", "procedure", "call", "invoke"],
	parameters: z.object({
		procedureName: z
			.string()
			.min(1)
			.describe('Procedure name (e.g. "project.create")'),
		input: z.any().optional().describe("Procedure input (JSON)"),
		params: z
			.any()
			.optional()
			.describe('Alias of "input" (some callers send params instead of input)'),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const bridge = getTrpcBridge();
		if (!bridge) return bridgeNotConfigured();

		const procedureName = params.procedureName.trim();
		if (procedureName.length === 0) {
			return {
				success: false,
				message: "Procedure name is required",
				error: "TRPC_PROCEDURE_NAME_REQUIRED",
			};
		}

		try {
			let input =
				typeof params.input !== "undefined"
					? params.input
					: typeof params.params !== "undefined"
						? params.params
						: undefined;

			if (typeof input === "string") {
				const trimmed = input.trim();
				if (
					(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
					(trimmed.startsWith("[") && trimmed.endsWith("]"))
				) {
					try {
						input = JSON.parse(trimmed);
					} catch {
						// Ignore parse failures and forward raw string input.
					}
				}
			}

			if (typeof input === "undefined") {
				try {
					const desc = await bridge.describeProcedure(procedureName);
					if (desc.inputExample !== null) {
						const requiredFields = (desc.fields ?? [])
							.filter((f) => f.required)
							.map((f) => f.name);

						if (desc.type === "query" && requiredFields.length === 0) {
							input = {};
						} else {
							return {
								success: false,
								message: `tRPC procedure "${procedureName}" requires an input object`,
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
				} catch {
					// Fallback to calling the procedure; it will return the underlying error message.
				}
			}

			const result = await bridge.callProcedure({
				procedureName,
				input,
				ctx: {
					organizationId: ctx.organizationId,
					userId: ctx.userId,
				},
			});

			if (
				result &&
				typeof result === "object" &&
				(result as { type?: unknown }).type === "subscription"
			) {
				const sub = result as {
					events?: unknown[];
					truncated?: boolean;
					truncatedReason?: string;
				};
				const count = Array.isArray(sub.events) ? sub.events.length : 0;
				const truncatedInfo = sub.truncated
					? ` (truncated: ${sub.truncatedReason ?? "limit"})`
					: "";
				return {
					success: true,
					message: `tRPC subscription "${procedureName}" completed. Collected ${count} event(s)${truncatedInfo}.`,
					data: result,
				};
			}

			return {
				success: true,
				message: `tRPC procedure "${procedureName}" executed`,
				data: result,
			};
		} catch (error) {
			const isSubscriptionError =
				error instanceof TrpcBridgeSubscriptionError ||
				(!!error &&
					typeof error === "object" &&
					(error as { name?: unknown }).name === "TrpcBridgeSubscriptionError" &&
					Array.isArray((error as { events?: unknown }).events));

			if (isSubscriptionError) {
				const events = Array.isArray((error as { events?: unknown }).events)
					? (error as { events: unknown[] }).events
					: [];
				return {
					success: false,
					message: `tRPC procedure "${procedureName}" failed`,
					error: error instanceof Error ? error.message : String(error),
					data: {
						type: "subscription",
						events,
					},
				};
			}

			return {
				success: false,
				message: `tRPC procedure "${procedureName}" failed`,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

export function registerTrpcTools() {
	toolRegistry.register(trpcRouterList);
	toolRegistry.register(trpcProcedureSearch);
	toolRegistry.register(trpcProcedureSuggest);
	toolRegistry.register(trpcProcedureDescribe);
	toolRegistry.register(trpcProcedureCall);
}
