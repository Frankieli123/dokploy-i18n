import { db } from "@dokploy/server/db";
import {
	aiConversations,
	aiMessages,
	aiRuns,
	aiToolExecutions,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import {
	initializeTools,
	type ToolContext,
	type ToolResult,
	toolRegistry,
} from "../../ai-tools";
import {
	callAiMcpTool,
	listAiMcpToolsCached,
	validateAiMcpToolArguments,
} from "../mcp-servers";

const MCP_VIRTUAL_TOOL_PREFIX = "mcp/";

function parseMcpVirtualToolName(
	toolName: string,
): { mcpServerId: string; mcpToolName: string } | null {
	const normalized = String(toolName ?? "").trim();
	if (!normalized.toLowerCase().startsWith(MCP_VIRTUAL_TOOL_PREFIX)) return null;
	const parts = normalized.split("/");
	if (parts.length < 3) return null;
	const mcpServerId = String(parts[1] ?? "").trim();
	const mcpToolName = parts.slice(2).join("/").trim();
	if (!mcpServerId || !mcpToolName) return null;
	return { mcpServerId, mcpToolName };
}

export type AgentOrchestratorState =
	| "IDLE"
	| "PLANNING"
	| "WAIT_APPROVAL"
	| "EXECUTING"
	| "VERIFYING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";

export type AiRunDbStatus =
	| "pending"
	| "planning"
	| "waiting_approval"
	| "executing"
	| "verifying"
	| "completed"
	| "failed"
	| "cancelled";

export type AiToolExecutionDbStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "executing"
	| "completed"
	| "failed";

export type AgentPlanStep = {
	id: string;
	toolName: string;
	description: string;
	parameters: Record<string, unknown>;
	requiresApproval: boolean;
};

export type AgentPlan = {
	steps: AgentPlanStep[];
};

export type OrchestratorOutcome =
	| {
			state: "WAIT_APPROVAL";
			runId: string;
			executionId: string;
			toolName: string;
	  }
	| { state: "EXECUTING"; runId: string }
	| { state: "VERIFYING"; runId: string }
	| { state: "COMPLETED"; runId: string }
	| { state: "FAILED"; runId: string; error: string }
	| { state: "CANCELLED"; runId: string };

function nowIso() {
	return new Date().toISOString();
}

function safeTruncateString(value: string, maxLen: number) {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, maxLen)}\n... (truncated)`;
}

function safeJsonStringify(value: unknown, maxLen: number) {
	try {
		return safeTruncateString(JSON.stringify(value), maxLen);
	} catch {
		return safeTruncateString(String(value), maxLen);
	}
}

async function saveAgentEventMessage(params: {
	conversationId: string;
	payload: Record<string, unknown>;
}) {
	const content = safeJsonStringify(params.payload, 20000);
	await db.insert(aiMessages).values({
		conversationId: params.conversationId,
		role: "system",
		content,
	});
	await db
		.update(aiConversations)
		.set({ updatedAt: nowIso() })
		.where(eq(aiConversations.conversationId, params.conversationId));
}

function mapRunStatusToState(status: AiRunDbStatus): AgentOrchestratorState {
	switch (status) {
		case "pending":
			return "IDLE";
		case "planning":
			return "PLANNING";
		case "waiting_approval":
			return "WAIT_APPROVAL";
		case "executing":
			return "EXECUTING";
		case "verifying":
			return "VERIFYING";
		case "completed":
			return "COMPLETED";
		case "failed":
			return "FAILED";
		case "cancelled":
			return "CANCELLED";
	}
}

const allowedTransitions: Record<AiRunDbStatus, AiRunDbStatus[]> = {
	pending: ["planning", "cancelled", "failed"],
	planning: ["executing", "waiting_approval", "cancelled", "failed"],
	waiting_approval: ["executing", "cancelled", "failed"],
	executing: ["verifying", "waiting_approval", "cancelled", "failed"],
	verifying: ["completed", "cancelled", "failed"],
	completed: [],
	failed: [],
	cancelled: [],
};

function assertValidTransition(from: AiRunDbStatus, to: AiRunDbStatus) {
	if (from === to) return;
	if (!allowedTransitions[from]?.includes(to)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Invalid run status transition: ${from} -> ${to}`,
		});
	}
}

