"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/utils/api";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortLikeError(error: unknown): boolean {
	if (!error) return false;
	const maybe = error as { name?: unknown; message?: unknown };
	const name = typeof maybe.name === "string" ? maybe.name : "";
	if (name === "AbortError") return true;
	const message = typeof maybe.message === "string" ? maybe.message : "";
	const normalized = message.trim().toLowerCase();
	if (normalized === "aborted") return true;
	if (normalized.includes("bodystreambuffer") && normalized.includes("aborted")) {
		return true;
	}
	return false;
}

function getExecutionIdFromResultPayload(
	payloadResult: Record<string, unknown>,
): string | undefined {
	const direct = payloadResult.executionId;
	if (typeof direct === "string" && direct.trim().length > 0) {
		return direct.trim();
	}
	const nested = payloadResult.data;
	if (isRecord(nested)) {
		const v = nested.executionId;
		if (typeof v === "string" && v.trim().length > 0) {
			return v.trim();
		}
	}
	return undefined;
}

async function* readSseStream(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			while (true) {
				const lfIndex = buffer.indexOf("\n\n");
				const crlfIndex = buffer.indexOf("\r\n\r\n");
				const useCrlf =
					crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex);
				const splitIndex = useCrlf ? crlfIndex : lfIndex;
				if (splitIndex === -1) break;

				const raw = buffer.slice(0, splitIndex);
				buffer = buffer.slice(splitIndex + (useCrlf ? 4 : 2));

				const lines = raw.split(/\r?\n/);
				let event = "message";
				const dataLines: string[] = [];

				for (const line of lines) {
					if (line.startsWith("event:")) event = line.slice(6).trim();
					if (line.startsWith("data:"))
						dataLines.push(line.slice(5).trimStart());
				}

				const data = dataLines.join("\n");
				if (data.length === 0) continue;
				yield { event, data };
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

export interface ToolCall {
	id: string;
	type: "function";
	status?:
		| "pending"
		| "approved"
		| "rejected"
		| "executing"
		| "completed"
		| "failed";
	executionId?: string;
	result?: {
		success: boolean;
		message?: string;
		data?: unknown;
		error?: string;
	};
	function: {
		name: string;
		arguments: string;
	};
}

const TOOL_CALL_STATUS_RANK: Record<NonNullable<ToolCall["status"]>, number> = {
	pending: 1,
	approved: 2,
	executing: 3,
	completed: 4,
	failed: 4,
	rejected: 4,
};

function getToolCallStatusRank(status: ToolCall["status"] | undefined): number {
	if (!status) return 0;
	return TOOL_CALL_STATUS_RANK[status] ?? 0;
}

export interface Message {
	messageId: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string | null;
	reasoning?: string | null;
	attachments?: Array<{
		type: "image";
		data: string;
		mediaType: string;
		name?: string;
		size?: number;
	}> | null;
	toolCalls?: ToolCall[] | null;
	createdAt: string;
	status?: "sending" | "sent" | "error";
	error?: string;
}

export type ToolOutcome = {
	toolCallId: string;
	toolName: string;
	executionId: string;
	status: "completed" | "failed" | "rejected";
	message?: string;
	error?: string;
};

export interface UseChatOptions {
	conversationId?: string;
	aiId?: string;
	projectId?: string;
	serverId?: string;
	onError?: (error: Error) => void;
	enabled?: boolean;
	autoLoad?: boolean;
	uiVisible?: boolean;
}

export interface PendingApproval {
	executionId: string;
	toolName: string;
	runId?: string;
	parametersPreview?: string;
}

export function useChat(options: UseChatOptions = {}) {
	const utils = api.useUtils();
	const [conversationId, setConversationId] = useState<string | undefined>(
		options.conversationId,
	);
	const [pendingMessages, setPendingMessages] = useState<Message[]>([]);
	const [toolOutcomes, setToolOutcomes] = useState<ToolOutcome[]>([]);
	const [toolCallMeta, setToolCallMeta] = useState<
		Record<string, Pick<ToolCall, "status" | "executionId" | "result">>
	>({});
	const [areToolApprovalsDisabled, setAreToolApprovalsDisabled] =
		useState(false);
	const hasUserSetToolApprovalsDisabledRef = useRef(false);
	const [toolBudgetMode, setToolBudgetModeState] = useState<"standard" | "max">(
		"max",
	);
	const hasUserSetToolBudgetModeRef = useRef(false);
	const [canContinueChat, setCanContinueChat] = useState(false);
	const inFlightApprovalExecutionIdsRef = useRef<Set<string>>(new Set());
	const [isLoading, setIsLoading] = useState(false);
	const [abortController, setAbortController] =
		useState<AbortController | null>(null);
	const [pendingApproval, setPendingApproval] =
		useState<PendingApproval | null>(null);
	const approveExecution = api.ai.agent.approve.useMutation();
	const executeExecution = api.ai.agent.execute.useMutation();
	const setToolApprovalsDisabledMutation =
		api.ai.conversations.setToolApprovalsDisabled.useMutation();
	const setToolBudgetModeMutation =
		api.ai.conversations.setToolBudgetMode.useMutation();

	const maybeInvalidateProjectQueries = useCallback(
		(toolName: string, rawResult: unknown, toolArguments?: string) => {
			const result = isRecord(rawResult) ? rawResult : undefined;
			if (!result) return;
			if (result.status === "pending_approval") return;
			if (typeof result.success !== "boolean" || !result.success) return;

			if (
				toolName === "project_create" ||
				toolName === "project_update" ||
				toolName === "project_delete"
			) {
				void utils.project.all.invalidate();

				const data = result.data;
				const projectId =
					isRecord(data) && typeof data.projectId === "string"
						? data.projectId
						: "";
				if (projectId.trim().length > 0) {
					void utils.project.one.invalidate({ projectId });
				}
				return;
			}

			if (toolName === "trpc_procedure_call" && toolArguments) {
				try {
					const args = JSON.parse(toolArguments);
					if (isRecord(args) && typeof args.procedureName === "string") {
						const proc = args.procedureName;
						if (
							["project.create", "project.update", "project.remove"].includes(
								proc,
							)
						) {
							void utils.project.all.invalidate();
						}
					}
				} catch {}
			}
		},
		[utils],
	);

	useEffect(() => {
		return () => {
			abortController?.abort();
		};
	}, [abortController]);

	const isEnabled = options.enabled !== false;
	const uiVisibleRef = useRef<boolean>(options.uiVisible !== false);
	useEffect(() => {
		uiVisibleRef.current = options.uiVisible !== false;
	}, [options.uiVisible]);
	const shouldAutoLoadConversation =
		isEnabled && options.autoLoad === true && !conversationId;

	const { data: autoLoadConversations } = api.ai.conversations.list.useQuery(
		{
			status: "active",
			limit: 1,
			offset: 0,
		},
		{
			enabled: shouldAutoLoadConversation,
			refetchOnWindowFocus: false,
		},
	);

	useEffect(() => {
		if (!shouldAutoLoadConversation) return;
		if (conversationId) return;
		if (!autoLoadConversations || autoLoadConversations.length === 0) return;
		const latest = autoLoadConversations[0];
		if (!latest?.conversationId) return;
		setConversationId(latest.conversationId);
	}, [autoLoadConversations, conversationId, shouldAutoLoadConversation]);

	const createConversation = api.ai.conversations.create.useMutation({
		onSuccess: (data) => {
			setConversationId(data?.conversationId);
		},
	});

	const ensureConversation = useCallback(
		async (aiId: string) => {
			let currentConversationId = conversationId;
			if (currentConversationId) return currentConversationId;

			const newConversation = await createConversation.mutateAsync({
				aiId,
				projectId: options.projectId,
				serverId: options.serverId ?? null,
			});
			if (!newConversation?.conversationId) {
				throw new Error("settings.ai.errors.failedToCreateConversation");
			}
			currentConversationId = newConversation.conversationId;
			setConversationId(currentConversationId);
			return currentConversationId;
		},
		[conversationId, createConversation, options.projectId, options.serverId],
	);

	const { data: serverMessages, refetch: refetchMessages } =
		api.ai.chat.messages.useQuery(
			{ conversationId: conversationId || "" },
			{
				enabled: isEnabled && !!conversationId,
				refetchOnWindowFocus: false,
			},
		);

	useEffect(() => {
		if (!conversationId) return;
		const serverIds = new Set(
			((serverMessages || []) as Message[]).map((m) => m.messageId),
		);
		setPendingMessages((prev) =>
			prev.filter((m) => {
				if (m.status === "sending" || m.status === "error") return true;
				if (m.role !== "assistant") return true;
				return serverIds.has(m.messageId);
			}),
		);
	}, [conversationId, serverMessages]);

	const { data: conversationDetails } = api.ai.conversations.get.useQuery(
		{ conversationId: conversationId || "" },
		{
			enabled: isEnabled && !!conversationId,
			refetchOnWindowFocus: false,
		},
	);

	useEffect(() => {
		if (hasUserSetToolApprovalsDisabledRef.current) return;
		const metadata = conversationDetails?.metadata;
		const disabled =
			isRecord(metadata) && metadata.toolApprovalsDisabled === true;
		setAreToolApprovalsDisabled(disabled);
	}, [conversationDetails?.metadata]);

	useEffect(() => {
		if (hasUserSetToolBudgetModeRef.current) return;
		const metadata = conversationDetails?.metadata;
		const mode =
			isRecord(metadata) && metadata.toolBudgetMode === "standard"
				? "standard"
				: "max";
		setToolBudgetModeState(mode);
	}, [conversationDetails?.metadata]);

	useEffect(() => {
		if (!conversationId) return;
		if (!areToolApprovalsDisabled) return;
		const metadata = conversationDetails?.metadata;
		const alreadyDisabled =
			isRecord(metadata) && metadata.toolApprovalsDisabled === true;
		if (alreadyDisabled) return;
		void setToolApprovalsDisabledMutation
			.mutateAsync({ conversationId, disabled: true })
			.catch(() => {});
	}, [
		areToolApprovalsDisabled,
		conversationDetails?.metadata,
		conversationId,
		setToolApprovalsDisabledMutation,
	]);

	useEffect(() => {
		if (!conversationId) return;
		if (!hasUserSetToolBudgetModeRef.current) return;
		const metadata = conversationDetails?.metadata;
		const serverMode =
			isRecord(metadata) && metadata.toolBudgetMode === "standard"
				? "standard"
				: "max";
		if (serverMode === toolBudgetMode) return;
		void setToolBudgetModeMutation
			.mutateAsync({ conversationId, mode: toolBudgetMode })
			.catch(() => {});
	}, [conversationDetails?.metadata, conversationId, toolBudgetMode, setToolBudgetModeMutation]);

	const executionHydrationTargets = useMemo(() => {
		const toolCalls = ((serverMessages || []) as Message[])
			.flatMap((m) => m.toolCalls || [])
			.filter(
				(tc) => typeof tc.executionId === "string" && tc.executionId.length > 0,
			);

		const toolCallIdsByExecutionId = new Map<string, string[]>();
		const executionIds: string[] = [];
		const seen = new Set<string>();

		for (const tc of toolCalls) {
			const executionId = tc.executionId as string;
			if (!executionId) continue;

			const currentStatus = toolCallMeta[tc.id]?.status ?? tc.status;
			const isTerminal =
				currentStatus === "completed" ||
				currentStatus === "failed" ||
				currentStatus === "rejected";
			if (isTerminal) continue;

			const existing = toolCallIdsByExecutionId.get(executionId) ?? [];
			existing.push(tc.id);
			toolCallIdsByExecutionId.set(executionId, existing);

			if (!seen.has(executionId)) {
				seen.add(executionId);
				executionIds.push(executionId);
				if (executionIds.length >= 50) break;
			}
		}

		return { executionIds, toolCallIdsByExecutionId };
	}, [serverMessages, toolCallMeta]);

	const getExecutions = api.ai.agent.getExecutions.useQuery(
		{ executionIds: executionHydrationTargets.executionIds },
		{
			enabled: isEnabled && executionHydrationTargets.executionIds.length > 0,
			refetchOnWindowFocus: false,
			refetchInterval:
				isEnabled && executionHydrationTargets.executionIds.length > 0
					? 2000
					: false,
		},
	);

	useEffect(() => {
		const data = getExecutions.data as
			| Array<{
					executionId: string;
					status: ToolCall["status"];
					result?: ToolCall["result"];
			  }>
			| undefined;
		if (!data || data.length === 0) return;

		setToolCallMeta((prev) => {
			let changed = false;
			const next = { ...prev };
			for (const exec of data) {
				const toolCallIds =
					executionHydrationTargets.toolCallIdsByExecutionId.get(
						exec.executionId,
					) ?? [];
				for (const toolCallId of toolCallIds) {
					const prevMeta = next[toolCallId];
					const shouldUpdateResult = !prevMeta?.result && exec.result != null;
					const shouldUpdateStatus =
						!prevMeta?.status ||
						getToolCallStatusRank(exec.status) >=
							getToolCallStatusRank(prevMeta.status);
					const shouldUpdateExecutionId =
						prevMeta?.executionId !== exec.executionId;
					if (
						!prevMeta ||
						shouldUpdateStatus ||
						shouldUpdateResult ||
						shouldUpdateExecutionId
					) {
						next[toolCallId] = {
							status: shouldUpdateStatus ? exec.status : prevMeta?.status,
							executionId: exec.executionId,
							result: shouldUpdateResult ? exec.result : prevMeta?.result,
						};
						changed = true;
					}
				}
			}
			return changed ? next : prev;
		});
	}, [getExecutions.data, executionHydrationTargets.toolCallIdsByExecutionId]);

	const messages = useMemo(() => {
		const applyMeta = (msg: Message): Message => {
			if (!msg.toolCalls || msg.toolCalls.length === 0) return msg;
			return {
				...msg,
				toolCalls: msg.toolCalls.map((tc) => ({
					...tc,
					...(toolCallMeta[tc.id] ?? {}),
				})),
			};
		};

		if (!conversationId) {
			return pendingMessages.map(applyMeta);
		}

		const serverRaw = ((serverMessages || []) as Message[]).map(applyMeta);
		const pendingWithMeta = pendingMessages.map(applyMeta);
		const pendingById = new Map(pendingWithMeta.map((m) => [m.messageId, m]));

		const server = serverRaw.map((sm) => {
			const pending = pendingById.get(sm.messageId);
			return pending ? { ...sm, ...pending } : sm;
		});
		const serverIds = new Set(server.map((m) => m.messageId));

		const pendingOnly = pendingWithMeta.filter((pm) => {
			if (serverIds.has(pm.messageId)) return false;
			if (pm.status === "sending") return true;
			return !server.some(
				(sm) =>
					sm.role === pm.role &&
					sm.content === pm.content &&
					JSON.stringify(sm.attachments ?? null) ===
						JSON.stringify(pm.attachments ?? null),
			);
		});

		return [...server, ...pendingOnly];
	}, [conversationId, serverMessages, pendingMessages, toolCallMeta]);

	const approveToolCall = useCallback(
		async (toolCallId: string) => {
			const currentStatus = toolCallMeta[toolCallId]?.status;
			if (
				currentStatus === "approved" ||
				currentStatus === "executing" ||
				currentStatus === "completed" ||
				currentStatus === "failed" ||
				currentStatus === "rejected"
			) {
				return;
			}

			const meta = toolCallMeta[toolCallId];
			const fallbackToolCall = messages
				.flatMap((m) => m.toolCalls || [])
				.find((tc) => tc.id === toolCallId);
			const toolName = fallbackToolCall?.function?.name ?? "";
			let executionId = meta?.executionId;
			if (!executionId) {
				executionId = fallbackToolCall?.executionId;
				if (!executionId) {
					const nested = fallbackToolCall?.result?.data;
					if (isRecord(nested)) {
						const v = nested.executionId;
						if (typeof v === "string" && v.trim().length > 0) {
							executionId = v.trim();
						}
					}
				}
			}
			if (!executionId) return;
			if (inFlightApprovalExecutionIdsRef.current.has(executionId)) return;
			inFlightApprovalExecutionIdsRef.current.add(executionId);

			type NormalizedToolResult = NonNullable<ToolCall["result"]>;

			try {
				if (
					conversationId &&
					!areToolApprovalsDisabled &&
					!hasUserSetToolApprovalsDisabledRef.current
				) {
					hasUserSetToolApprovalsDisabledRef.current = true;
					setAreToolApprovalsDisabled(true);
					void setToolApprovalsDisabledMutation
						.mutateAsync({ conversationId, disabled: true })
						.catch(() => {});
				}

				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: { ...(prev[toolCallId] ?? {}), status: "approved" },
				}));
				await approveExecution.mutateAsync({ executionId, approved: true });

				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: { ...(prev[toolCallId] ?? {}), status: "executing" },
				}));
				const execResult = await executeExecution.mutateAsync({
					executionId,
					conversationId,
				});
				const normalizedResult: NormalizedToolResult = (() => {
					if (isRecord(execResult) && typeof execResult.success === "boolean") {
						return {
							success: execResult.success,
							message:
								typeof execResult.message === "string"
									? execResult.message
									: undefined,
							data: execResult.data,
							error:
								typeof execResult.error === "string"
									? execResult.error
									: undefined,
						};
					}
					return { success: true, data: execResult };
				})();

				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: {
						...(prev[toolCallId] ?? {}),
						status: normalizedResult.success ? "completed" : "failed",
						result: normalizedResult,
					},
				}));
				const args = fallbackToolCall?.function?.arguments;
				maybeInvalidateProjectQueries(toolName, normalizedResult, args);
				setToolOutcomes((prev) => {
					const outcome: ToolOutcome = {
						toolCallId,
						toolName,
						executionId,
						status: normalizedResult.success ? "completed" : "failed",
						message: normalizedResult.message,
						error: normalizedResult.error,
					};
					const next = [...prev, outcome];
					return next.length > 50 ? next.slice(next.length - 50) : next;
				});
				await refetchMessages().catch(() => {});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: {
						...(prev[toolCallId] ?? {}),
						status: "failed",
						result: { success: false, error: message },
					},
				}));
				setToolOutcomes((prev) => {
					if (!executionId) return prev;
					const outcome: ToolOutcome = {
						toolCallId,
						toolName,
						executionId,
						status: "failed",
						error: message,
					};
					const next = [...prev, outcome];
					return next.length > 50 ? next.slice(next.length - 50) : next;
				});
				options.onError?.(error as Error);
			} finally {
				inFlightApprovalExecutionIdsRef.current.delete(executionId);
			}
		},
		[
			approveExecution,
			executeExecution,
			conversationId,
			areToolApprovalsDisabled,
			setToolApprovalsDisabledMutation,
			maybeInvalidateProjectQueries,
			messages,
			refetchMessages,
			toolCallMeta,
			options,
		],
	);

	const rejectToolCall = useCallback(
		async (toolCallId: string) => {
			const currentStatus = toolCallMeta[toolCallId]?.status;
			if (
				currentStatus === "approved" ||
				currentStatus === "executing" ||
				currentStatus === "completed" ||
				currentStatus === "failed" ||
				currentStatus === "rejected"
			) {
				return;
			}

			const meta = toolCallMeta[toolCallId];
			const fallbackToolCall = messages
				.flatMap((m) => m.toolCalls || [])
				.find((tc) => tc.id === toolCallId);
			const toolName = fallbackToolCall?.function?.name ?? "";
			let executionId = meta?.executionId;
			if (!executionId) {
				executionId = fallbackToolCall?.executionId;
				if (!executionId) {
					const nested = fallbackToolCall?.result?.data;
					if (isRecord(nested)) {
						const v = nested.executionId;
						if (typeof v === "string" && v.trim().length > 0) {
							executionId = v.trim();
						}
					}
				}
			}
			if (!executionId) return;
			if (inFlightApprovalExecutionIdsRef.current.has(executionId)) return;
			inFlightApprovalExecutionIdsRef.current.add(executionId);

			try {
				await approveExecution.mutateAsync({ executionId, approved: false });
				setToolCallMeta((prev) => ({
					...prev,
					[toolCallId]: {
						...(prev[toolCallId] ?? {}),
						status: "rejected",
						result: { success: false, message: "Rejected" },
					},
				}));
				setToolOutcomes((prev) => {
					const outcome: ToolOutcome = {
						toolCallId,
						toolName,
						executionId,
						status: "rejected",
						message: "Rejected",
					};
					const next = [...prev, outcome];
					return next.length > 50 ? next.slice(next.length - 50) : next;
				});
				await refetchMessages().catch(() => {});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setToolOutcomes((prev) => {
					if (!executionId) return prev;
					const outcome: ToolOutcome = {
						toolCallId,
						toolName,
						executionId,
						status: "failed",
						error: message,
					};
					const next = [...prev, outcome];
					return next.length > 50 ? next.slice(next.length - 50) : next;
				});
				options.onError?.(error as Error);
			} finally {
				inFlightApprovalExecutionIdsRef.current.delete(executionId);
			}
		},
		[approveExecution, refetchMessages, toolCallMeta, options, messages],
	);

	const approvePending = useCallback(async () => {
		const executionId = pendingApproval?.executionId?.trim() ?? "";
		if (executionId.length === 0) return;
		if (inFlightApprovalExecutionIdsRef.current.has(executionId)) return;
		inFlightApprovalExecutionIdsRef.current.add(executionId);
		try {
			await approveExecution.mutateAsync({ executionId, approved: true });
			setPendingApproval(null);
		} catch (error) {
			options.onError?.(error as Error);
		} finally {
			inFlightApprovalExecutionIdsRef.current.delete(executionId);
		}
	}, [approveExecution, options, pendingApproval]);

	const rejectPending = useCallback(async () => {
		const executionId = pendingApproval?.executionId?.trim() ?? "";
		if (executionId.length === 0) return;
		if (inFlightApprovalExecutionIdsRef.current.has(executionId)) return;
		inFlightApprovalExecutionIdsRef.current.add(executionId);
		try {
			await approveExecution.mutateAsync({ executionId, approved: false });
			setPendingApproval(null);
		} catch (error) {
			options.onError?.(error as Error);
		} finally {
			inFlightApprovalExecutionIdsRef.current.delete(executionId);
		}
	}, [approveExecution, options, pendingApproval]);

	const stopGeneration = useCallback(() => {
		abortController?.abort();
		setAbortController(null);
		setIsLoading(false);
	}, [abortController]);

	const setToolApprovalsDisabled = useCallback(
		async (disabled: boolean) => {
			hasUserSetToolApprovalsDisabledRef.current = true;
			setAreToolApprovalsDisabled(disabled);
			if (!conversationId) return;
			try {
				await setToolApprovalsDisabledMutation.mutateAsync({
					conversationId,
					disabled,
				});
			} catch (error) {
				setAreToolApprovalsDisabled(!disabled);
				options.onError?.(error as Error);
			}
		},
		[
			conversationId,
			options,
			setToolApprovalsDisabledMutation,
			setAreToolApprovalsDisabled,
		],
	);

	const setToolBudgetMode = useCallback(
		async (mode: "standard" | "max") => {
			hasUserSetToolBudgetModeRef.current = true;
			const previousMode = toolBudgetMode;
			setToolBudgetModeState(mode);
			if (!conversationId) return;
			try {
				await setToolBudgetModeMutation.mutateAsync({
					conversationId,
					mode,
				});
			} catch (error) {
				setToolBudgetModeState(previousMode);
				options.onError?.(error as Error);
			}
		},
		[conversationId, options, setToolBudgetModeMutation, toolBudgetMode],
	);

	const send = useCallback(
		async (
			content: string,
			aiId: string,
			isAgentMode = false,
			attachments: NonNullable<Message["attachments"]> = [],
		) => {
			if (!content.trim() && attachments.length === 0) return;

			setIsLoading(true);
			setCanContinueChat(false);

			const timestamp = Date.now();
			const userTempId = `temp-${timestamp}-user`;
			const assistantTempId = `temp-${timestamp}-assistant`;

			const userMessage: Message = {
				messageId: userTempId,
				role: "user",
				content,
				attachments: attachments.length > 0 ? attachments : undefined,
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			const assistantMessage: Message = {
				messageId: assistantTempId,
				role: "assistant",
				content: "",
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			setPendingMessages((prev) => [...prev, userMessage, assistantMessage]);

			const finalizeExecutingToolCalls = (errorMsg: string) => {
				setPendingMessages((prev) =>
					prev.map((m) => {
						if (m.messageId !== assistantTempId) return m;
						const toolCalls = (m.toolCalls || []).map((tc) => {
							if (tc.status !== "executing") return tc;
							return {
								...tc,
								status: "failed" as const,
								result: tc.result ?? {
									success: false,
									message: errorMsg,
									error: errorMsg,
								},
							};
						});
						return { ...m, toolCalls };
					}),
				);
				setToolCallMeta((prev) => {
					const next: typeof prev = { ...prev };
					for (const [toolCallId, meta] of Object.entries(prev)) {
						if (meta.status !== "executing") continue;
						next[toolCallId] = {
							...meta,
							status: "failed",
							result: meta.result ?? {
								success: false,
								message: errorMsg,
								error: errorMsg,
							},
						};
					}
					return next;
				});
			};

			let currentConversationId = conversationId;
			if (!currentConversationId) {
				try {
					currentConversationId = await ensureConversation(aiId);
				} catch (error) {
					const errorMsg =
						error instanceof Error
							? error.message
							: "settings.ai.errors.failedToCreateConversation";
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setIsLoading(false);
					options.onError?.(error as Error);
					return;
				}
			}

			let abortedBySafetyTimer = false;

			if (isAgentMode) {
				let stopReason: "done" | "waiting_approval" | "aborted" = "aborted";
				try {
					const controller = new AbortController();
					setAbortController(controller);

					const response = await fetch("/api/ai/agent/stream", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Accept: "text/event-stream",
						},
						body: JSON.stringify({
							conversationId: currentConversationId,
							goal: content,
							aiId,
							attachments,
						}),
						signal: controller.signal,
					});

					if (!response.ok) {
						const errorText = await response.text().catch(() => "");
						throw new Error(errorText || `Request failed (${response.status})`);
					}

					if (!response.body) {
						throw new Error("settings.ai.errors.streamingResponseNotAvailable");
					}

					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);

					const deltaBufferRef = { current: "" as string };
					let flushDeltaTimer: ReturnType<typeof setTimeout> | null = null;
					const FLUSH_MS = 80;

					const flushDeltaNow = () => {
						if (flushDeltaTimer) {
							clearTimeout(flushDeltaTimer);
							flushDeltaTimer = null;
						}
						const pending = deltaBufferRef.current;
						if (!pending) return;
						deltaBufferRef.current = "";
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
											content: (m.content ?? "") + pending,
											status: "sending" as const,
										}
									: m,
								),
							);
					};

					const scheduleFlushDelta = () => {
						if (flushDeltaTimer) return;
						flushDeltaTimer = setTimeout(() => {
							flushDeltaNow();
						}, FLUSH_MS);
					};

					const appendAssistantLine = (line: string) => {
						const trimmed = typeof line === "string" ? line.trim() : "";
						if (!trimmed) return;
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
											content: (() => {
												const existing = m.content ?? "";
												if (existing.length > 0 && !existing.endsWith("\n")) {
													return `${existing}\n${trimmed}\n`;
												}
												return `${existing}${trimmed}\n`;
											})(),
											status: "sending" as const,
										}
									: m,
							),
						);
					};

					for await (const evt of readSseStream(response.body)) {
						if (controller.signal.aborted) break;

						if (evt.event === "done") {
							flushDeltaNow();
							stopReason = "done";
							break;
						}
						if (evt.event === "error" || evt.event === "stream-error") {
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								message?: string;
								error?: string;
							};
							throw new Error(
								payload.message ||
									payload.error ||
									"settings.ai.errors.streamingError",
							);
						}

						const payload = (() => {
							try {
								const outer = JSON.parse(evt.data) as unknown;
								if (!isRecord(outer)) return null;
								const inner = outer.payload;
								return isRecord(inner) ? inner : null;
							} catch {
								return null;
							}
						})();

						if (evt.event === "agent.output.delta") {
							const delta =
								payload && typeof payload.delta === "string"
									? payload.delta
									: "";
							if (delta.length === 0) continue;
							deltaBufferRef.current += delta;
							scheduleFlushDelta();
							continue;
						}

						if (evt.event === "agent.output.reasoning") {
							const text =
								payload && typeof payload.text === "string" ? payload.text : "";
							if (text.length === 0) continue;
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === assistantTempId
										? { ...m, reasoning: text, status: "sending" as const }
										: m,
								),
							);
							continue;
						}

						if (evt.event === "agent.step.result") {
							flushDeltaNow();
							const toolName =
								payload && typeof payload.toolName === "string"
									? payload.toolName
									: "tool";
							const success =
								payload && typeof payload.success === "boolean"
									? payload.success
									: false;
							const summary =
								payload && typeof payload.summary === "string"
									? payload.summary
									: "";
							appendAssistantLine(
								`[${toolName}] ${success ? "OK" : "FAILED"}${summary ? `: ${summary}` : ""}`,
							);
							continue;
						}

						if (evt.event === "agent.step.wait_approval") {
							flushDeltaNow();
							const toolName =
								payload && typeof payload.toolName === "string"
									? payload.toolName
									: "";
							const executionId =
								payload && typeof payload.executionId === "string"
									? payload.executionId
									: "";
							const runId =
								payload && typeof payload.runId === "string"
									? payload.runId
									: "";
							const parametersPreview =
								payload && typeof payload.parametersPreview === "string"
									? payload.parametersPreview
									: undefined;
							appendAssistantLine(
								toolName
									? `Waiting for approval: ${toolName}`
									: "Waiting for approval",
							);
							if (executionId.trim().length > 0) {
								setPendingApproval({
									executionId: executionId.trim(),
									toolName,
									runId: runId.trim().length > 0 ? runId.trim() : undefined,
									parametersPreview,
								});
							}
							continue;
						}
					}

					flushDeltaNow();
					if (flushDeltaTimer) {
						clearTimeout(flushDeltaTimer);
						flushDeltaTimer = null;
					}
				} catch (error) {
					setAbortController(null);
					if (isAbortLikeError(error)) {
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === userTempId || m.messageId === assistantTempId
									? { ...m, status: "sent" as const }
									: m,
							),
						);
						setIsLoading(false);
						return;
					}

					const errorMsg =
						error instanceof Error
							? error.message
							: "settings.ai.errors.unknownError";
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setIsLoading(false);
					options.onError?.(error as Error);
					return;
				}

				if (stopReason !== "done") {
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
					setIsLoading(false);
					setAbortController(null);
					return;
				}

				try {
					const refetchPromise = refetchMessages().catch(() => {});
					await Promise.race([
						refetchPromise,
						new Promise((resolve) => setTimeout(resolve, 10000)),
					]);
				} finally {
					setPendingMessages((prev) =>
						prev.filter(
							(m) =>
								m.messageId !== userTempId && m.messageId !== assistantTempId,
						),
					);
					setIsLoading(false);
					setAbortController(null);
				}
				return;
			}

			try {
				const controller = new AbortController();
				setAbortController(controller);

				const response = await fetch("/api/ai/stream", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					},
					body: JSON.stringify({
						conversationId: currentConversationId,
						message: content,
						aiId,
						attachments,
					}),
					signal: controller.signal,
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new Error(errorText || `Request failed (${response.status})`);
				}

				if (!response.body) {
					throw new Error("settings.ai.errors.streamingResponseNotAvailable");
				}

				setPendingMessages((prev) =>
					prev.map((m) =>
						m.messageId === userTempId ? { ...m, status: "sent" as const } : m,
					),
				);

				let receivedDone = false;
					const activeToolCallIds = new Set<string>();
					const toolCallArgsById = new Map<string, string>();
					const streamStartTime = Date.now();
					let lastEventTime = streamStartTime;
					const deltaBufferRef = { current: "" as string };
					const reasoningBufferRef = { current: "" as string };
					let reasoningText = "";
					let flushDeltaTimer: ReturnType<typeof setTimeout> | null = null;
					const FLUSH_VISIBLE_MS = 60;
				const FLUSH_HIDDEN_MS = 600;

				const flushDeltaNow = () => {
					if (flushDeltaTimer) {
						clearTimeout(flushDeltaTimer);
						flushDeltaTimer = null;
					}
					const pendingText = deltaBufferRef.current;
						if (pendingText) {
							deltaBufferRef.current = "";
							setPendingMessages((prev) =>
								prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
											content: (m.content ?? "") + pendingText,
											status: "sending" as const,
										}
									: m,
								),
							);
						}

					const pendingReasoning = reasoningBufferRef.current;
					if (pendingReasoning) {
						reasoningBufferRef.current = "";
						reasoningText += pendingReasoning;
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? { ...m, reasoning: reasoningText, status: "sending" as const }
									: m,
							),
						);
					}
				};

				const scheduleFlushDelta = () => {
					const delay = uiVisibleRef.current
						? FLUSH_VISIBLE_MS
						: FLUSH_HIDDEN_MS;
					if (flushDeltaTimer) {
						if (!uiVisibleRef.current) return;
						clearTimeout(flushDeltaTimer);
						flushDeltaTimer = null;
					}
					flushDeltaTimer = setTimeout(() => {
						flushDeltaNow();
					}, delay);
				};

				const IDLE_NO_TOOLS_MS = 30 * 1000;
				const IDLE_WITH_TOOLS_MS = 10 * 60 * 1000;
				const MAX_DURATION_MS = 15 * 60 * 1000;

				const safetyInterval = setInterval(() => {
					const now = Date.now();
					const idleMs = now - lastEventTime;
					const idleLimit =
						activeToolCallIds.size > 0 ? IDLE_WITH_TOOLS_MS : IDLE_NO_TOOLS_MS;
					if (idleMs <= idleLimit && now - streamStartTime <= MAX_DURATION_MS) {
						return;
					}
					abortedBySafetyTimer = true;
					clearInterval(safetyInterval);
					controller.abort();
				}, 1000);

				try {
					for await (const evt of readSseStream(response.body)) {
						if (controller.signal.aborted) break;
						if (
							evt.event === "delta" ||
							evt.event === "reasoning-delta" ||
							evt.event === "tool-call" ||
							evt.event === "tool-result" ||
							evt.event === "done" ||
							evt.event === "error" ||
							evt.event === "stream-error"
						) {
							lastEventTime = Date.now();
						}

						if (evt.event === "delta") {
							const payload = JSON.parse(evt.data) as { delta?: unknown };
							const delta =
								typeof payload.delta === "string" ? payload.delta : "";
							if (delta.length === 0) continue;
							deltaBufferRef.current += delta;
							scheduleFlushDelta();
						}

						if (evt.event === "reasoning-delta") {
							const payload = JSON.parse(evt.data) as { delta?: unknown };
							const delta =
								typeof payload.delta === "string" ? payload.delta : "";
							if (delta.length === 0) continue;
							reasoningBufferRef.current += delta;
							scheduleFlushDelta();
						}

						if (evt.event === "tool-call") {
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								toolCallId: string;
								toolName: string;
								arguments?: unknown;
							};
							activeToolCallIds.add(payload.toolCallId);
							const marker = `\n\n<<tool:${payload.toolCallId}>>\n\n`;
							const argsString =
								typeof payload.arguments === "string"
									? payload.arguments
									: JSON.stringify(payload.arguments ?? {});
							toolCallArgsById.set(payload.toolCallId, argsString);
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === assistantTempId
										? {
												...m,
												content: (m.content ?? "") + marker,
												toolCalls: [
													...(m.toolCalls || []),
													{
														id: payload.toolCallId,
														type: "function" as const,
														status: "executing" as const,
														function: {
															name: payload.toolName,
															arguments: argsString,
														},
													},
												],
											}
										: m,
								),
							);
							setToolCallMeta((prev) => {
								if (prev[payload.toolCallId]?.status) return prev;
								return {
									...prev,
									[payload.toolCallId]: {
										...(prev[payload.toolCallId] ?? {}),
										status: "executing",
									},
								};
							});
						}

						if (evt.event === "tool-result") {
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								toolCallId: string;
								toolName: string;
								result?: unknown;
							};
							activeToolCallIds.delete(payload.toolCallId);
							try {
								const args = toolCallArgsById.get(payload.toolCallId);
								toolCallArgsById.delete(payload.toolCallId);
								maybeInvalidateProjectQueries(
									payload.toolName,
									payload.result,
									args,
								);
							} catch {}

							setPendingMessages((prev) =>
								prev.map((m) => {
									if (m.messageId !== assistantTempId) return m;
									const toolCalls = [...(m.toolCalls || [])];
									const existingIndex = toolCalls.findIndex(
										(tc) => tc.id === payload.toolCallId,
									);

									const existingToolCall =
										existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
									const base: ToolCall = existingToolCall ?? {
										id: payload.toolCallId,
										type: "function" as const,
										function: { name: payload.toolName, arguments: "{}" },
									};

									// Determine status and result from payload
									let status: ToolCall["status"] = "completed";
									let executionId: string | undefined;
									let result: ToolCall["result"] | undefined;

									const payloadResult = isRecord(payload.result)
										? payload.result
										: undefined;
									if (
										payloadResult &&
										payloadResult.status === "pending_approval" &&
										getExecutionIdFromResultPayload(payloadResult)
									) {
										status = "pending";
										executionId =
											getExecutionIdFromResultPayload(payloadResult);
										result = {
											success: true,
											message:
												typeof payloadResult.message === "string"
													? payloadResult.message
													: undefined,
											data: payloadResult.data,
										};
									} else if (
										payloadResult &&
										typeof payloadResult.success === "boolean"
									) {
										status = payloadResult.success ? "completed" : "failed";
										executionId =
											getExecutionIdFromResultPayload(payloadResult);
										result = {
											success: payloadResult.success,
											message: payloadResult.message as string | undefined,
											data: payloadResult.data,
											error: payloadResult.error as string | undefined,
										};
									}

									const updated: ToolCall = {
										...base,
										executionId: executionId ?? base.executionId,
										status,
										result: result ?? base.result,
										function: {
											...base.function,
											name: payload.toolName || base.function.name,
										},
									};

									setToolCallMeta((prev) => ({
										...prev,
										[payload.toolCallId]: {
											status: updated.status,
											executionId: updated.executionId,
											result: updated.result,
										},
									}));

									if (existingIndex >= 0 && existingToolCall) {
										toolCalls[existingIndex] = updated;
									} else {
										toolCalls.push(updated);
									}

									return { ...m, toolCalls };
								}),
							);
						}

						if (evt.event === "done") {
							flushDeltaNow();
							let realId = "";
							try {
								const payload = JSON.parse(evt.data) as {
									needsContinue?: boolean;
									finishReason?: string;
									messageId?: string;
								};
								setCanContinueChat(payload.needsContinue === true);
								realId =
									typeof payload.messageId === "string"
										? payload.messageId.trim()
										: "";
							} catch {}

							receivedDone = true;
							activeToolCallIds.clear();
							finalizeExecutingToolCalls(
								"settings.ai.errors.toolExecutionDidNotReturnResult",
							);
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === userTempId || m.messageId === assistantTempId
										? { ...m, status: "sent" as const }
										: m,
								),
							);
							if (realId) {
								setPendingMessages((prev) =>
									prev.map((m) =>
										m.messageId === assistantTempId
											? { ...m, messageId: realId, status: "sent" as const }
											: m,
									),
								);
							}
							break;
						}

						if (evt.event === "error" || evt.event === "stream-error") {
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								message?: string;
								error?: string;
							};
							throw new Error(
								payload.message ||
									payload.error ||
									"settings.ai.errors.streamingError",
							);
						}
					}
				} finally {
					flushDeltaNow();
					clearInterval(safetyInterval);
				}

				if (controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingEndedWithoutDone"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev
								.filter((m) => m.messageId !== userTempId)
								.map((m) =>
									m.messageId === assistantTempId
										? { ...m, status: "error" as const, error: errorMsg }
										: m,
								),
						);
						setAbortController(null);
						setIsLoading(false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				if (!controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					finalizeExecutingToolCalls(
						"settings.ai.errors.streamingEndedWithoutDone",
					);
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				setAbortController(null);
			} catch (error) {
				setAbortController(null);
				if (isAbortLikeError(error)) {
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingEndedWithoutDone"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev
								.filter((m) => m.messageId !== userTempId)
								.map((m) =>
									m.messageId === assistantTempId
										? { ...m, status: "error" as const, error: errorMsg }
										: m,
								),
						);
						setIsLoading(false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				} else {
					const errorMsg =
						error instanceof Error
							? error.message
							: "settings.ai.errors.unknownError";
					finalizeExecutingToolCalls(errorMsg);
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userTempId || m.messageId === assistantTempId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setIsLoading(false);
					options.onError?.(error as Error);
					return;
				}
			}

			try {
				const refetchPromise = refetchMessages().catch(() => {});
				await Promise.race([
					refetchPromise,
					new Promise((resolve) => setTimeout(resolve, 10000)),
				]);
			} finally {
				setPendingMessages((prev) =>
					prev.filter(
						(m) =>
							m.messageId !== userTempId && m.messageId !== assistantTempId,
					),
				);
				setIsLoading(false);
			}
		},
		[
			conversationId,
			createConversation,
			refetchMessages,
			options.projectId,
			options.serverId,
			options,
			maybeInvalidateProjectQueries,
		],
	);

	const continueChat = useCallback(
		async (aiId: string) => {
			if (!conversationId) return;
			if (isLoading) return;

			setIsLoading(true);
			setCanContinueChat(false);

			const timestamp = Date.now();
			const assistantTempId = `temp-${timestamp}-assistant-continue`;

			const assistantMessage: Message = {
				messageId: assistantTempId,
				role: "assistant",
				content: "",
				reasoning: null,
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			setPendingMessages((prev) => [...prev, assistantMessage]);

			const finalizeExecutingToolCalls = (errorMsg: string) => {
				setPendingMessages((prev) =>
					prev.map((m) => {
						if (m.messageId !== assistantTempId) return m;
						const toolCalls = (m.toolCalls || []).map((tc) => {
							if (tc.status !== "executing") return tc;
							return {
								...tc,
								status: "failed" as const,
								result: {
									success: false,
									error: errorMsg,
								},
							};
						});
						return { ...m, toolCalls };
					}),
				);
			};

			let abortedBySafetyTimer = false;
			try {
				const controller = new AbortController();
				setAbortController(controller);

				const response = await fetch("/api/ai/continue", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					},
					body: JSON.stringify({ conversationId, aiId }),
					signal: controller.signal,
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new Error(errorText || `Request failed (${response.status})`);
				}

				if (!response.body) {
					throw new Error("settings.ai.errors.streamingResponseNotAvailable");
				}

				let receivedDone = false;
				const activeToolCallIds = new Set<string>();
				const toolCallArgsById = new Map<string, string>();
				const streamStartTime = Date.now();
				let lastEventTime = streamStartTime;
				const deltaBufferRef = { current: "" as string };
				const reasoningBufferRef = { current: "" as string };
				let reasoningText = "";
				let flushDeltaTimer: ReturnType<typeof setTimeout> | null = null;
				const FLUSH_VISIBLE_MS = 60;
				const FLUSH_HIDDEN_MS = 600;

				const flushDeltaNow = () => {
					if (flushDeltaTimer) {
						clearTimeout(flushDeltaTimer);
						flushDeltaTimer = null;
					}
					const pendingText = deltaBufferRef.current;
					if (pendingText) {
						deltaBufferRef.current = "";
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
											content: (m.content ?? "") + pendingText,
											status: "sending" as const,
										}
									: m,
							),
						);
					}

					const pendingReasoning = reasoningBufferRef.current;
					if (pendingReasoning) {
						reasoningBufferRef.current = "";
						reasoningText += pendingReasoning;
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? { ...m, reasoning: reasoningText, status: "sending" as const }
									: m,
							),
						);
					}
				};

				const scheduleFlush = () => {
					if (flushDeltaTimer) return;
					const delay = uiVisibleRef.current ? FLUSH_VISIBLE_MS : FLUSH_HIDDEN_MS;
					flushDeltaTimer = setTimeout(flushDeltaNow, delay);
				};

				const safetyInterval = setInterval(() => {
					const now = Date.now();
					const idleMs = now - lastEventTime;
					const maxIdleMs = uiVisibleRef.current ? 45000 : 120000;
					if (idleMs > maxIdleMs && !controller.signal.aborted) {
						abortedBySafetyTimer = true;
						controller.abort();
					}
				}, 2000);

				try {
					for await (const evt of readSseStream(response.body)) {
						if (evt.event === "ping" || evt.event === "start") continue;

						if (
							evt.event === "delta" ||
							evt.event === "reasoning-delta" ||
							evt.event === "tool-call" ||
							evt.event === "tool-result" ||
							evt.event === "done" ||
							evt.event === "error" ||
							evt.event === "stream-error"
						) {
							lastEventTime = Date.now();
						}

						if (evt.event === "delta") {
							const payload = JSON.parse(evt.data) as { delta?: string };
							const delta = typeof payload.delta === "string" ? payload.delta : "";
							if (!delta) continue;
							deltaBufferRef.current += delta;
							scheduleFlush();
							continue;
						}

						if (evt.event === "reasoning-delta") {
							const payload = JSON.parse(evt.data) as { delta?: string };
							const delta = typeof payload.delta === "string" ? payload.delta : "";
							if (!delta) continue;
							reasoningBufferRef.current += delta;
							scheduleFlush();
							continue;
						}

						if (evt.event === "tool-call") {
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								toolCallId: string;
								toolName: string;
								arguments: unknown;
							};
							const argsText = (() => {
								try {
									return JSON.stringify(payload.arguments ?? {}, null, 2);
								} catch {
									return String(payload.arguments ?? "");
								}
							})();
							toolCallArgsById.set(payload.toolCallId, argsText);
							activeToolCallIds.add(payload.toolCallId);

							setPendingMessages((prev) =>
								prev.map((m) => {
									if (m.messageId !== assistantTempId) return m;
									const toolCalls = [...(m.toolCalls || [])];
									const existingIndex = toolCalls.findIndex(
										(tc) => tc.id === payload.toolCallId,
									);
									const base: ToolCall = {
										id: payload.toolCallId,
										type: "function",
										status: "executing",
										function: {
											name: payload.toolName,
											arguments: argsText,
										},
									};

									const merged = { ...base, ...(toolCalls[existingIndex] || {}) };
									if (existingIndex >= 0) toolCalls[existingIndex] = merged;
									else toolCalls.push(merged);
									return { ...m, toolCalls };
								}),
							);
						}

						if (evt.event === "tool-result") {
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								toolCallId: string;
								toolName: string;
								result: unknown;
							};
							activeToolCallIds.delete(payload.toolCallId);

							setPendingMessages((prev) =>
								prev.map((m) => {
									if (m.messageId !== assistantTempId) return m;
									const toolCalls = [...(m.toolCalls || [])];
									const existingIndex = toolCalls.findIndex(
										(tc) => tc.id === payload.toolCallId,
									);
									const existingToolCall =
										existingIndex >= 0 ? toolCalls[existingIndex] : undefined;

									const base: ToolCall =
										existingToolCall ??
										({
											id: payload.toolCallId,
											type: "function",
											function: {
												name: payload.toolName,
												arguments: toolCallArgsById.get(payload.toolCallId) || "{}",
											},
										} as ToolCall);

									let status: ToolCall["status"] = "completed";
									let executionId: string | undefined;
									let result: ToolCall["result"] | undefined;

									const payloadResult = isRecord(payload.result)
										? payload.result
										: undefined;
									if (
										payloadResult &&
										payloadResult.status === "pending_approval" &&
										getExecutionIdFromResultPayload(payloadResult)
									) {
										status = "pending";
										executionId = getExecutionIdFromResultPayload(payloadResult);
										result = {
											success: true,
											message:
												typeof payloadResult.message === "string"
													? payloadResult.message
													: undefined,
											data: payloadResult.data,
										};
									} else if (
										payloadResult &&
										typeof payloadResult.success === "boolean"
									) {
										status = payloadResult.success ? "completed" : "failed";
										executionId = getExecutionIdFromResultPayload(payloadResult);
										result = {
											success: payloadResult.success,
											message: payloadResult.message as string | undefined,
											data: payloadResult.data,
											error: payloadResult.error as string | undefined,
										};
									}

									const updated: ToolCall = {
										...base,
										executionId: executionId ?? base.executionId,
										status,
										result: result ?? base.result,
										function: {
											...base.function,
											name: payload.toolName || base.function.name,
										},
									};

									setToolCallMeta((prev) => ({
										...prev,
										[payload.toolCallId]: {
											status: updated.status,
											executionId: updated.executionId,
											result: updated.result,
										},
									}));

									if (existingIndex >= 0 && existingToolCall) {
										toolCalls[existingIndex] = updated;
									} else {
										toolCalls.push(updated);
									}

									return { ...m, toolCalls };
								}),
							);
						}

						if (evt.event === "done") {
							flushDeltaNow();
							let realId = "";
							try {
								const payload = JSON.parse(evt.data) as {
									needsContinue?: boolean;
									finishReason?: string;
									messageId?: string;
								};
								setCanContinueChat(payload.needsContinue === true);
								realId =
									typeof payload.messageId === "string"
										? payload.messageId.trim()
										: "";
							} catch {}

							receivedDone = true;
							activeToolCallIds.clear();
							finalizeExecutingToolCalls(
								"settings.ai.errors.toolExecutionDidNotReturnResult",
							);
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === assistantTempId
										? { ...m, status: "sent" as const }
										: m,
								),
							);
							if (realId) {
								setPendingMessages((prev) =>
									prev.map((m) =>
										m.messageId === assistantTempId
											? { ...m, messageId: realId, status: "sent" as const }
											: m,
									),
								);
							}
							break;
						}

						if (evt.event === "error" || evt.event === "stream-error") {
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								message?: string;
								error?: string;
							};
							throw new Error(
								payload.message ||
									payload.error ||
									"settings.ai.errors.streamingError",
							);
						}
					}
				} finally {
					flushDeltaNow();
					clearInterval(safetyInterval);
				}

				if (controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingEndedWithoutDone"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? { ...m, status: "error" as const, error: errorMsg }
									: m,
							),
						);
						setAbortController(null);
						setIsLoading(false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				if (!controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					finalizeExecutingToolCalls(
						"settings.ai.errors.streamingEndedWithoutDone",
					);
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				setAbortController(null);
			} catch (error) {
				setAbortController(null);
				if (isAbortLikeError(error)) {
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingEndedWithoutDone"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? { ...m, status: "error" as const, error: errorMsg }
									: m,
							),
						);
						setIsLoading(false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantTempId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				} else {
					const errorMsg =
						error instanceof Error
							? error.message
							: "settings.ai.errors.unknownError";
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantTempId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setIsLoading(false);
					options.onError?.(error as Error);
					return;
				}
			}

			try {
				const refetchPromise = refetchMessages().catch(() => {});
				await Promise.race([
					refetchPromise,
					new Promise((resolve) => setTimeout(resolve, 10000)),
				]);
			} finally {
				setPendingMessages((prev) =>
					prev.filter((m) => m.messageId !== assistantTempId),
				);
				setIsLoading(false);
			}
		},
		[conversationId, isLoading, options, refetchMessages],
	);

	const reset = useCallback(() => {
		abortController?.abort();
		setAbortController(null);
		setIsLoading(false);
		setConversationId(undefined);
		setPendingMessages([]);
		setToolCallMeta({});
		setToolOutcomes([]);
		hasUserSetToolApprovalsDisabledRef.current = false;
		setAreToolApprovalsDisabled(false);
		hasUserSetToolBudgetModeRef.current = false;
		setToolBudgetModeState("max");
		setCanContinueChat(false);
		setPendingApproval(null);
	}, [abortController]);

	const retryMessage = useCallback(
		async (messageId: string, aiId: string, isAgentMode = false) => {
			const message = pendingMessages.find((m) => m.messageId === messageId);
			if (!message) return;
			const content = message.content ?? "";
			const attachments = message.attachments ?? undefined;
			if (!content.trim() && (!attachments || attachments.length === 0)) return;

			setPendingMessages((prev) =>
				prev.filter((m) => m.messageId !== messageId),
			);

			await send(content, aiId, isAgentMode, attachments ?? []);
		},
		[pendingMessages, send],
	);

	const openConversation = useCallback(
		(nextConversationId: string) => {
			const normalized = nextConversationId.trim();
			if (normalized.length === 0) return;

			stopGeneration();
			setPendingMessages([]);
			setToolCallMeta({});
			setToolOutcomes([]);
			hasUserSetToolApprovalsDisabledRef.current = false;
			setAreToolApprovalsDisabled(false);
			hasUserSetToolBudgetModeRef.current = false;
			setToolBudgetModeState("max");
			setCanContinueChat(false);
			setPendingApproval(null);
			setConversationId(normalized);
		},
		[stopGeneration],
	);

	return {
		ensureConversation,
		conversationId,
		messages,
		isLoading,
		areToolApprovalsDisabled,
		setToolApprovalsDisabled,
		toolBudgetMode,
		setToolBudgetMode,
		canContinueChat,
		continueChat,
		toolOutcomes,
		send,
		approveToolCall,
		rejectToolCall,
		pendingApproval,
		approvePending,
		rejectPending,
		reset,
		openConversation,
		retryMessage,
		refetchMessages,
		stopGeneration,
	};
}
