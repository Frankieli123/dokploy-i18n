"use client";

import {
	AlertCircle,
	AlertTriangle,
	Bot,
	Brain,
	ChevronDown,
	ChevronRight,
	Loader2,
	RotateCcw,
	Sparkles,
	User,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { translateErrorMessage } from "@/utils/error-translation";
import { ToolCallBlock } from "./tool-call-block";
import { ToolGroup } from "./tool-call-group";
import type { Message, ToolCall } from "./use-chat";

const assistantHeadingClassName =
	"break-words [overflow-wrap:anywhere] text-sm font-semibold leading-relaxed mb-2 mt-3 first:mt-0";

const assistantMarkdownComponents: Components = {
	p: ({ children }) => (
		<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed mb-2 last:mb-0">
			{children}
		</p>
	),
	h1: ({ children }) => <h1 className={assistantHeadingClassName}>{children}</h1>,
	h2: ({ children }) => <h2 className={assistantHeadingClassName}>{children}</h2>,
	h3: ({ children }) => <h3 className={assistantHeadingClassName}>{children}</h3>,
	h4: ({ children }) => <h4 className={assistantHeadingClassName}>{children}</h4>,
	h5: ({ children }) => <h5 className={assistantHeadingClassName}>{children}</h5>,
	h6: ({ children }) => <h6 className={assistantHeadingClassName}>{children}</h6>,
	ul: ({ children }) => (
		<ul className="list-disc pl-5 space-y-1 mb-2 last:mb-0">{children}</ul>
	),
	ol: ({ children }) => (
		<ol className="list-decimal pl-5 space-y-1 mb-2 last:mb-0">{children}</ol>
	),
	li: ({ children }) => (
		<li className="break-words [overflow-wrap:anywhere] [&>p]:mb-1 [&>p]:mt-0 [&>ul]:mt-1 [&>ol]:mt-1">
			{children}
		</li>
	),
	a: ({ href, children }) => (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="underline underline-offset-4 break-words [overflow-wrap:anywhere]"
		>
			{children}
		</a>
	),
	code: ({ className, children }) => {
		const text =
			typeof children === "string"
				? children
				: Array.isArray(children)
					? children
							.filter((c): c is string => typeof c === "string")
							.join("")
					: "";
		const isProbablyBlock =
			typeof className === "string" &&
			className.toLowerCase().includes("language-");
		const isBlock = isProbablyBlock || text.includes("\n");

		if (!isBlock) {
			return (
				<code
					className={cn(
						"rounded bg-background/60 px-1 py-0.5 font-mono text-[0.85em] break-words [overflow-wrap:anywhere]",
						className,
					)}
				>
					{children}
				</code>
			);
		}
		return (
			<code
				className={cn(
					"font-mono text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
					className,
				)}
			>
				{children}
			</code>
		);
	},
	pre: ({ children }) => (
		<pre className="my-2 max-w-full overflow-x-auto rounded-md border border-border/50 bg-background/40 p-2 text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
			{children}
		</pre>
	),
	blockquote: ({ children }) => (
		<blockquote className="border-l-2 border-border/60 pl-3 italic text-muted-foreground mb-2 last:mb-0">
			{children}
		</blockquote>
	),
};

type WaterfallPart =
	| { type: "text"; value: string }
	| { type: "tool"; toolCallId: string };

function splitByToolMarkers(input: string): WaterfallPart[] {
	const normalized = String(input ?? "")
		.replace(/\r\n/g, "\n")
		.replace(/<<tool:[^>]*$/, "");

	const out: WaterfallPart[] = [];
	const re = /<<tool:([^>]+)>>/g;
	let lastIndex = 0;

	const pushText = (text: string) => {
		const trimmedEdges = text.replace(/^\n+/, "").replace(/\n+$/, "");
		if (trimmedEdges.trim().length === 0) return;
		out.push({ type: "text", value: trimmedEdges.replace(/\n{3,}/g, "\n\n") });
	};

	while (true) {
		const match = re.exec(normalized);
		if (!match) break;
		if (match.index > lastIndex) {
			pushText(normalized.slice(lastIndex, match.index));
		}
		const toolCallId = match[1]?.trim();
		if (toolCallId) out.push({ type: "tool", toolCallId });
		lastIndex = re.lastIndex;
	}

	if (lastIndex < normalized.length) {
		pushText(normalized.slice(lastIndex));
	}

	return out.length > 0 ? out : [{ type: "text", value: normalized }];
}

function getEffectiveExecutionId(toolCall: ToolCall): string {
	if (typeof toolCall.executionId === "string" && toolCall.executionId.length > 0) {
		return toolCall.executionId;
	}
	const data = toolCall.result?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return "";
	const v = (data as { executionId?: unknown }).executionId;
	return typeof v === "string" && v.length > 0 ? v : "";
}

function getEffectiveToolStatus(
	toolCall: ToolCall,
	executionId: string,
): NonNullable<Parameters<typeof ToolCallBlock>[0]["status"]> {
	return toolCall.status ?? (executionId.length > 0 ? "executing" : "completed");
}

interface MessageBubbleProps {
	message: Message;
	onApproveToolCall?: (toolCallId: string) => void;
	onRejectToolCall?: (toolCallId: string) => void;
	isLast?: boolean;
	onRetry?: () => void;
	areToolApprovalsDisabled?: boolean;
}

export function MessageBubble({
	message,
	onApproveToolCall,
	onRejectToolCall,
	isLast,
	onRetry,
	areToolApprovalsDisabled,
}: MessageBubbleProps) {
	const { t } = useTranslation("common");
	const [isReasoningExpanded, setIsReasoningExpanded] = useState(false);

	if (message.role === "system") {
		return null;
	}
	const [displayedContent, setDisplayedContent] = useState(() => {
		const initialContent = message.content ?? "";
		return message.role === "user" ||
			!message.status ||
			message.status === "sent" ||
			message.status === "error"
			? initialContent
			: "";
	});

	const isUser = message.role === "user";
	const isError = message.status === "error";
	const isSending = message.status === "sending";
	const attachments = Array.isArray(message.attachments) ? message.attachments : [];
	const hasAttachments = attachments.length > 0;
	const reasoningText =
		typeof message.reasoning === "string" ? message.reasoning : "";
	const hasReasoning = !isUser && reasoningText.trim().length > 0;
	const bubbleText = (() => {
		if (isUser) return message.content ?? "";
		return displayedContent;
	})();

	const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
	const hasToolCalls = toolCalls.length > 0;
	const waterfallParts = isUser
		? ([{ type: "text", value: bubbleText }] satisfies WaterfallPart[])
		: splitByToolMarkers(bubbleText);
	const hasToolMarkers = !isUser && waterfallParts.some((p) => p.type === "tool");
	const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc] as const));
	const markerToolCallIds = new Set(
		waterfallParts
			.filter((p): p is Extract<WaterfallPart, { type: "tool" }> => p.type === "tool")
			.map((p) => p.toolCallId),
	);
	const orphanToolCalls = hasToolMarkers
		? toolCalls.filter((tc) => !markerToolCallIds.has(tc.id))
		: toolCalls;

	const approveHandler = areToolApprovalsDisabled ? undefined : onApproveToolCall;
	const rejectHandler = areToolApprovalsDisabled ? undefined : onRejectToolCall;

	const renderToolCallCard = (toolCall: ToolCall, key: string) => {
		const effectiveExecutionId = getEffectiveExecutionId(toolCall);
		const status = getEffectiveToolStatus(toolCall, effectiveExecutionId);
		const canApprove =
			status === "pending" &&
			effectiveExecutionId.length > 0 &&
			!!approveHandler &&
			!!rejectHandler;

		return (
			<ToolCallBlock
				key={key}
				toolCall={toolCall}
				status={status}
				result={toolCall.result}
				executionId={
					effectiveExecutionId.length > 0 ? effectiveExecutionId : undefined
				}
				onApprove={canApprove ? () => approveHandler?.(toolCall.id) : undefined}
				onReject={canApprove ? () => rejectHandler?.(toolCall.id) : undefined}
			/>
		);
	};

	const renderToolCalls = (
		calls: ToolCall[],
		keyPrefix: string,
	) => {
		if (calls.length === 0) return null;
		if (calls.length > 1) {
			return (
				<ToolGroup
					toolCalls={calls}
					onApproveToolCall={approveHandler}
					onRejectToolCall={rejectHandler}
				/>
			);
		}
		const only = calls[0];
		if (!only) return null;
		return renderToolCallCard(only, `${keyPrefix}-${only.id}`);
	};

	const lastStreamingTextIdx = (() => {
		if (!isSending) return -1;
		for (let i = waterfallParts.length - 1; i >= 0; i--) {
			const part = waterfallParts[i];
			if (!part) continue;
			if (part.type === "text" && part.value.trim().length > 0) return i;
		}
		return -1;
	})();

	const shouldShowEmptyAssistantFallback =
		!isUser &&
		!isSending &&
		!isError &&
		!hasToolCalls &&
		!hasReasoning &&
		(!bubbleText || bubbleText.length === 0) &&
		!!isLast;

	useEffect(() => {
		if (isUser) return;
		const content = message.content ?? "";
		if (content.length === 0) return;

		if (!isSending && !isLast && displayedContent.length === 0) {
			setDisplayedContent(content);
			return;
		}

		if (!isSending && displayedContent === content) return;

		// During streaming, update content directly without typewriter effect
		if (isSending) {
			setDisplayedContent(content);
			return;
		}

		if (displayedContent.length < content.length) {
			const timeout = setTimeout(() => {
				setDisplayedContent((prev) => content.slice(0, prev.length + 3));
			}, 10);
			return () => clearTimeout(timeout);
		}
	}, [message.content, isSending, displayedContent, isUser, isLast]);

	return (
		<div className="flex gap-3 py-3">
			<div
				className={cn(
					"flex h-8 w-8 shrink-0 items-center justify-center rounded-full border shadow-sm",
					isUser
						? "bg-primary text-primary-foreground border-primary"
						: "bg-background text-muted-foreground border-border",
					isError && "bg-destructive/10 border-destructive/20 text-destructive",
				)}
			>
				{isUser ? (
					isError ? (
						<AlertCircle className="h-4 w-4" />
					) : (
						<User className="h-4 w-4" />
					)
				) : (
					<Bot className="h-4 w-4" />
				)}
			</div>
			<div
				className={cn(
					"flex w-full min-w-0 flex-col gap-2",
				)}
			>
				{hasAttachments && (
					<div
						className={cn(
							"grid gap-2",
							attachments.length > 1 ? "grid-cols-2" : "grid-cols-1",
						)}
					>
						{attachments.map((att, idx) => {
							if (!att || att.type !== "image") return null;
							if (!att.data || !att.mediaType) return null;
							const src = `data:${att.mediaType};base64,${att.data}`;
							/* biome-ignore lint/performance/noImgElement: inline image previews */
							return (
								<img
									key={`${att.name ?? "image"}-${idx}`}
									src={src}
									alt={att.name ?? "attachment"}
									className={cn("w-full rounded-lg border border-border/50 object-cover")}
								/>
							);
						})}
					</div>
				)}

				{hasReasoning && (
					<div>
						<button
							type="button"
							onClick={() => setIsReasoningExpanded((v) => !v)}
							aria-expanded={isReasoningExpanded}
							aria-controls={`reasoning-${message.messageId}`}
							className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors select-none"
						>
							{isReasoningExpanded ? (
								<ChevronDown className="h-3 w-3" />
							) : (
								<ChevronRight className="h-3 w-3" />
							)}
							<Brain className="h-3 w-3" />
							<span className="font-medium">{t("ai.chat.reasoning")}</span>
						</button>
						{isReasoningExpanded && (
							<div
								id={`reasoning-${message.messageId}`}
								className="mt-1 pl-2 border-l-2 border-border/50"
							>
								<p className="text-xs text-muted-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">
									{reasoningText}
								</p>
							</div>
						)}
					</div>
				)}

				{!isUser && !hasToolMarkers && hasToolCalls && (
					<div className="w-full max-w-full min-w-0 overflow-hidden space-y-1">
						{renderToolCalls(orphanToolCalls, "toolcalls")}
					</div>
				)}

				<div className={cn(isUser && "rounded-xl border bg-muted/30 px-3 py-2.5")}>
					{isUser ? (
						<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed text-sm">
							{bubbleText}
						</p>
					) : shouldShowEmptyAssistantFallback ? (
						<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed text-sm">
							{t("common.unknownError")}
						</p>
					) : (
						<div className="space-y-2">
							{waterfallParts.map((part, idx) => {
								if (part.type === "tool") {
									const toolCall = toolCallById.get(part.toolCallId);
									return toolCall
										? renderToolCallCard(toolCall, `tool-${toolCall.id}-${idx}`)
										: null;
								}

								const text = part.value;
								if (text.trim().length === 0) return null;

								if (isSending) {
									return (
										<p
											// biome-ignore lint/suspicious/noArrayIndexKey: marker split is deterministic per message
											key={`text-${idx}`}
											className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed text-sm"
										>
											{text}
											{idx === lastStreamingTextIdx && (
												<span className="inline-block w-[2px] h-4 ml-1 bg-current align-middle animate-pulse" />
											)}
										</p>
									);
								}

								return (
									<ReactMarkdown
										// biome-ignore lint/suspicious/noArrayIndexKey: marker split is deterministic per message
										key={`text-${idx}`}
										skipHtml
										components={assistantMarkdownComponents}
									>
										{text}
									</ReactMarkdown>
								);
							})}

							{isSending && lastStreamingTextIdx === -1 && !hasToolCalls && !hasReasoning && (
								<div className="inline-flex items-center gap-1 h-4">
									<span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.3s]" />
									<span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.15s]" />
									<span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" />
								</div>
							)}

							{hasToolMarkers && orphanToolCalls.length > 0 && (
								<div className="w-full max-w-full min-w-0 overflow-hidden space-y-1">
									{renderToolCalls(orphanToolCalls, "orphan")}
								</div>
							)}
						</div>
					)}

					{isError && message.error && (
						<div className="mt-2 flex items-start gap-2 rounded bg-destructive/10 p-2 text-xs">
							<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
							<span>{translateErrorMessage(message.error, t)}</span>
						</div>
					)}
				</div>

				<div className="flex items-center gap-2">
					{isSending && isUser && (
						<Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
					)}
					{isSending && !isUser && (
						<Sparkles className="h-3 w-3 animate-pulse text-primary/70" />
					)}
					<span
						className={cn(
							"text-xs text-muted-foreground",
							isError && "text-destructive",
						)}
					>
						{isError
							? t("ai.chat.failedToSend")
							: new Date(message.createdAt).toLocaleTimeString([], {
									hour: "2-digit",
									minute: "2-digit",
								})}
					</span>
					{isError && onRetry && (
						<Button
							variant="ghost"
							size="sm"
							onClick={onRetry}
							className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
						>
							<RotateCcw className="mr-1.5 h-3 w-3" />
							{t("ai.chat.retry")}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
}
