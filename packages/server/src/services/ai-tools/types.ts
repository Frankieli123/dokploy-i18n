import type { z } from "zod";

export type RiskLevel = "low" | "medium" | "high";

export interface ToolContext {
	organizationId: string;
	userId: string;
	projectId?: string;
	serverId?: string;
}

export interface ToolResult<T = unknown> {
	success: boolean;
	message: string;
	data?: T;
	error?: string;
}

export interface Tool<TParams = unknown, TResult = unknown> {
	name: string;
	description: string;
	category: string;
	aliases?: string[];
	tags?: string[];
	parameters: z.ZodType<TParams>;
	riskLevel: RiskLevel;
	requiresApproval: boolean;
	execute: (params: TParams, ctx: ToolContext) => Promise<ToolResult<TResult>>;
}

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}
