export type ReplayToolCallStatus =
	| "pending"
	| "approved"
	| "rejected"
	| "executing"
	| "completed"
	| "failed";

export type ReplayMessageStatus = "sending" | "sent" | "error";

export type ReplayToolCall = {
	id: string;
	type: "function";
	executionId?: string;
	status?: ReplayToolCallStatus;
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
};

export type ReplayBaseMessage = {
	messageId: string;
	runId?: string | null;
	sourceMessageId?: string | null;
	content?: string | null;
	reasoning?: string | null;
	toolCalls?: ReplayToolCall[] | null;
	status: ReplayMessageStatus;
	error?: string | null;
};

export type ParsedAgentEventMessage = {
	messageId: string;
	createdAt: string;
	payload: Record<string, unknown>;
};

export type ReplayedAgentDisplayMessage = {
	sourceMessageId: string | null;
	content: string | null;
	reasoning: string | null;
	toolCalls: ReplayToolCall[] | null | undefined;
	status: ReplayMessageStatus;
	error: string | null;
};

function normalizeReplayToolCallId(params: {
	executionId?: unknown;
	stepId?: unknown;
	messageId?: string;
	toolName?: string;
}) {
	const executionId =
		typeof params.executionId === "string" ? params.executionId.trim() : "";
	if (executionId.length > 0) return executionId;
	const stepId = typeof params.stepId === "string" ? params.stepId.trim() : "";
	if (stepId.length > 0) return stepId;
	const messageId =
		typeof params.messageId === "string" ? params.messageId.trim() : "";
	if (messageId.length > 0) return `agent-${messageId}`;
	const toolName =
		typeof params.toolName === "string" && params.toolName.trim().length > 0
			? params.toolName.trim()
			: "tool";
	return `agent-${toolName}`;
}

function parseAgentEventPreviewValue(preview: unknown): unknown {
	if (typeof preview !== "string") return undefined;
	const trimmed = preview.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
}

function upsertReplayDisplayToolCall(params: {
	toolCalls: ReplayToolCall[];
	toolCallId: string;
	toolName: string;
	executionId?: string;
	status: ReplayToolCallStatus;
	argumentsText?: string;
	result?: ReplayToolCall["result"];
}): ReplayToolCall[] {
	const toolCalls: ReplayToolCall[] = params.toolCalls.map((toolCall) => ({
		...toolCall,
		function: { ...toolCall.function },
		result: toolCall.result ? { ...toolCall.result } : undefined,
	}));
	const existingIndex = toolCalls.findIndex(
		(toolCall) => toolCall.id === params.toolCallId,
	);
	const base = existingIndex >= 0 ? toolCalls[existingIndex] : undefined;
	const nextToolCall: ReplayToolCall = {
		id: params.toolCallId,
		type: "function",
		executionId: params.executionId,
		status: params.status,
		result: params.result,
		function: {
			name: params.toolName || base?.function.name || "tool",
			arguments: params.argumentsText ?? base?.function.arguments ?? "{}",
		},
	};
	if (existingIndex >= 0 && base) {
		toolCalls[existingIndex] = {
			...base,
			...nextToolCall,
			function: {
				name: nextToolCall.function.name || base.function.name || "tool",
				arguments:
					nextToolCall.function.arguments || base.function.arguments || "{}",
			},
			result: nextToolCall.result ?? base.result,
		};
		return toolCalls;
	}
	toolCalls.push(nextToolCall);
	return toolCalls;
}