async function updateRun(
	runId: string,
	data: Partial<{
		status: AiRunDbStatus;
		plan: AgentPlan;
		result: { success: boolean; summary: string; data?: unknown };
		error: string;
		startedAt: string;
		completedAt: string;
	}>,
) {
	const [updated] = await db
		.update(aiRuns)
		.set(data)
		.where(eq(aiRuns.runId, runId))
		.returning();
	return updated;
}

async function updateExecution(
	executionId: string,
	data: Partial<{
		status: AiToolExecutionDbStatus;
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
) {
	const [updated] = await db
		.update(aiToolExecutions)
		.set(data)
		.where(eq(aiToolExecutions.executionId, executionId))
		.returning();
	return updated;
}

async function createExecutionForStep(
	runId: string,
	conversationId: string,
	step: AgentPlanStep,
	toolApprovalsDisabled: boolean,
) {
	const t = toolRegistry.get(step.toolName);
	if (!t) {
		const [execution] = await db
			.insert(aiToolExecutions)
			.values({
				executionId: step.id,
				conversationId,
				runId,
				toolName: step.toolName,
				parameters: step.parameters,
				requiresApproval: step.requiresApproval,
				status: "failed",
				error: `Unknown tool: ${step.toolName}`,
				result: {
					success: false,
					message: "Tool not found",
					error: `Unknown tool: ${step.toolName}`,
				},
				completedAt: nowIso(),
				startedAt: undefined,
			})
			.returning();
		if (!execution) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Failed to create tool execution",
			});
		}
		return execution;
	}

	const validation = t.parameters.safeParse(step.parameters || {});
	if (!validation.success) {
		const [execution] = await db
			.insert(aiToolExecutions)
			.values({
				executionId: step.id,
				conversationId,
				runId,
				toolName: step.toolName,
				parameters: step.parameters,
				requiresApproval: step.requiresApproval,
				status: "failed",
				error: validation.error.message,
				result: {
					success: false,
					message: "Invalid parameters",
					error: validation.error.message,
				},
				completedAt: nowIso(),
				startedAt: undefined,
			})
			.returning();
		if (!execution) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "Failed to create tool execution",
			});
		}
		return execution;
	}

	const validatedParams = validation.data as unknown as Record<string, unknown>;
	const initialStatus: AiToolExecutionDbStatus =
		step.requiresApproval && !toolApprovalsDisabled ? "pending" : "approved";

	const [execution] = await db
		.insert(aiToolExecutions)
		.values({
			executionId: step.id,
			conversationId,
			runId,
			toolName: step.toolName,
			parameters: validatedParams,
			requiresApproval: step.requiresApproval,
			status: initialStatus,
			startedAt: undefined,
		})
		.returning();
	if (!execution) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Failed to create tool execution",
		});
	}
	return execution;
}

