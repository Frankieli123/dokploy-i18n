"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/utils/api";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeConversationValue(value: string | undefined | null): string {
	return typeof value === "string" ? value.trim() : "";
}

const DRAFT_CONVERSATION_SCOPE_ID = "__draft_conversation__";
const DISABLE_CLIENT_STREAM_TIMEOUT =
	process.env.NEXT_PUBLIC_AI_DISABLE_CLIENT_STREAM_TIMEOUT === "true";

function isAbortLikeError(error: unknown): boolean {
	if (!error) return false;
	const maybe = error as { name?: unknown; message?: unknown };
	const name = typeof maybe.name === "string" ? maybe.name : "";
	if (name === "AbortError") return true;
	const message = typeof maybe.message === "string" ? maybe.message : "";
	const normalized = message.trim().toLowerCase();
	if (normalized === "aborted") return true;
	if (
		normalized.includes("bodystreambuffer") &&
		normalized.includes("aborted")
	) {
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

function isTerminalToolCallStatus(
	status: ToolCall["status"] | undefined,
): boolean {
	return status === "completed" || status === "failed" || status === "rejected";
}

function getExecutionIdForToolCall(toolCall: ToolCall): string {
	if (
		typeof toolCall.executionId === "string" &&
		toolCall.executionId.trim().length > 0
	) {
		return toolCall.executionId.trim();
	}
	const data = toolCall.result?.data;
	if (!isRecord(data)) return "";
	const direct = data.executionId;
	if (typeof direct === "string" && direct.trim().length > 0) {
		return direct.trim();
	}
	const nested = data.data;
	if (isRecord(nested)) {
		const v = nested.executionId;
		if (typeof v === "string" && v.trim().length > 0) {
			return v.trim();
		}
	}
	return "";
}

export interface Message {
	messageId: string;
	conversationId?: string;
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

function areAttachmentsEqual(
	left: Message["attachments"],
	right: Message["attachments"],
) {
	type NormalizedAttachment = {
		type: "image";
		mediaType: string;
		data: string;
		name: string;
		size: number | null;
	};

	const normalize = (
		input: Message["attachments"],
	): NormalizedAttachment[] => {
		if (!Array.isArray(input) || input.length === 0) return [];
		const out: NormalizedAttachment[] = [];
		for (const attachment of input) {
			if (!attachment || attachment.type !== "image") continue;
			const mediaType =
				typeof attachment.mediaType === "string" ? attachment.mediaType.trim() : "";
			if (!mediaType) continue;
			const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
			const name = typeof attachment.name === "string" ? attachment.name : "";
			const size =
				typeof attachment.size === "number" && Number.isFinite(attachment.size)
					? attachment.size
					: null;
			out.push({ type: "image", mediaType, data, name, size });
		}
		return out;
	};

	const leftList = normalize(left);
	const rightList = normalize(right);
	if (leftList.length === 0 && rightList.length === 0) return true;
	if (leftList.length !== rightList.length) return false;

	const matches = (a: NormalizedAttachment, b: NormalizedAttachment) => {
		if (a.type !== b.type) return false;
		if (a.mediaType !== b.mediaType) return false;
		if (a.size !== null && b.size !== null && a.size !== b.size) return false;
		const aHasData = a.data.length > 0;
		const bHasData = b.data.length > 0;
		if (aHasData && bHasData) return a.data === b.data;
		if (!aHasData && !bHasData) {
			if (a.name && b.name) return a.name === b.name;
			return true;
		}
		if (a.size !== null && b.size !== null && a.size === b.size) {
			if (a.name && b.name) return a.name === b.name;
			return true;
		}
		return false;
	};

	const used = new Array(rightList.length).fill(false);
	for (const leftAttachment of leftList) {
		let found = false;
		for (let index = 0; index < rightList.length; index++) {
			if (used[index]) continue;
			const rightAttachment = rightList[index];
			if (!rightAttachment) continue;
			if (!matches(leftAttachment, rightAttachment)) continue;
			used[index] = true;
			found = true;
			break;
		}
		if (!found) return false;
	}
	return true;
}

function getMessageRoleRank(role: Message["role"]): number {
	if (role === "user") return 1;
	if (role === "assistant") return 2;
	if (role === "tool") return 3;
	return 4;
}

function mergeMessageText(
	serverText: string | null | undefined,
	pendingText: string | null | undefined,
): string | null {
	const server = typeof serverText === "string" ? serverText : "";
	const pending = typeof pendingText === "string" ? pendingText : "";
	if (pending.trim().length === 0) return serverText ?? null;
	if (server.trim().length === 0) return pendingText ?? null;
	if (pending.startsWith(server)) return pendingText ?? null;
	if (server.startsWith(pending)) return serverText ?? null;
	return pending.length >= server.length
		? (pendingText ?? null)
		: (serverText ?? null);
}

function mergeMessageToolCalls(
	serverCalls: Message["toolCalls"],
	pendingCalls: Message["toolCalls"],
): Message["toolCalls"] {
	const serverList = Array.isArray(serverCalls) ? serverCalls : [];
	const pendingList = Array.isArray(pendingCalls) ? pendingCalls : [];

	if (serverList.length === 0 && pendingList.length === 0) {
		return serverCalls ?? pendingCalls ?? null;
	}
	if (pendingList.length === 0) return serverCalls ?? null;
	if (serverList.length === 0) return pendingCalls ?? null;

	const byId = new Map<string, ToolCall>();
	const order: string[] = [];

	for (const tc of serverList) {
		if (!tc?.id) continue;
		if (!byId.has(tc.id)) order.push(tc.id);
		byId.set(tc.id, tc);
	}
	for (const tc of pendingList) {
		if (!tc?.id) continue;
		const existing = byId.get(tc.id);
		if (!existing) {
			order.push(tc.id);
			byId.set(tc.id, tc);
			continue;
		}
		byId.set(tc.id, {
			...existing,
			...tc,
			function: {
				...existing.function,
				...tc.function,
			},
			result: tc.result ?? existing.result,
		});
	}

	return order.map((id) => byId.get(id)).filter(Boolean) as ToolCall[];
}

export function mergeServerAndPendingMessages(
	server: Message[],
	pending: Message[],
) {
	const pendingById = new Map(pending.map((m) => [m.messageId, m]));
	const mergedServer = server.map((serverMessage) => {
		const pendingMessage = pendingById.get(serverMessage.messageId);
		if (!pendingMessage) return serverMessage;
		if (pendingMessage.status !== "sending") return serverMessage;
		const createdAt =
			typeof serverMessage.createdAt === "string" &&
			serverMessage.createdAt.trim().length > 0
				? serverMessage.createdAt
				: pendingMessage.createdAt;
		const content = mergeMessageText(
			serverMessage.content,
			pendingMessage.content,
		);
		const reasoning = mergeMessageText(
			serverMessage.reasoning,
			pendingMessage.reasoning,
		);
		const toolCalls = mergeMessageToolCalls(
			serverMessage.toolCalls,
			pendingMessage.toolCalls,
		);
		const attachments =
			Array.isArray(serverMessage.attachments) &&
			serverMessage.attachments.length > 0
				? serverMessage.attachments
				: pendingMessage.attachments;
		return {
			...serverMessage,
			...pendingMessage,
			createdAt,
			content,
			reasoning,
			toolCalls,
			attachments,
		};
	});
	const mergedServerIds = new Set(mergedServer.map((m) => m.messageId));

	const isEphemeralPendingId = (messageId: string) =>
		messageId.startsWith("temp-") || messageId.startsWith("agent-run-");

	const pendingOnly = pending.filter((pendingMessage) => {
		if (mergedServerIds.has(pendingMessage.messageId)) return false;
		if (isEphemeralPendingId(pendingMessage.messageId)) {
			const pendingTime = Date.parse(pendingMessage.createdAt ?? "");
			const hasEquivalentOnServer = mergedServer.some((serverMessage) => {
				if (serverMessage.role !== pendingMessage.role) return false;
				if (serverMessage.content !== pendingMessage.content) return false;
				if (
					!areAttachmentsEqual(
						serverMessage.attachments,
						pendingMessage.attachments,
					)
				) {
					return false;
				}
				const serverTime = Date.parse(serverMessage.createdAt ?? "");
				if (Number.isFinite(pendingTime) && Number.isFinite(serverTime)) {
					// Avoid dropping legitimate repeated messages from earlier history.
					if (serverTime < pendingTime - 60 * 1000) return false;
				}
				return true;
			});
			if (hasEquivalentOnServer) return false;
		}
		if (pendingMessage.status === "sending") return true;
		return !mergedServer.some(
			(serverMessage) =>
				serverMessage.role === pendingMessage.role &&
				serverMessage.content === pendingMessage.content &&
				areAttachmentsEqual(
					serverMessage.attachments,
					pendingMessage.attachments,
				),
		);
	});

	const merged = [...mergedServer, ...pendingOnly];
	return merged
		.map((message, index) => ({ message, index }))
		.sort((left, right) => {
			const leftIsSending = left.message.status === "sending";
			const rightIsSending = right.message.status === "sending";
			if (leftIsSending !== rightIsSending) {
				// Keep in-flight messages at the bottom so the latest turn doesn't appear above
				// its triggering user message due to clock skew / server-side createdAt ordering.
				return leftIsSending ? 1 : -1;
			}

			const leftTime = Date.parse(left.message.createdAt ?? "");
			const rightTime = Date.parse(right.message.createdAt ?? "");
			if (
				Number.isFinite(leftTime) &&
				Number.isFinite(rightTime) &&
				leftTime !== rightTime
			) {
				return leftTime - rightTime;
			}
			const leftRank = getMessageRoleRank(left.message.role);
			const rightRank = getMessageRoleRank(right.message.role);
			if (leftRank !== rightRank) return leftRank - rightRank;
			if (left.message.messageId !== right.message.messageId) {
				return left.message.messageId.localeCompare(right.message.messageId);
			}
			return left.index - right.index;
		})
		.map(({ message }) => message);
}

type RetryContext = {
	content: string;
	attachments: NonNullable<Message["attachments"]>;
	removeMessageIds: Set<string>;
};

function parseAgentPayload(
	content: string | null,
): Record<string, unknown> | null {
	if (typeof content !== "string" || content.trim().length === 0) return null;
	try {
		const parsed = JSON.parse(content);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function buildServerDisplayMessages(serverMessages: Message[]): Message[] {
	const sorted = serverMessages
		.map((message, index) => ({ message, index }))
		.sort((left, right) => {
			const leftTime = Date.parse(left.message.createdAt ?? "");
			const rightTime = Date.parse(right.message.createdAt ?? "");
			if (
				Number.isFinite(leftTime) &&
				Number.isFinite(rightTime) &&
				leftTime !== rightTime
			) {
				return leftTime - rightTime;
			}
			const leftRank = getMessageRoleRank(left.message.role);
			const rightRank = getMessageRoleRank(right.message.role);
			if (leftRank !== rightRank) return leftRank - rightRank;
			if (left.message.messageId !== right.message.messageId) {
				return left.message.messageId.localeCompare(right.message.messageId);
			}
			return left.index - right.index;
		})
		.map(({ message }) => message);

	const activeRunId = getMostRecentActiveAgentRunId(sorted) ?? "";
	const activeAssistantMessageId = activeRunId ? `agent-run-${activeRunId}` : "";
	if (!activeAssistantMessageId) return sorted;

	return sorted.map((m) => {
		if (m.role !== "assistant") return m;
		if (m.messageId !== activeAssistantMessageId) return m;
		return m.status === "sending" ? m : { ...m, status: "sending" as const };
	});
}

function hasActiveAgentRunInMessages(messages: Message[]): boolean {
	const runHasSummary = new Map<string, boolean>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const payload = parseAgentPayload(message.content);
		if (!payload) continue;
		const type = typeof payload.type === "string" ? payload.type : "";
		if (!type.startsWith("agent.")) continue;
		const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
		if (runId.length === 0) continue;
		if (!runHasSummary.has(runId)) runHasSummary.set(runId, false);
		if (type === "agent.run.summary" || type === "agent.run.finish") {
			runHasSummary.set(runId, true);
		}
	}
	for (const hasSummary of runHasSummary.values()) {
		if (!hasSummary) return true;
	}
	return false;
}

function getMostRecentActiveAgentRunId(messages: Message[]): string | null {
	const finished = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const payload = parseAgentPayload(message.content);
		if (!payload) continue;
		const type = typeof payload.type === "string" ? payload.type : "";
		if (!type.startsWith("agent.")) continue;
		const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
		if (runId.length === 0) continue;
		if (type === "agent.run.summary" || type === "agent.run.finish") {
			finished.add(runId);
		}
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role !== "system") continue;
		const payload = parseAgentPayload(message.content);
		if (!payload) continue;
		const type = typeof payload.type === "string" ? payload.type : "";
		if (!type.startsWith("agent.")) continue;
		const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
		if (runId.length === 0) continue;
		if (!finished.has(runId)) return runId;
	}
	return null;
}

export function resolveRetryContext(
	messages: Message[],
	messageId: string,
): RetryContext | null {
	const targetIndex = messages.findIndex((m) => m.messageId === messageId);
	if (targetIndex < 0) return null;
	const targetMessage = messages[targetIndex];
	if (!targetMessage) return null;

	let sourceUserMessage: Message | undefined;
	if (targetMessage.role === "user") {
		sourceUserMessage = targetMessage;
	} else {
		for (let i = targetIndex - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (!candidate || candidate.role !== "user") continue;
			const candidateContent = candidate.content ?? "";
			const candidateAttachments = Array.isArray(candidate.attachments)
				? candidate.attachments
				: [];
			if (
				candidateContent.trim().length > 0 ||
				candidateAttachments.length > 0
			) {
				sourceUserMessage = candidate;
				break;
			}
		}
	}

	if (!sourceUserMessage) return null;
	const content = sourceUserMessage.content ?? "";
	const attachments = Array.isArray(sourceUserMessage.attachments)
		? sourceUserMessage.attachments
		: [];
	if (!content.trim() && attachments.length === 0) return null;

	const removeMessageIds = new Set<string>([
		messageId,
		sourceUserMessage.messageId,
	]);
	if (targetMessage.role === "user") {
		const nextMessage = messages[targetIndex + 1];
		if (
			nextMessage &&
			nextMessage.role === "assistant" &&
			(nextMessage.status === "sending" || nextMessage.status === "error")
		) {
			removeMessageIds.add(nextMessage.messageId);
		}
	}

	return { content, attachments, removeMessageIds };
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
	const sendInFlightRef = useRef(false);
	const [isLoading, setIsLoading] = useState(false);
	const [abortController, setAbortController] =
		useState<AbortController | null>(null);
	const [pendingApproval, setPendingApproval] =
		useState<PendingApproval | null>(null);
	const [isLoadingByConversation, setIsLoadingByConversation] = useState<
		Record<string, boolean>
	>({});
	const [canContinueByConversation, setCanContinueByConversation] = useState<
		Record<string, boolean>
	>({});
	const [pendingApprovalByConversation, setPendingApprovalByConversation] =
		useState<Record<string, PendingApproval | null>>({});
	const abortControllerByConversationRef = useRef<
		Record<string, AbortController>
	>({});
	const agentRunIdByConversationRef = useRef<Record<string, string>>({});
	const conversationIdRef = useRef<string | undefined>(conversationId);
	const approveExecution = api.ai.agent.approve.useMutation();
	const executeExecution = api.ai.agent.execute.useMutation();
	const cancelAgentRun = api.ai.agent.cancel.useMutation();
	const setToolApprovalsDisabledMutation =
		api.ai.conversations.setToolApprovalsDisabled.useMutation();
	const setToolBudgetModeMutation =
		api.ai.conversations.setToolBudgetMode.useMutation();

	const setConversationLoadingState = useCallback(
		(targetConversationId: string | undefined, loading: boolean) => {
			const normalized = normalizeConversationValue(targetConversationId);
			if (!normalized) return;
			setIsLoadingByConversation((prev) => {
				if (loading) {
					if (prev[normalized] === true) return prev;
					return { ...prev, [normalized]: true };
				}
				if (!(normalized in prev)) return prev;
				const next = { ...prev };
				delete next[normalized];
				return next;
			});
			const activeScopeId =
				normalizeConversationValue(conversationIdRef.current) ||
				DRAFT_CONVERSATION_SCOPE_ID;
			if (activeScopeId === normalized) {
				setIsLoading(loading);
			}
		},
		[],
	);

	const setConversationCanContinueState = useCallback(
		(targetConversationId: string | undefined, canContinue: boolean) => {
			const normalized = normalizeConversationValue(targetConversationId);
			if (!normalized) return;
			setCanContinueByConversation((prev) => {
				if (canContinue) {
					if (prev[normalized] === true) return prev;
					return { ...prev, [normalized]: true };
				}
				if (!(normalized in prev)) return prev;
				const next = { ...prev };
				delete next[normalized];
				return next;
			});
			const activeScopeId =
				normalizeConversationValue(conversationIdRef.current) ||
				DRAFT_CONVERSATION_SCOPE_ID;
			if (activeScopeId === normalized) {
				setCanContinueChat(canContinue);
			}
		},
		[],
	);

	const setConversationPendingApprovalState = useCallback(
		(
			targetConversationId: string | undefined,
			approval: PendingApproval | null,
		) => {
			const normalized = normalizeConversationValue(targetConversationId);
			if (!normalized) return;
			setPendingApprovalByConversation((prev) => {
				if (approval) {
					const current = prev[normalized];
					if (
						current?.executionId === approval.executionId &&
						current?.toolName === approval.toolName &&
						current?.runId === approval.runId &&
						current?.parametersPreview === approval.parametersPreview
					) {
						return prev;
					}
					return { ...prev, [normalized]: approval };
				}
				if (!(normalized in prev)) return prev;
				const next = { ...prev };
				delete next[normalized];
				return next;
			});
			const activeScopeId =
				normalizeConversationValue(conversationIdRef.current) ||
				DRAFT_CONVERSATION_SCOPE_ID;
			if (activeScopeId === normalized) {
				setPendingApproval(approval);
			}
		},
		[],
	);

	const setConversationAbortControllerState = useCallback(
		(
			targetConversationId: string | undefined,
			controller: AbortController | null,
		) => {
			const normalized = normalizeConversationValue(targetConversationId);
			if (!normalized) return;
			if (controller) {
				abortControllerByConversationRef.current[normalized] = controller;
			} else {
				delete abortControllerByConversationRef.current[normalized];
			}
			const activeScopeId =
				normalizeConversationValue(conversationIdRef.current) ||
				DRAFT_CONVERSATION_SCOPE_ID;
			if (activeScopeId === normalized) {
				setAbortController(controller);
			}
		},
		[],
	);

	const setConversationAgentRunId = useCallback(
		(targetConversationId: string | undefined, runId: string | null) => {
			const normalized = normalizeConversationValue(targetConversationId);
			if (!normalized) return;
			const nextRunId = typeof runId === "string" ? runId.trim() : "";
			if (nextRunId.length === 0) {
				delete agentRunIdByConversationRef.current[normalized];
				return;
			}
			agentRunIdByConversationRef.current[normalized] = nextRunId;
		},
		[],
	);

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
		conversationIdRef.current = conversationId;
		const normalized = normalizeConversationValue(conversationId);
		const scopeId = normalized || DRAFT_CONVERSATION_SCOPE_ID;
		setIsLoading(isLoadingByConversation[scopeId] === true);
		setCanContinueChat(canContinueByConversation[scopeId] === true);
		setPendingApproval(pendingApprovalByConversation[scopeId] ?? null);
		setAbortController(
			abortControllerByConversationRef.current[scopeId] ?? null,
		);
	}, [
		canContinueByConversation,
		conversationId,
		isLoadingByConversation,
		pendingApprovalByConversation,
	]);

	useEffect(() => {
		return () => {
			for (const controller of Object.values(
				abortControllerByConversationRef.current,
			)) {
				try {
					controller.abort();
				} catch {}
			}
			abortControllerByConversationRef.current = {};
		};
	}, []);

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
			{ conversationId: conversationId || "", limit: 100 },
			{
				enabled: isEnabled && !!conversationId,
				refetchOnWindowFocus: false,
			},
		);

	const mostRecentActiveRunId = useMemo(() => {
		return getMostRecentActiveAgentRunId((serverMessages || []) as Message[]);
	}, [serverMessages]);

	useEffect(() => {
		if (!conversationId) return;
		setConversationAgentRunId(conversationId, mostRecentActiveRunId ?? null);
	}, [conversationId, mostRecentActiveRunId, setConversationAgentRunId]);

	const agentEvents = api.ai.agent.events.useQuery(
		{ runId: mostRecentActiveRunId || "", limit: 500 },
		{
			enabled: isEnabled && !!mostRecentActiveRunId,
			refetchOnWindowFocus: false,
			refetchInterval: isEnabled && mostRecentActiveRunId ? 2500 : false,
		},
	);

	useEffect(() => {
		if (!conversationId) return;
		const normalizedConversationId = normalizeConversationValue(conversationId);
		if (!normalizedConversationId) return;
		const serverIds = new Set(
			((serverMessages || []) as Message[]).map((m) => m.messageId),
		);
		setPendingMessages((prev) =>
			prev.filter((m) => {
				const messageConversationId = normalizeConversationValue(
					m.conversationId,
				);
				if (
					messageConversationId.length > 0 &&
					messageConversationId !== normalizedConversationId
				) {
					return true;
				}
				if (m.status === "sending" || m.status === "error") return true;
				if (m.role !== "assistant") return true;
				return serverIds.has(m.messageId);
			}),
		);
	}, [conversationId, serverMessages]);

	const shouldPollAgentEvents = useMemo(
		() =>
			isEnabled &&
			!!conversationId &&
			!isLoading &&
			hasActiveAgentRunInMessages((serverMessages || []) as Message[]),
		[conversationId, isEnabled, isLoading, serverMessages],
	);

	useEffect(() => {
		if (!shouldPollAgentEvents) return;
		const interval = setInterval(() => {
			void refetchMessages();
		}, 2500);
		return () => clearInterval(interval);
	}, [refetchMessages, shouldPollAgentEvents]);

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
	}, [
		conversationDetails?.metadata,
		conversationId,
		toolBudgetMode,
		setToolBudgetModeMutation,
	]);

	const combinedServerMessages = useMemo(() => {
		const base = ((serverMessages || []) as Message[]).slice();
		const extra = (agentEvents.data?.messages ?? []) as Message[];
		if (!extra || extra.length === 0) return base;
		const seen = new Set<string>();
		const merged: Message[] = [];
		for (const message of [...base, ...extra]) {
			if (!message?.messageId) continue;
			if (seen.has(message.messageId)) continue;
			seen.add(message.messageId);
			merged.push(message);
		}
		return merged;
	}, [agentEvents.data, serverMessages]);

	const serverDisplayMessages = useMemo(() => {
		if (!conversationId) return [] as Message[];
		return buildServerDisplayMessages(combinedServerMessages);
	}, [combinedServerMessages, conversationId]);

	const pendingMessagesForConversation = useMemo(() => {
		const normalizedConversationId = normalizeConversationValue(conversationId);
		return pendingMessages.filter((message) => {
			const messageConversationId = normalizeConversationValue(
				message.conversationId,
			);
			if (!normalizedConversationId) {
				return (
					messageConversationId === DRAFT_CONVERSATION_SCOPE_ID ||
					messageConversationId.length === 0
				);
			}
			return messageConversationId === normalizedConversationId;
		});
	}, [conversationId, pendingMessages]);

	const executionHydrationTargets = useMemo(() => {
		const messageSources: Message[] = conversationId
			? [...serverDisplayMessages, ...pendingMessagesForConversation]
			: pendingMessagesForConversation;
		const toolCalls = messageSources.flatMap((m) => m.toolCalls || []);

		const toolCallIdsByExecutionId = new Map<string, string[]>();
		const executionIds: string[] = [];
		const seenExecutions = new Set<string>();
		const seenToolCalls = new Set<string>();

		for (const tc of toolCalls) {
			if (seenToolCalls.has(tc.id)) continue;
			seenToolCalls.add(tc.id);
			const executionId = getExecutionIdForToolCall(tc);
			if (!executionId) continue;

			const currentStatus = toolCallMeta[tc.id]?.status ?? tc.status;
			const isTerminal = isTerminalToolCallStatus(currentStatus);
			if (isTerminal) continue;

			const existing = toolCallIdsByExecutionId.get(executionId) ?? [];
			existing.push(tc.id);
			toolCallIdsByExecutionId.set(executionId, existing);

			if (!seenExecutions.has(executionId)) {
				seenExecutions.add(executionId);
				executionIds.push(executionId);
				if (executionIds.length >= 50) break;
			}
		}

		return { executionIds, toolCallIdsByExecutionId };
	}, [
		conversationId,
		pendingMessagesForConversation,
		serverDisplayMessages,
		toolCallMeta,
	]);

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
					const prevStatus = prevMeta?.status;
					const shouldUpdateStatus =
						!prevStatus ||
						(!isTerminalToolCallStatus(prevStatus) &&
							prevStatus !== exec.status);
					const shouldUpdateExecutionId =
						prevMeta?.executionId !== exec.executionId;
					if (
						!prevMeta ||
						shouldUpdateStatus ||
						shouldUpdateResult ||
						shouldUpdateExecutionId
					) {
						next[toolCallId] = {
							status: shouldUpdateStatus ? exec.status : prevStatus,
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
			return pendingMessagesForConversation.map(applyMeta);
		}

		const serverWithMeta = serverDisplayMessages.map(applyMeta);
		const pendingWithMeta = pendingMessagesForConversation.map(applyMeta);
		return mergeServerAndPendingMessages(serverWithMeta, pendingWithMeta);
	}, [
		conversationId,
		pendingMessagesForConversation,
		serverDisplayMessages,
		toolCallMeta,
	]);

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
			setConversationPendingApprovalState(conversationId, null);
		} catch (error) {
			options.onError?.(error as Error);
		} finally {
			inFlightApprovalExecutionIdsRef.current.delete(executionId);
		}
	}, [
		approveExecution,
		conversationId,
		options,
		pendingApproval,
		setConversationPendingApprovalState,
	]);

	const rejectPending = useCallback(async () => {
		const executionId = pendingApproval?.executionId?.trim() ?? "";
		if (executionId.length === 0) return;
		if (inFlightApprovalExecutionIdsRef.current.has(executionId)) return;
		inFlightApprovalExecutionIdsRef.current.add(executionId);
		try {
			await approveExecution.mutateAsync({ executionId, approved: false });
			setConversationPendingApprovalState(conversationId, null);
		} catch (error) {
			options.onError?.(error as Error);
		} finally {
			inFlightApprovalExecutionIdsRef.current.delete(executionId);
		}
	}, [
		approveExecution,
		conversationId,
		options,
		pendingApproval,
		setConversationPendingApprovalState,
	]);

	const stopGeneration = useCallback(() => {
		const normalizedConversationId = normalizeConversationValue(conversationId);
		const normalizedRefConversationId = normalizeConversationValue(
			conversationIdRef.current,
		);
		const scopeId =
			normalizedRefConversationId ||
			normalizedConversationId ||
			DRAFT_CONVERSATION_SCOPE_ID;
		const fallbackRunId =
			normalizedRefConversationId === scopeId
				? (mostRecentActiveRunId ?? "")
				: "";
		const runId =
			agentRunIdByConversationRef.current[scopeId] ?? fallbackRunId ?? "";
		if (runId.trim().length > 0) {
			void cancelAgentRun.mutateAsync({ runId: runId.trim() }).catch(() => {});
		}
		const controller =
			abortControllerByConversationRef.current[scopeId] ?? abortController;
		controller?.abort();
		setConversationAgentRunId(scopeId, null);
		setConversationAbortControllerState(scopeId, null);
		setConversationLoadingState(scopeId, false);
	}, [
		abortController,
		cancelAgentRun,
		conversationId,
		mostRecentActiveRunId,
		setConversationAgentRunId,
		setConversationAbortControllerState,
		setConversationLoadingState,
	]);

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
			if (sendInFlightRef.current) return;
			sendInFlightRef.current = true;
			try {

			const startConversationId = normalizeConversationValue(conversationId);
			const pendingScopeId = startConversationId || DRAFT_CONVERSATION_SCOPE_ID;
			setConversationLoadingState(pendingScopeId, true);
			setConversationCanContinueState(pendingScopeId, false);
			const controller = new AbortController();
			setConversationAbortControllerState(pendingScopeId, controller);

			const timestamp = Date.now();
			const userTempId = `temp-${timestamp}-user`;
			const assistantTempId = `temp-${timestamp}-assistant`;

			const userMessage: Message = {
				messageId: userTempId,
				conversationId: pendingScopeId,
				role: "user",
				content,
				attachments: attachments.length > 0 ? attachments : undefined,
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			const assistantMessage: Message = {
				messageId: assistantTempId,
				conversationId: pendingScopeId,
				role: "assistant",
				content: "",
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			setPendingMessages((prev) => [...prev, userMessage, assistantMessage]);

			const finalizeExecutingToolCalls = (
				assistantMessageId: string,
				errorMsg: string,
			) => {
				setPendingMessages((prev) =>
					prev.map((m) => {
						if (m.messageId !== assistantMessageId) return m;
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
					setConversationLoadingState(pendingScopeId, false);
					setConversationAbortControllerState(pendingScopeId, null);
					options.onError?.(error as Error);
					return;
				}
			}
			const streamConversationId = normalizeConversationValue(
				currentConversationId,
			);
			if (streamConversationId) {
				setConversationLoadingState(streamConversationId, true);
				setConversationCanContinueState(streamConversationId, false);
				setConversationAbortControllerState(streamConversationId, controller);
				if (pendingScopeId !== streamConversationId) {
					setConversationLoadingState(pendingScopeId, false);
					setConversationCanContinueState(pendingScopeId, false);
					setConversationAbortControllerState(pendingScopeId, null);
					setConversationPendingApprovalState(pendingScopeId, null);
				}
				setPendingMessages((prev) =>
					prev.map((m) =>
						m.messageId === userTempId || m.messageId === assistantTempId
							? { ...m, conversationId: streamConversationId }
							: m,
					),
				);
			}

			let abortedBySafetyTimer = false;

			if (isAgentMode) {
				let userMessageId = userTempId;
				let assistantMessageId = assistantTempId;
				let stopReason: "done" | "waiting_approval" | "aborted" = "aborted";
				try {
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

						const headerRunId = (response.headers.get("X-Dokploy-AI-Run-Id") ?? "")
							.trim();
						const headerAssistantMessageId = (
							response.headers.get("X-Dokploy-AI-Assistant-Message-Id") ?? ""
						).trim();
						const headerUserMessageId = (
							response.headers.get("X-Dokploy-AI-User-Message-Id") ?? ""
						).trim();
						if (headerRunId.length > 0) {
							setConversationAgentRunId(streamConversationId, headerRunId);
						}
						if (headerUserMessageId.length > 0 && userMessageId.startsWith("temp-")) {
							const previousId = userMessageId;
							const nextId = headerUserMessageId;
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === previousId ? { ...m, messageId: nextId } : m,
								),
							);
							userMessageId = nextId;
						}
						if (headerRunId.length > 0 && assistantMessageId.startsWith("temp-")) {
							const nextId =
								headerAssistantMessageId.length > 0
									? headerAssistantMessageId
									: `agent-run-${headerRunId}`;
							const previousId = assistantMessageId;
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === previousId ? { ...m, messageId: nextId } : m,
								),
							);
							assistantMessageId = nextId;
						}

						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === userMessageId
									? { ...m, status: "sent" as const }
									: m,
							),
						);

					const updateAssistantMessage = (updater: (m: Message) => Message) => {
						const targetId = assistantMessageId;
						setPendingMessages((prev) =>
							prev.map((m) => (m.messageId === targetId ? updater(m) : m)),
						);
					};

					const deltaBufferRef = { current: "" as string };
					let lastOutputText = "";
					let sawAssistantOutput = false;
					let lastReasoningText = "";
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
						updateAssistantMessage((m) => ({
							...m,
							content: (m.content ?? "") + pending,
							status: "sending" as const,
						}));
					};

					const scheduleFlushDelta = () => {
						if (flushDeltaTimer) return;
						flushDeltaTimer = setTimeout(() => {
							flushDeltaNow();
						}, FLUSH_MS);
					};

					const normalizeAgentToolCallId = (params: {
						executionId?: unknown;
						stepId?: unknown;
						messageId?: string;
						toolName?: string;
					}) => {
						const executionId =
							typeof params.executionId === "string"
								? params.executionId.trim()
								: "";
						if (executionId.length > 0) return executionId;
						const stepId =
							typeof params.stepId === "string" ? params.stepId.trim() : "";
						if (stepId.length > 0) return stepId;
						const messageId =
							typeof params.messageId === "string"
								? params.messageId.trim()
								: "";
						if (messageId.length > 0) return `agent-${messageId}`;
						const toolName =
							typeof params.toolName === "string"
								? params.toolName.trim()
								: "tool";
						return `agent-${toolName}-${Date.now()}`;
					};

					const parsePreviewToData = (preview: unknown): unknown => {
						if (typeof preview !== "string") return undefined;
						const trimmed = preview.trim();
						if (trimmed.length === 0) return undefined;
						try {
							return JSON.parse(trimmed);
						} catch {
							return trimmed;
						}
					};

					const upsertAgentToolCall = (params: {
						toolCallId: string;
						toolName: string;
						executionId?: string;
						status: NonNullable<ToolCall["status"]>;
						argumentsText?: string;
						result?: ToolCall["result"];
					}) => {
						const marker = `\n\n<<tool:${params.toolCallId}>>\n\n`;
						updateAssistantMessage((m) => {
							const existingContent = m.content ?? "";
							const content = existingContent.includes(marker)
								? existingContent
								: `${existingContent}${marker}`;
							const toolCalls = [...(m.toolCalls || [])];
							const existingIndex = toolCalls.findIndex(
								(tc) => tc.id === params.toolCallId,
							);
							const base =
								existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
							const nextToolCall: ToolCall = {
								id: params.toolCallId,
								type: "function",
								executionId: params.executionId,
								status: params.status,
								result: params.result,
								function: {
									name: params.toolName || base?.function.name || "tool",
									arguments:
										params.argumentsText ?? base?.function.arguments ?? "{}",
								},
							};
							if (existingIndex >= 0) {
								toolCalls[existingIndex] = {
									...base,
									...nextToolCall,
									function: {
										name:
											nextToolCall.function.name ||
											base?.function.name ||
											"tool",
										arguments:
											nextToolCall.function.arguments ||
											base?.function.arguments ||
											"{}",
									},
									result: nextToolCall.result ?? base?.result,
								};
							} else {
								toolCalls.push(nextToolCall);
							}
							return { ...m, content, toolCalls, status: "sending" as const };
						});
					};

					const streamStartTime = Date.now();
					let lastProgressTime = streamStartTime;
					const INITIAL_IDLE_NO_PROGRESS_MS = 45 * 1000;
					const STALL_NO_PROGRESS_MS = 120 * 1000;
					let hasVisibleProgress = false;
					const isProgressEvent = (eventName: string) =>
						eventName === "done" ||
						eventName === "error" ||
						eventName === "stream-error" ||
						eventName === "agent.run.start" ||
						eventName === "agent.plan" ||
						eventName === "agent.run.finish" ||
						eventName === "agent.run.summary" ||
						eventName === "agent.output.delta" ||
						eventName === "agent.output.reasoning" ||
						eventName === "agent.step.start" ||
						eventName === "agent.step.result" ||
						eventName === "agent.step.wait_approval";

					const safetyInterval = setInterval(() => {
						if (DISABLE_CLIENT_STREAM_TIMEOUT) return;
						const now = Date.now();
						const idleTimeoutMs = hasVisibleProgress
							? STALL_NO_PROGRESS_MS
							: INITIAL_IDLE_NO_PROGRESS_MS;
						if (now - lastProgressTime <= idleTimeoutMs) {
							return;
						}
						abortedBySafetyTimer = true;
						controller.abort();
					}, 1000);

					try {
						for await (const evt of readSseStream(response.body)) {
							if (controller.signal.aborted) break;
							if (evt.event === "ping") {
								lastProgressTime = Date.now();
								continue;
							}
							if (evt.event === "start") {
								lastProgressTime = Date.now();
								try {
									const started = JSON.parse(evt.data) as unknown;
									const startedRunId =
										isRecord(started) && typeof started.runId === "string"
											? started.runId.trim()
											: "";
									const startedUserMessageId =
										isRecord(started) &&
										typeof (started as { userMessageId?: unknown }).userMessageId ===
											"string"
											? String(
													(started as { userMessageId?: unknown }).userMessageId,
												).trim()
											: "";
									const startedAssistantMessageId =
										isRecord(started) &&
										typeof (started as {
											assistantMessageId?: unknown;
										}).assistantMessageId === "string"
											? String(
													(started as { assistantMessageId?: unknown })
														.assistantMessageId,
												).trim()
											: "";
									if (startedRunId.length > 0) {
										setConversationAgentRunId(
											streamConversationId,
											startedRunId,
										);
										if (
											startedUserMessageId.length > 0 &&
											userMessageId.startsWith("temp-")
										) {
											const previousId = userMessageId;
											setPendingMessages((prev) =>
												prev.map((m) =>
													m.messageId === previousId
														? { ...m, messageId: startedUserMessageId }
														: m,
												),
											);
											userMessageId = startedUserMessageId;
										}
										if (assistantMessageId.startsWith("temp-")) {
											flushDeltaNow();
											const nextId =
												startedAssistantMessageId.length > 0
													? startedAssistantMessageId
													: `agent-run-${startedRunId}`;
											const previousId = assistantMessageId;
											setPendingMessages((prev) =>
												prev.map((m) =>
													m.messageId === previousId
														? { ...m, messageId: nextId }
														: m,
												),
											);
											assistantMessageId = nextId;
										}
									}
								} catch {}
								continue;
							}
							if (isProgressEvent(evt.event)) {
								lastProgressTime = Date.now();
								hasVisibleProgress = true;
							}

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

							const { payload, messageId: eventMessageId } = (() => {
								try {
									const outer = JSON.parse(evt.data) as unknown;
									if (!isRecord(outer)) return { payload: null, messageId: "" };
									const inner = outer.payload;
									const messageId =
										typeof outer.messageId === "string" ? outer.messageId : "";
									return {
										payload: isRecord(inner) ? inner : null,
										messageId,
									};
								} catch {
									return { payload: null, messageId: "" };
								}
							})();

							const runId =
								payload && typeof payload.runId === "string"
									? payload.runId.trim()
									: "";
							if (runId.length > 0) {
								setConversationAgentRunId(streamConversationId, runId);
							}
							if (runId.length > 0 && assistantMessageId.startsWith("temp-")) {
								flushDeltaNow();
								const nextId = `agent-run-${runId}`;
								const previousId = assistantMessageId;
								setPendingMessages((prev) =>
									prev.map((m) =>
										m.messageId === previousId
											? { ...m, messageId: nextId }
											: m,
									),
								);
								assistantMessageId = nextId;
							}

							if (evt.event === "agent.output.delta") {
								const text =
									payload && typeof payload.delta === "string"
										? payload.delta
										: "";
								if (text.length === 0 || text === lastOutputText) continue;
								const previous = lastOutputText;
								lastOutputText = text;
								const delta = text.startsWith(previous)
									? text.slice(previous.length)
									: previous.startsWith(text)
										? ""
										: text;
								if (delta.length === 0) continue;
								sawAssistantOutput = true;
								deltaBufferRef.current += delta;
								scheduleFlushDelta();
								continue;
							}

							if (evt.event === "agent.output.reasoning") {
								flushDeltaNow();
								const text =
									payload && typeof payload.text === "string"
										? payload.text
										: "";
								if (text.length === 0) continue;
								const previous = lastReasoningText;
								lastReasoningText = text;
								const delta = text.startsWith(previous)
									? text.slice(previous.length)
									: text;
								if (delta.trim().length === 0) continue;
								const thinkId =
									eventMessageId.trim().length > 0
										? `agent-${eventMessageId.trim()}`
										: `agent-${Date.now()}`;
								const marker = `\n\n<<think:${thinkId}>>\n${delta}\n<<think_end:${thinkId}>>\n\n`;
								updateAssistantMessage((m) => ({
									...m,
									content: (m.content ?? "") + marker,
									status: "sending" as const,
								}));
								continue;
							}

							if (evt.event === "agent.step.start") {
								flushDeltaNow();
								const toolName =
									payload && typeof payload.toolName === "string"
										? payload.toolName
										: "tool";
								const toolCallId = normalizeAgentToolCallId({
									executionId: payload?.executionId,
									stepId: payload?.stepId,
									messageId: eventMessageId,
									toolName,
								});
								const executionId =
									typeof payload?.executionId === "string"
										? payload.executionId.trim()
										: "";
								upsertAgentToolCall({
									toolCallId,
									toolName,
									executionId: executionId.length > 0 ? executionId : undefined,
									status: "executing",
									argumentsText:
										typeof payload?.parametersPreview === "string" &&
										payload.parametersPreview.trim().length > 0
											? payload.parametersPreview
											: "{}",
								});
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
								const toolCallId = normalizeAgentToolCallId({
									executionId: payload?.executionId,
									stepId: payload?.stepId,
									messageId: eventMessageId,
									toolName,
								});
								const executionId =
									typeof payload?.executionId === "string"
										? payload.executionId.trim()
										: "";
								upsertAgentToolCall({
									toolCallId,
									toolName,
									executionId: executionId.length > 0 ? executionId : undefined,
									status: success ? "completed" : "failed",
									result: {
										success,
										message: summary || undefined,
										data: parsePreviewToData(payload?.dataPreview),
										error: success ? undefined : summary || undefined,
									},
								});
								continue;
							}

							if (evt.event === "agent.run.summary") {
								flushDeltaNow();
								const summary =
									payload && typeof payload.summary === "string"
										? payload.summary.trim()
										: "";
								if (summary.length > 0 && !sawAssistantOutput) {
									updateAssistantMessage((m) => {
										const existing = m.content ?? "";
										const normalizedSummary = summary.trim();
										if (normalizedSummary.length === 0) return m;
										if (existing.trim().length === 0) {
											return {
												...m,
												content: normalizedSummary,
												status: "sending" as const,
											};
										}
										if (existing.includes(normalizedSummary)) return m;
										const separator = existing.endsWith("\n") ? "\n" : "\n\n";
										return {
											...m,
											content: `${existing}${separator}${normalizedSummary}`,
											status: "sending" as const,
										};
									});
								}
								continue;
							}

							if (
								evt.event === "agent.plan" ||
								evt.event === "agent.run.start" ||
								evt.event === "agent.run.finish"
							) {
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
								const toolCallId = normalizeAgentToolCallId({
									executionId,
									stepId: payload?.stepId,
									messageId: eventMessageId,
									toolName,
								});
								upsertAgentToolCall({
									toolCallId,
									toolName: toolName || "tool",
									executionId:
										executionId.trim().length > 0
											? executionId.trim()
											: undefined,
									status: "pending",
									argumentsText:
										typeof parametersPreview === "string" &&
										parametersPreview.trim().length > 0
											? parametersPreview
											: "{}",
									result: {
										success: false,
										message: "Waiting for approval",
									},
								});
								if (executionId.trim().length > 0) {
									setConversationPendingApprovalState(streamConversationId, {
										executionId: executionId.trim(),
										toolName,
										runId: runId.trim().length > 0 ? runId.trim() : undefined,
										parametersPreview,
									});
								}
								stopReason = "waiting_approval";
								break;
							}
						}
					} finally {
						flushDeltaNow();
						clearInterval(safetyInterval);
						if (flushDeltaTimer) {
							clearTimeout(flushDeltaTimer);
							flushDeltaTimer = null;
						}
					}
				} catch (error) {
					setConversationAbortControllerState(streamConversationId, null);
					if (isAbortLikeError(error)) {
						const assistantId = assistantMessageId;
						const userId = userMessageId;
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === userId || m.messageId === assistantId
									? { ...m, status: "sent" as const }
									: m,
							),
						);
						let didRefetch = false;
						try {
							const refetchPromise = refetchMessages()
								.then(() => true)
								.catch(() => false);
							didRefetch = await Promise.race([
								refetchPromise,
								new Promise<boolean>((resolve) =>
									setTimeout(() => resolve(false), 10000),
								),
							]);
						} finally {
							setConversationLoadingState(streamConversationId, false);
							if (didRefetch) {
								setPendingMessages((prev) =>
									prev.filter(
										(m) =>
											m.messageId !== userId && m.messageId !== assistantId,
									),
								);
							}
						}
						return;
					}

					const errorMsg =
						error instanceof Error
							? error.message
							: "settings.ai.errors.unknownError";
					const assistantId = assistantMessageId;
					const userId = userMessageId;
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userId || m.messageId === assistantId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setConversationLoadingState(streamConversationId, false);
					options.onError?.(error as Error);
					return;
				}

					if (stopReason !== "done") {
						const assistantId = assistantMessageId;
						const userId = userMessageId;
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === userId || m.messageId === assistantId
									? { ...m, status: "sent" as const }
									: m,
							),
						);
						let didRefetch = false;
					try {
						const refetchPromise = refetchMessages()
							.then(() => true)
							.catch(() => false);
						didRefetch = await Promise.race([
							refetchPromise,
							new Promise<boolean>((resolve) =>
								setTimeout(() => resolve(false), 10000),
							),
						]);
					} finally {
						setConversationLoadingState(streamConversationId, false);
							setConversationAbortControllerState(streamConversationId, null);
							if (didRefetch) {
								setPendingMessages((prev) =>
									prev.filter(
										(m) =>
											m.messageId !== userId && m.messageId !== assistantId,
									),
								);
							}
						}
						return;
					}

				try {
					const refetchPromise = refetchMessages().catch(() => {});
					await Promise.race([
						refetchPromise,
						new Promise((resolve) => setTimeout(resolve, 10000)),
					]);
					} finally {
						setConversationAgentRunId(streamConversationId, null);
						const assistantId = assistantMessageId;
						const userId = userMessageId;
						setPendingMessages((prev) =>
							prev.filter(
								(m) => m.messageId !== userId && m.messageId !== assistantId,
							),
						);
						setConversationLoadingState(streamConversationId, false);
						setConversationAbortControllerState(streamConversationId, null);
					}
					return;
				}

				let userMessageId = userTempId;
				let assistantMessageId = assistantTempId;
				try {
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
						m.messageId === userMessageId
							? { ...m, status: "sent" as const }
							: m,
					),
				);

				let receivedDone = false;
				const activeToolCallIds = new Set<string>();
				const toolCallArgsById = new Map<string, string>();
				const streamStartTime = Date.now();
				let lastEventTime = streamStartTime;
				const deltaBufferRef = { current: "" as string };
				let activeThinkId: string | null = null;
				let flushDeltaTimer: ReturnType<typeof setTimeout> | null = null;
				const FLUSH_VISIBLE_MS = 60;
				const FLUSH_HIDDEN_MS = 600;

				const ensureThinkStarted = () => {
					if (activeThinkId) return;
					activeThinkId =
						typeof crypto !== "undefined" && "randomUUID" in crypto
							? (crypto.randomUUID() as string)
							: `think-${Date.now()}`;
					deltaBufferRef.current += `\n\n<<think:${activeThinkId}>>\n`;
				};

				const closeThinkIfOpen = () => {
					if (!activeThinkId) return;
					deltaBufferRef.current += `\n<<think_end:${activeThinkId}>>\n\n`;
					activeThinkId = null;
				};

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
								m.messageId === assistantMessageId
									? {
											...m,
											content: (m.content ?? "") + pendingText,
											status: "sending" as const,
										}
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
				const MAX_DURATION_MS = 60 * 60 * 1000;

				const safetyInterval = setInterval(() => {
					if (DISABLE_CLIENT_STREAM_TIMEOUT) return;
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
						if (evt.event === "ping") {
							lastEventTime = Date.now();
							continue;
						}
						if (evt.event === "start") {
							lastEventTime = Date.now();
							try {
								const payload = JSON.parse(evt.data) as {
									userMessageId?: unknown;
									assistantMessageId?: unknown;
								};
								const nextUserMessageId =
									typeof payload.userMessageId === "string"
										? payload.userMessageId.trim()
										: "";
								const nextAssistantMessageId =
									typeof payload.assistantMessageId === "string"
										? payload.assistantMessageId.trim()
										: "";

								if (
									nextUserMessageId.length > 0 &&
									userMessageId.startsWith("temp-")
								) {
									const previousId = userMessageId;
									setPendingMessages((prev) =>
										prev.map((m) =>
											m.messageId === previousId
												? {
														...m,
														messageId: nextUserMessageId,
														status: "sent" as const,
													}
												: m,
										),
									);
									userMessageId = nextUserMessageId;
								}
								if (
									nextAssistantMessageId.length > 0 &&
									assistantMessageId.startsWith("temp-")
								) {
									const previousId = assistantMessageId;
									setPendingMessages((prev) =>
										prev.map((m) =>
											m.messageId === previousId
												? { ...m, messageId: nextAssistantMessageId }
												: m,
										),
									);
									assistantMessageId = nextAssistantMessageId;
								}
							} catch {}
							continue;
						}
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
							closeThinkIfOpen();
							const payload = JSON.parse(evt.data) as { delta?: unknown };
							const delta =
								typeof payload.delta === "string" ? payload.delta : "";
							if (delta.length === 0) continue;
							deltaBufferRef.current += delta;
							scheduleFlushDelta();
						}

						if (evt.event === "reasoning-delta") {
							ensureThinkStarted();
							const payload = JSON.parse(evt.data) as { delta?: unknown };
							const delta =
								typeof payload.delta === "string" ? payload.delta : "";
							if (delta.length === 0) continue;
							deltaBufferRef.current += delta;
							scheduleFlushDelta();
						}

						if (evt.event === "tool-call") {
							closeThinkIfOpen();
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
									m.messageId === assistantMessageId
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
							closeThinkIfOpen();
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
									if (m.messageId !== assistantMessageId) return m;
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
							closeThinkIfOpen();
							flushDeltaNow();
							let realId = "";
							try {
								const payload = JSON.parse(evt.data) as {
									needsContinue?: boolean;
									finishReason?: string;
									messageId?: string;
								};
								setConversationCanContinueState(
									streamConversationId,
									payload.needsContinue === true,
								);
								realId =
									typeof payload.messageId === "string"
										? payload.messageId.trim()
										: "";
							} catch {}

							receivedDone = true;
							activeToolCallIds.clear();
							finalizeExecutingToolCalls(
								assistantMessageId,
								"settings.ai.errors.toolExecutionDidNotReturnResult",
							);
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === userMessageId ||
									m.messageId === assistantMessageId
										? { ...m, status: "sent" as const }
										: m,
								),
							);
							if (realId && realId !== assistantMessageId) {
								const previousId = assistantMessageId;
								const nextId = realId;
								setPendingMessages((prev) =>
									prev.map((m) =>
										m.messageId === previousId
											? { ...m, messageId: nextId, status: "sent" as const }
											: m,
									),
								);
								assistantMessageId = nextId;
							}
							break;
						}

						if (evt.event === "error" || evt.event === "stream-error") {
							closeThinkIfOpen();
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
					closeThinkIfOpen();
					flushDeltaNow();
					clearInterval(safetyInterval);
				}

				if (controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingError"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(assistantMessageId, errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev
								.filter((m) => m.messageId !== userMessageId)
								.map((m) =>
									m.messageId === assistantMessageId
										? { ...m, status: "error" as const, error: errorMsg }
										: m,
								),
						);
						setConversationAbortControllerState(streamConversationId, null);
						setConversationLoadingState(streamConversationId, false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userMessageId ||
							m.messageId === assistantMessageId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				if (!controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					finalizeExecutingToolCalls(
						assistantMessageId,
						"settings.ai.errors.streamingError",
					);
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userMessageId ||
							m.messageId === assistantMessageId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				setConversationAbortControllerState(streamConversationId, null);
			} catch (error) {
				setConversationAbortControllerState(streamConversationId, null);
				if (isAbortLikeError(error)) {
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingError"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(assistantMessageId, errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev
								.filter((m) => m.messageId !== userMessageId)
								.map((m) =>
									m.messageId === assistantMessageId
										? { ...m, status: "error" as const, error: errorMsg }
										: m,
								),
						);
						setConversationLoadingState(streamConversationId, false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userMessageId ||
							m.messageId === assistantMessageId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				} else {
					const errorMsg =
						error instanceof Error
							? error.message
							: "settings.ai.errors.unknownError";
					finalizeExecutingToolCalls(assistantMessageId, errorMsg);
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === userMessageId ||
							m.messageId === assistantMessageId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setConversationLoadingState(streamConversationId, false);
					options.onError?.(error as Error);
					return;
				}
			}

			let didRefetch = false;
			try {
				const refetchPromise = refetchMessages()
					.then(() => true)
					.catch(() => false);
				didRefetch = await Promise.race([
					refetchPromise,
					new Promise<boolean>((resolve) =>
						setTimeout(() => resolve(false), 10000),
					),
				]);
			} finally {
				if (didRefetch) {
					const userId = userMessageId;
					const assistantId = assistantMessageId;
					setPendingMessages((prev) =>
						prev.filter(
							(m) => m.messageId !== userId && m.messageId !== assistantId,
						),
					);
				}
				setConversationLoadingState(streamConversationId, false);
			}
		} finally {
			sendInFlightRef.current = false;
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
			setConversationAbortControllerState,
			setConversationCanContinueState,
			setConversationLoadingState,
			setConversationAgentRunId,
			setConversationPendingApprovalState,
		],
	);

	const continueChat = useCallback(
		async (aiId: string) => {
			if (!conversationId) return;
			const streamConversationId = normalizeConversationValue(conversationId);
			if (!streamConversationId) return;
			if (isLoading) return;

			setConversationLoadingState(streamConversationId, true);
			setConversationCanContinueState(streamConversationId, false);

			const timestamp = Date.now();
			const assistantTempId = `temp-${timestamp}-assistant-continue`;
			let assistantMessageId = assistantTempId;

			const assistantMessage: Message = {
				messageId: assistantTempId,
				conversationId: streamConversationId,
				role: "assistant",
				content: "",
				reasoning: null,
				createdAt: new Date().toISOString(),
				status: "sending",
			};

			setPendingMessages((prev) => [...prev, assistantMessage]);

			const finalizeExecutingToolCalls = (
				assistantId: string,
				errorMsg: string,
			) => {
				setPendingMessages((prev) =>
					prev.map((m) => {
						if (m.messageId !== assistantId) return m;
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

			let abortedBySafetyTimer = false;
			try {
				const controller = new AbortController();
				setConversationAbortControllerState(streamConversationId, controller);

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
				let activeThinkId: string | null = null;
				let flushDeltaTimer: ReturnType<typeof setTimeout> | null = null;
				const FLUSH_VISIBLE_MS = 60;
				const FLUSH_HIDDEN_MS = 600;

				const ensureThinkStarted = () => {
					if (activeThinkId) return;
					activeThinkId =
						typeof crypto !== "undefined" && "randomUUID" in crypto
							? (crypto.randomUUID() as string)
							: `think-${Date.now()}`;
					deltaBufferRef.current += `\n\n<<think:${activeThinkId}>>\n`;
				};

				const closeThinkIfOpen = () => {
					if (!activeThinkId) return;
					deltaBufferRef.current += `\n<<think_end:${activeThinkId}>>\n\n`;
					activeThinkId = null;
				};

				const flushDeltaNow = () => {
					if (flushDeltaTimer) {
						clearTimeout(flushDeltaTimer);
						flushDeltaTimer = null;
					}
					const pendingText = deltaBufferRef.current;
					if (!pendingText) return;
					deltaBufferRef.current = "";
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantMessageId
								? {
										...m,
										content: (m.content ?? "") + pendingText,
										status: "sending" as const,
									}
								: m,
						),
					);
				};

				const scheduleFlush = () => {
					if (flushDeltaTimer) return;
					const delay = uiVisibleRef.current
						? FLUSH_VISIBLE_MS
						: FLUSH_HIDDEN_MS;
					flushDeltaTimer = setTimeout(flushDeltaNow, delay);
				};

				const IDLE_NO_TOOLS_MS = 30 * 1000;
				const IDLE_WITH_TOOLS_MS = 10 * 60 * 1000;
				const MAX_DURATION_MS = 60 * 60 * 1000;

				const safetyInterval = setInterval(() => {
					if (DISABLE_CLIENT_STREAM_TIMEOUT) return;
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
						if (evt.event === "ping") {
							lastEventTime = Date.now();
							continue;
						}
						if (evt.event === "start") {
							lastEventTime = Date.now();
							try {
								const payload = JSON.parse(evt.data) as {
									assistantMessageId?: unknown;
								};
								const nextAssistantMessageId =
									typeof payload.assistantMessageId === "string"
										? payload.assistantMessageId.trim()
										: "";
								if (
									nextAssistantMessageId.length > 0 &&
									assistantMessageId.startsWith("temp-")
								) {
									const previousId = assistantMessageId;
									setPendingMessages((prev) =>
										prev.map((m) =>
											m.messageId === previousId
												? { ...m, messageId: nextAssistantMessageId }
												: m,
										),
									);
									assistantMessageId = nextAssistantMessageId;
								}
							} catch {}
							continue;
						}

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
							closeThinkIfOpen();
							const payload = JSON.parse(evt.data) as { delta?: string };
							const delta =
								typeof payload.delta === "string" ? payload.delta : "";
							if (!delta) continue;
							deltaBufferRef.current += delta;
							scheduleFlush();
							continue;
						}

						if (evt.event === "reasoning-delta") {
							const payload = JSON.parse(evt.data) as { delta?: string };
							const delta =
								typeof payload.delta === "string" ? payload.delta : "";
							if (!delta) continue;
							ensureThinkStarted();
							deltaBufferRef.current += delta;
							scheduleFlush();
							continue;
						}

						if (evt.event === "tool-call") {
							closeThinkIfOpen();
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
							const marker = `\n\n<<tool:${payload.toolCallId}>>\n\n`;

							setPendingMessages((prev) =>
								prev.map((m) => {
									if (m.messageId !== assistantMessageId) return m;
									const existingContent = m.content ?? "";
									const content = existingContent.includes(marker)
										? existingContent
										: `${existingContent}${marker}`;
									const toolCalls = [...(m.toolCalls || [])];
									const existingIndex = toolCalls.findIndex(
										(tc) => tc.id === payload.toolCallId,
									);
									const existingToolCall =
										existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
									const nextToolCall: ToolCall = {
										id: payload.toolCallId,
										type: "function",
										status: "executing",
										executionId: existingToolCall?.executionId,
										result: existingToolCall?.result,
										function: {
											name: payload.toolName,
											arguments: argsText,
										},
									};

									if (existingIndex >= 0) {
										toolCalls[existingIndex] = {
											...existingToolCall,
											...nextToolCall,
											function: {
												name:
													nextToolCall.function.name ||
													existingToolCall?.function.name ||
													"tool",
												arguments:
													nextToolCall.function.arguments ||
													existingToolCall?.function.arguments ||
													"{}",
											},
										};
									} else {
										toolCalls.push(nextToolCall);
									}
									return {
										...m,
										content,
										toolCalls,
										status: "sending" as const,
									};
								}),
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
							closeThinkIfOpen();
							flushDeltaNow();
							const payload = JSON.parse(evt.data) as {
								toolCallId: string;
								toolName: string;
								result: unknown;
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
									if (m.messageId !== assistantMessageId) return m;
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
												arguments:
													toolCallArgsById.get(payload.toolCallId) || "{}",
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
							closeThinkIfOpen();
							flushDeltaNow();
							let realId = "";
							try {
								const payload = JSON.parse(evt.data) as {
									needsContinue?: boolean;
									finishReason?: string;
									messageId?: string;
								};
								setConversationCanContinueState(
									streamConversationId,
									payload.needsContinue === true,
								);
								realId =
									typeof payload.messageId === "string"
										? payload.messageId.trim()
										: "";
							} catch {}

							receivedDone = true;
							activeToolCallIds.clear();
							finalizeExecutingToolCalls(
								assistantMessageId,
								"settings.ai.errors.toolExecutionDidNotReturnResult",
							);
							setPendingMessages((prev) =>
								prev.map((m) =>
									m.messageId === assistantMessageId
										? { ...m, status: "sent" as const }
										: m,
								),
							);
							if (realId && realId !== assistantMessageId) {
								const previousId = assistantMessageId;
								const nextId = realId;
								setPendingMessages((prev) =>
									prev.map((m) =>
										m.messageId === previousId
											? { ...m, messageId: nextId, status: "sent" as const }
											: m,
									),
								);
								assistantMessageId = nextId;
							}
							break;
						}

						if (evt.event === "error" || evt.event === "stream-error") {
							closeThinkIfOpen();
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
					closeThinkIfOpen();
					flushDeltaNow();
					clearInterval(safetyInterval);
				}

				if (controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingError"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(assistantMessageId, errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantMessageId
									? { ...m, status: "error" as const, error: errorMsg }
									: m,
							),
						);
						setConversationAbortControllerState(streamConversationId, null);
						setConversationLoadingState(streamConversationId, false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantMessageId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				if (!controller.signal.aborted && !receivedDone) {
					flushDeltaNow();
					finalizeExecutingToolCalls(
						assistantMessageId,
						"settings.ai.errors.streamingError",
					);
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantMessageId
								? { ...m, status: "sent" as const }
								: m,
						),
					);
				}

				setConversationAbortControllerState(streamConversationId, null);
			} catch (error) {
				setConversationAbortControllerState(streamConversationId, null);
				if (isAbortLikeError(error)) {
					const errorMsg = abortedBySafetyTimer
						? "settings.ai.errors.streamingError"
						: "settings.ai.errors.streamingAborted";
					finalizeExecutingToolCalls(assistantMessageId, errorMsg);
					if (abortedBySafetyTimer) {
						setPendingMessages((prev) =>
							prev.map((m) =>
								m.messageId === assistantMessageId
									? { ...m, status: "error" as const, error: errorMsg }
									: m,
							),
						);
						setConversationLoadingState(streamConversationId, false);
						options.onError?.(new Error(errorMsg));
						return;
					}
					setPendingMessages((prev) =>
						prev.map((m) =>
							m.messageId === assistantMessageId
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
							m.messageId === assistantMessageId
								? { ...m, status: "error" as const, error: errorMsg }
								: m,
						),
					);
					setConversationLoadingState(streamConversationId, false);
					options.onError?.(error as Error);
					return;
				}
			}

			let didRefetch = false;
			try {
				const refetchPromise = refetchMessages()
					.then(() => true)
					.catch(() => false);
				didRefetch = await Promise.race([
					refetchPromise,
					new Promise<boolean>((resolve) =>
						setTimeout(() => resolve(false), 10000),
					),
				]);
			} finally {
				if (didRefetch) {
					const assistantId = assistantMessageId;
					setPendingMessages((prev) =>
						prev.filter((m) => m.messageId !== assistantId),
					);
				}
				setConversationLoadingState(streamConversationId, false);
			}
		},
		[
			conversationId,
			isLoading,
			options,
			refetchMessages,
			maybeInvalidateProjectQueries,
			setConversationAbortControllerState,
			setConversationCanContinueState,
			setConversationLoadingState,
		],
	);

	const reset = useCallback(() => {
		setAbortController(null);
		setIsLoading(false);
		setConversationId(undefined);
		agentRunIdByConversationRef.current = {};
		setConversationAbortControllerState(DRAFT_CONVERSATION_SCOPE_ID, null);
		setConversationLoadingState(DRAFT_CONVERSATION_SCOPE_ID, false);
		setConversationCanContinueState(DRAFT_CONVERSATION_SCOPE_ID, false);
		setConversationPendingApprovalState(DRAFT_CONVERSATION_SCOPE_ID, null);
		hasUserSetToolApprovalsDisabledRef.current = false;
		setAreToolApprovalsDisabled(false);
		hasUserSetToolBudgetModeRef.current = false;
		setToolBudgetModeState("max");
		setCanContinueChat(false);
		setPendingApproval(null);
	}, [
		setConversationAbortControllerState,
		setConversationCanContinueState,
		setConversationLoadingState,
		setConversationPendingApprovalState,
	]);

	const retryMessage = useCallback(
		async (messageId: string, aiId: string, isAgentMode = false) => {
			const retryContext = resolveRetryContext(messages, messageId);
			if (!retryContext) return;

			setPendingMessages((prev) =>
				prev.filter((m) => !retryContext.removeMessageIds.has(m.messageId)),
			);

			await send(
				retryContext.content,
				aiId,
				isAgentMode,
				retryContext.attachments,
			);
		},
		[messages, send],
	);

	const openConversation = useCallback((nextConversationId: string) => {
		const normalized = nextConversationId.trim();
		if (normalized.length === 0) return;

		hasUserSetToolApprovalsDisabledRef.current = false;
		setAreToolApprovalsDisabled(false);
		hasUserSetToolBudgetModeRef.current = false;
		setToolBudgetModeState("max");
		setConversationId(normalized);
	}, []);

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