export function buildAgentDisplayMessageFromEvents(params: {
	baseMessage: ReplayBaseMessage;
	sourceMessageId?: string | null;
	eventMessages: ParsedAgentEventMessage[];
}): ReplayedAgentDisplayMessage | null {
	const runId =
		typeof params.baseMessage.runId === "string"
			? params.baseMessage.runId.trim()
			: "";
	if (!runId) return null;
	const orderedEvents = [...params.eventMessages].sort((left, right) => {
		const leftTime = Date.parse(left.createdAt ?? "");
		const rightTime = Date.parse(right.createdAt ?? "");
		if (
			Number.isFinite(leftTime) &&
			Number.isFinite(rightTime) &&
			leftTime !== rightTime
		) {
			return leftTime - rightTime;
		}
		return left.messageId.localeCompare(right.messageId);
	});

	let contentBuffer = "";
	let lastOutputText = "";
	let reasoning = params.baseMessage.reasoning ?? null;
	let lastReasoningText = typeof reasoning === "string" ? reasoning : "";
	let toolCalls: ReplayToolCall[] = Array.isArray(params.baseMessage.toolCalls)
		? params.baseMessage.toolCalls.map((toolCall) => ({
				...toolCall,
				function: { ...toolCall.function },
				result: toolCall.result ? { ...toolCall.result } : undefined,
			}))
		: [];
	let status: ReplayMessageStatus = params.baseMessage.status;
	let error = params.baseMessage.error ?? null;

	for (const eventMessage of orderedEvents) {
		const payload = eventMessage.payload;
		const eventType = typeof payload.type === "string" ? payload.type : "";
		const eventRunId =
			typeof payload.runId === "string" ? payload.runId.trim() : "";
		if (eventRunId.length > 0 && eventRunId !== runId) continue;

		if (eventType === "agent.output.delta") {
			const text = typeof payload.delta === "string" ? payload.delta : "";
			if (text.length === 0 || text === lastOutputText) continue;
			const previous = lastOutputText;
			lastOutputText = text;
			const delta = text.startsWith(previous)
				? text.slice(previous.length)
				: previous.startsWith(text)
					? ""
					: text;
			if (delta.length === 0) continue;
			contentBuffer += delta;
			status = "sending";
			continue;
		}

		if (eventType === "agent.output.reasoning") {
			const text = typeof payload.text === "string" ? payload.text : "";
			if (text.length === 0 || text === lastReasoningText) continue;
			lastReasoningText = text;
			reasoning = text;
			status = "sending";
			continue;
		}

		if (eventType === "agent.step.start") {
			const toolName =
				typeof payload.toolName === "string" ? payload.toolName : "tool";
			const executionId =
				typeof payload.executionId === "string" &&
				payload.executionId.trim().length > 0
					? payload.executionId.trim()
					: undefined;
			toolCalls = upsertReplayDisplayToolCall({
				toolCalls,
				toolCallId: normalizeReplayToolCallId({
					executionId: payload.executionId,
					stepId: payload.stepId,
					messageId: eventMessage.messageId,
					toolName,
				}),
				toolName,
				executionId,
				status: "executing",
				argumentsText:
					typeof payload.parametersPreview === "string" &&
					payload.parametersPreview.trim().length > 0
						? payload.parametersPreview
						: "{}",
			});
			status = "sending";
			continue;
		}

		if (eventType === "agent.step.result") {
			const toolName =
				typeof payload.toolName === "string" ? payload.toolName : "tool";
			const success =
				typeof payload.success === "boolean" ? payload.success : false;
			const summary =
				typeof payload.summary === "string" ? payload.summary : "";
			const executionId =
				typeof payload.executionId === "string" &&
				payload.executionId.trim().length > 0
					? payload.executionId.trim()
					: undefined;
			toolCalls = upsertReplayDisplayToolCall({
				toolCalls,
				toolCallId: normalizeReplayToolCallId({
					executionId: payload.executionId,
					stepId: payload.stepId,
					messageId: eventMessage.messageId,
					toolName,
				}),
				toolName,
				executionId,
				status: success ? "completed" : "failed",
				result: {
					success,
					message: summary || undefined,
					data: parseAgentEventPreviewValue(payload.dataPreview),
					error: success ? undefined : summary || undefined,
				},
			});
			status = "sending";
			continue;
		}

		if (eventType === "agent.step.wait_approval") {
			const toolName =
				typeof payload.toolName === "string" ? payload.toolName : "tool";
			const executionId =
				typeof payload.executionId === "string" &&
				payload.executionId.trim().length > 0
					? payload.executionId.trim()
					: undefined;
			toolCalls = upsertReplayDisplayToolCall({
				toolCalls,
				toolCallId: normalizeReplayToolCallId({
					executionId: payload.executionId,
					stepId: payload.stepId,
					messageId: eventMessage.messageId,
					toolName,
				}),
				toolName,
				executionId,
				status: "pending",
				argumentsText:
					typeof payload.parametersPreview === "string" &&
					payload.parametersPreview.trim().length > 0
						? payload.parametersPreview
						: "{}",
			});
			status = "sending";
			continue;
		}

		if (eventType === "agent.run.finish") {
			const finishStatus =
				typeof payload.status === "string" ? payload.status : "";
			if (finishStatus === "completed") {
				status = "sent";
				error = null;
			} else if (finishStatus === "failed" || finishStatus === "cancelled") {
				status = "error";
				if (
					typeof payload.error === "string" &&
					payload.error.trim().length > 0
				) {
					error = payload.error;
				}
			}
		}
	}

	const content =
		typeof params.baseMessage.content === "string" &&
		params.baseMessage.content.length > 0
			? params.baseMessage.content
			: contentBuffer.length > 0
				? contentBuffer
				: (params.baseMessage.content ?? null);
	const sourceMessageId =
		typeof params.baseMessage.sourceMessageId === "string" &&
		params.baseMessage.sourceMessageId.trim().length > 0
			? params.baseMessage.sourceMessageId.trim()
			: typeof params.sourceMessageId === "string" &&
					params.sourceMessageId.trim().length > 0
				? params.sourceMessageId.trim()
				: params.baseMessage.messageId;

	return {
		sourceMessageId,
		content,
		reasoning,
		toolCalls: toolCalls.length > 0 ? toolCalls : params.baseMessage.toolCalls,
		status,
		error,
	};
}