function isTerminalRunStatus(status: AiRunDbStatus) {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

export async function orchestrateRun(
	runId: string,
	ctx: ToolContext,
	options: { abortSignal?: AbortSignal } = {},
): Promise<OrchestratorOutcome> {
	initializeTools();

	const run = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, runId),
		with: { toolExecutions: true },
	});
	if (!run) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
	}

	const currentStatus = run.status as AiRunDbStatus;
	if (isTerminalRunStatus(currentStatus)) {
		return {
			state: mapRunStatusToState(currentStatus),
			runId,
		} as OrchestratorOutcome;
	}

	const plan = run.plan as AgentPlan | null | undefined;
	if (!plan?.steps || plan.steps.length === 0) {
		await updateRun(runId, {
			status: "failed",
			error: "Run plan is missing or empty",
			completedAt: nowIso(),
		});
		await saveAgentEventMessage({
			conversationId: run.conversationId,
			payload: {
				type: "agent.run.finish",
				runId,
				status: "failed",
			},
		});
		await saveAgentEventMessage({
			conversationId: run.conversationId,
			payload: {
				type: "agent.run.summary",
				runId,
				summary: "Run plan is missing or empty",
			},
		});
		return { state: "FAILED", runId, error: "Run plan is missing or empty" };
	}

	if (options.abortSignal?.aborted) {
		await updateRun(runId, { status: "cancelled", completedAt: nowIso() });
		return { state: "CANCELLED", runId };
	}

	const startStatus: AiRunDbStatus =
		currentStatus === "pending" ? "planning" : currentStatus;

	if (startStatus !== currentStatus) {
		assertValidTransition(currentStatus, startStatus);
		await updateRun(runId, { status: startStatus });
	}

	if (startStatus === "planning" || startStatus === "waiting_approval") {
		assertValidTransition(startStatus, "executing");
		await updateRun(runId, {
			status: "executing",
			startedAt: run.startedAt || nowIso(),
		});
	}

	const conversation = await db.query.aiConversations.findFirst({
		where: eq(aiConversations.conversationId, run.conversationId),
		columns: {
			metadata: true,
		},
	});
	const toolApprovalsDisabled =
		!!conversation?.metadata &&
		typeof conversation.metadata === "object" &&
		!Array.isArray(conversation.metadata) &&
		(conversation.metadata as { toolApprovalsDisabled?: unknown })
			.toolApprovalsDisabled === true;

	const executionsById = new Map<string, (typeof run.toolExecutions)[number]>();
	for (const exec of run.toolExecutions || []) {
		executionsById.set(exec.executionId, exec);
	}

	for (const step of plan.steps) {
		if (options.abortSignal?.aborted) {
			await updateRun(runId, { status: "cancelled", completedAt: nowIso() });
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.finish",
					runId,
					status: "cancelled",
				},
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.summary",
					runId,
					summary: "Cancelled",
				},
			});
			return { state: "CANCELLED", runId };
		}

		const cancelled = await db.query.aiRuns.findFirst({
			where: eq(aiRuns.runId, runId),
		});
		if (cancelled?.status === "cancelled") {
			return { state: "CANCELLED", runId };
		}

		if (!step.id || !step.toolName) {
			await updateRun(runId, {
				status: "failed",
				error: "Invalid plan step: missing id or toolName",
				completedAt: nowIso(),
			});
			return {
				state: "FAILED",
				runId,
				error: "Invalid plan step: missing id or toolName",
			};
		}

		let exec = executionsById.get(step.id);
		if (!exec) {
			exec = await createExecutionForStep(
				runId,
				run.conversationId,
				step,
				toolApprovalsDisabled,
			);
			executionsById.set(exec.executionId, exec);
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.step.start",
					runId,
					stepId: exec.executionId,
					executionId: exec.executionId,
					toolName: exec.toolName,
					description: step.description,
					requiresApproval: exec.requiresApproval,
				},
			});
		}

		let execStatus = exec.status as AiToolExecutionDbStatus;

		if (execStatus === "pending") {
			if (toolApprovalsDisabled) {
				await updateExecution(exec.executionId, {
					status: "approved",
				});
				execStatus = "approved";
			} else {
			assertValidTransition("executing", "waiting_approval");
			await updateRun(runId, { status: "waiting_approval" });
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.step.wait_approval",
					runId,
					stepId: exec.executionId,
					executionId: exec.executionId,
					toolName: exec.toolName,
					parametersPreview:
						exec.parameters != null
							? safeJsonStringify(exec.parameters, 4000)
							: undefined,
				},
			});
			return {
				state: "WAIT_APPROVAL",
				runId,
				executionId: exec.executionId,
				toolName: exec.toolName,
			};
			}
		}

		if (execStatus === "rejected") {
			await updateRun(runId, {
				status: "cancelled",
				error: `Execution rejected: ${exec.executionId}`,
				completedAt: nowIso(),
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.step.result",
					runId,
					stepId: exec.executionId,
					executionId: exec.executionId,
					success: false,
					summary: "Rejected",
				},
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.finish",
					runId,
					status: "cancelled",
				},
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.summary",
					runId,
					summary: `Execution rejected: ${exec.executionId}`,
				},
			});
			return { state: "CANCELLED", runId };
		}

		if (execStatus === "failed") {
			await updateRun(runId, {
				status: "failed",
				error: exec.error || `Execution failed: ${exec.executionId}`,
				completedAt: nowIso(),
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.step.result",
					runId,
					stepId: exec.executionId,
					executionId: exec.executionId,
					success: false,
					summary: exec.error || `Execution failed: ${exec.executionId}`,
				},
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.finish",
					runId,
					status: "failed",
				},
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.summary",
					runId,
					summary: exec.error || `Execution failed: ${exec.executionId}`,
				},
			});
			return {
				state: "FAILED",
				runId,
				error: exec.error || `Execution failed: ${exec.executionId}`,
			};
		}

		if (execStatus === "completed") {
			continue;
		}

		if (execStatus === "executing") {
			return { state: "EXECUTING", runId };
		}

		if (execStatus === "approved") {
			await updateExecution(exec.executionId, {
				status: "executing",
				startedAt: exec.startedAt || nowIso(),
			});

				let result: ToolResult = {
					success: false,
					message: "Tool execution failed",
					error: "TOOL_EXECUTION_FAILED",
				};
				try {
					const mcp = parseMcpVirtualToolName(exec.toolName);
					if (mcp) {
					const args =
						exec.parameters &&
						typeof exec.parameters === "object" &&
						!Array.isArray(exec.parameters)
							? (exec.parameters as Record<string, unknown>)
							: {};
					let validated = true;
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
								validated = false;
								result = {
									success: false,
									message: `Invalid parameters for MCP tool "${mcp.mcpToolName}"`,
									error: validation.errorText
										.replace(/\s*\n\s*/g, "; ")
										.trim(),
									data: {
										mcpServerId: mcp.mcpServerId,
										toolName: mcp.mcpToolName,
										issues: validation.issues,
									},
								};
							}
						}
					} catch {}

					if (validated) {
						const res = await callAiMcpTool({
							organizationId: ctx.organizationId,
							mcpServerId: mcp.mcpServerId,
							toolName: mcp.mcpToolName,
							arguments: args,
						});
						const success = res.isError !== true;
						result = {
							success,
							message: success
								? `MCP tool "${mcp.mcpToolName}" executed`
								: `MCP tool "${mcp.mcpToolName}" returned an error`,
							error: success ? undefined : "MCP_TOOL_ERROR",
							data: {
								mcpServerId: mcp.mcpServerId,
								toolName: mcp.mcpToolName,
								content: res.content,
								structuredContent: res.structuredContent,
								isError: res.isError,
							},
						};
					}
				} else {
					result = (await toolRegistry.execute(
						exec.toolName,
						exec.parameters || {},
						ctx,
					)) as ToolResult;
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				await updateExecution(exec.executionId, {
					status: "failed",
					error: errorMessage,
					completedAt: nowIso(),
				});
				await updateRun(runId, {
					status: "failed",
					error: errorMessage,
					completedAt: nowIso(),
				});
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.step.result",
						runId,
						stepId: exec.executionId,
						executionId: exec.executionId,
						success: false,
						summary: errorMessage,
					},
				});
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.run.finish",
						runId,
						status: "failed",
					},
				});
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.run.summary",
						runId,
						summary: errorMessage,
					},
				});
				return { state: "FAILED", runId, error: errorMessage };
			}

			if (result.success) {
				await updateExecution(exec.executionId, {
					status: "completed",
					result,
					completedAt: nowIso(),
				});
				await saveAgentEventMessage({
					conversationId: run.conversationId,
					payload: {
						type: "agent.step.result",
						runId,
						stepId: exec.executionId,
						executionId: exec.executionId,
						success: true,
						summary: result.message || "Success",
						dataPreview:
							result.data != null
								? safeJsonStringify(result.data, 4000)
								: undefined,
					},
				});
				continue;
			}

			await updateExecution(exec.executionId, {
				status: "failed",
				result,
				error: result.error || result.message,
				completedAt: nowIso(),
			});
			await updateRun(runId, {
				status: "failed",
				error: result.error || result.message,
				completedAt: nowIso(),
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.step.result",
					runId,
					stepId: exec.executionId,
					executionId: exec.executionId,
					success: false,
					summary: result.error || result.message || "Tool execution failed",
				},
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.finish",
					runId,
					status: "failed",
				},
			});
			await saveAgentEventMessage({
				conversationId: run.conversationId,
				payload: {
					type: "agent.run.summary",
					runId,
					summary: result.error || result.message || "Tool execution failed",
				},
			});
			return {
				state: "FAILED",
				runId,
				error: result.error || result.message || "Tool execution failed",
			};
		}
	}

	assertValidTransition("executing", "verifying");
	await updateRun(runId, { status: "verifying" });

	const verifyingRun = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, runId),
	});
	if (verifyingRun?.status === "cancelled") {
		return { state: "CANCELLED", runId };
	}
	if (verifyingRun) {
		assertValidTransition("verifying", "completed");
		await updateRun(runId, {
			status: "completed",
			result: {
				success: true,
				summary: `Completed ${plan.steps.length} step(s)`,
			},
			completedAt: nowIso(),
		});
		await saveAgentEventMessage({
			conversationId: run.conversationId,
			payload: {
				type: "agent.run.finish",
				runId,
				status: "completed",
			},
		});
		await saveAgentEventMessage({
			conversationId: run.conversationId,
			payload: {
				type: "agent.run.summary",
				runId,
				summary: `Completed ${plan.steps.length} step(s)`,
			},
		});
	}

	return { state: "COMPLETED", runId };
}

