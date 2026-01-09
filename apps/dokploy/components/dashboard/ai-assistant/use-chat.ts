"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/utils/api";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
				if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
			}

			const data = dataLines.join("\n");
			if (data.length === 0) continue;
			yield { event, data };
		}
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
}

export function useChat(options: UseChatOptions = {}) {
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
	const inFlightApprovalExecutionIdsRef = useRef<Set<string>>(new Set());
	const [isLoading, setIsLoading] = useState(false);
	const [abortController, setAbortController] =
		useState<AbortController | null>(null);
	const approveExecution = api.ai.agent.approve.useMutation();
	const executeExecution = api.ai.agent.execute.useMutation();
	const setToolApprovalsDisabledMutation =
		api.ai.conversations.setToolApprovalsDisabled.useMutation();

	useEffect(() => {
		return () => {
			abortController?.abort();
		};
	}, [abortController]);

	const isEnabled = options.enabled !== false;
	const shouldAutoLoadConversation =
		isEnabled && options.autoLoad === true && !conversationId;

	const { data: autoLoadConversations } = api.ai.conversations.list.useQuery(
		{
			projectId: options.projectId,
			serverId: options.serverId ?? null,
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
		const disabled = isRecord(metadata) && metadata.toolApprovalsDisabled === true;
		setAreToolApprovalsDisabled(disabled);
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
			enabled: executionHydrationTargets.executionIds.length > 0,
			refetchOnWindowFocus: false,
			refetchInterval:
				executionHydrationTargets.executionIds.length > 0 ? 2000 : false,
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

		const server = ((serverMessages || []) as Message[]).map(applyMeta);
		const pendingOnly = pendingMessages
			.filter((pm) => {
				if (pm.status === "sending") return true;
				return !server.some(
					(sm) => sm.content === pm.content && sm.role === pm.role,
				);
			})
			.map(applyMeta);
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

			hasUserSetToolApprovalsDisabledRef.current = true;
			setAreToolApprovalsDisabled(true);
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

	const send = useCallback(
		async (content: string, aiId: string) => {
			if (!content.trim()) return;

			setIsLoading(true);

			const timestamp = Date.now();
			const userTempId = `temp-${timestamp}-user`;
			const assistantTempId = `temp-${timestamp}-assistant`;

			const userMessage: Message = {
				messageId: userTempId,
				role: "user",
				content,
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

				for await (const evt of readSseStream(response.body)) {
					if (controller.signal.aborted) break;

					if (evt.event === "delta") {
						const payload = JSON.parse(evt.data) as { delta?: unknown };
						const delta =
							typeof payload.delta === "string" ? payload.delta : "";
						if (delta.length === 0) continue;

						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
											content: (m.content ?? "") + delta,
											status: "sending" as const,
										}
									: m,
							),
						);
					}

					if (evt.event === "tool-call") {
						const payload = JSON.parse(evt.data) as {
							toolCallId: string;
							toolName: string;
							arguments?: unknown;
						};
						const argsString =
							typeof payload.arguments === "string"
								? payload.arguments
								: JSON.stringify(payload.arguments ?? {});
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantTempId
									? {
											...m,
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
						const payload = JSON.parse(evt.data) as {
							toolCallId: string;
							toolName: string;
							result?: unknown;
						};

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
						receivedDone = true;
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
						break;
					}

					if (evt.event === "error" || evt.event === "stream-error") {
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

				if (!controller.signal.aborted && !receivedDone) {
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
				if ((error as Error).name === "AbortError") {
					finalizeExecutingToolCalls("settings.ai.errors.streamingAborted");
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
				await refetchMessages();
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
		],
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
	}, [abortController]);

	const retryMessage = useCallback(
		async (messageId: string, aiId: string) => {
			const message = pendingMessages.find((m) => m.messageId === messageId);
			if (!message || !message.content) return;

			setPendingMessages((prev) =>
				prev.filter((m) => m.messageId !== messageId),
			);

			await send(message.content, aiId);
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
			setConversationId(normalized);
		},
		[stopGeneration],
	);

	const contextKeyRef = useRef<string>(
		`${options.projectId ?? ""}::${options.serverId ?? ""}`,
	);

	useEffect(() => {
		const nextKey = `${options.projectId ?? ""}::${options.serverId ?? ""}`;
		if (contextKeyRef.current === nextKey) return;
		contextKeyRef.current = nextKey;
		if (!isEnabled) return;
		reset();
	}, [isEnabled, options.projectId, options.serverId, reset]);

	return {
		ensureConversation,
		conversationId,
		messages,
		isLoading,
		areToolApprovalsDisabled,
		setToolApprovalsDisabled,
		toolOutcomes,
		send,
		approveToolCall,
		rejectToolCall,
		reset,
		openConversation,
		retryMessage,
		refetchMessages,
		stopGeneration,
	};
}