export async function cancelRun(runId: string): Promise<void> {
	const run = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, runId),
	});
	if (!run) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
	}

	const currentStatus = run.status as AiRunDbStatus;
	if (isTerminalRunStatus(currentStatus)) {
		return;
	}

	await updateRun(runId, {
		status: "cancelled",
		completedAt: nowIso(),
	});
}

export async function approveExecution(executionId: string): Promise<void> {
	const execution = await db.query.aiToolExecutions.findFirst({
		where: eq(aiToolExecutions.executionId, executionId),
	});
	if (!execution) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Execution not found" });
	}

	if (execution.status !== "pending") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Cannot approve execution in status: ${execution.status}`,
		});
	}

	await updateExecution(executionId, {
		status: "approved",
	});
}

export async function rejectExecution(executionId: string): Promise<void> {
	const execution = await db.query.aiToolExecutions.findFirst({
		where: eq(aiToolExecutions.executionId, executionId),
	});
	if (!execution) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Execution not found" });
	}

	if (execution.status !== "pending") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Cannot reject execution in status: ${execution.status}`,
		});
	}

	await updateExecution(executionId, {
		status: "rejected",
		completedAt: nowIso(),
	});
}

export async function getRunStatus(runId: string): Promise<{
	state: AgentOrchestratorState;
	run: Awaited<ReturnType<typeof db.query.aiRuns.findFirst>>;
}> {
	const run = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, runId),
		with: { toolExecutions: true },
	});
	if (!run) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
	}

	return {
		state: mapRunStatusToState(run.status as AiRunDbStatus),
		run,
	};
}
