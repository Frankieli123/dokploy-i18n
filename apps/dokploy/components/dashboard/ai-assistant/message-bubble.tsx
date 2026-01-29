"use client";

import {
	AlertCircle,
	AlertTriangle,
	Bot,
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
import type { Message } from "./use-chat";

const assistantMarkdownComponents: Components = {
	p: ({ children }) => (
		<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed mb-2 last:mb-0">
			{children}
		</p>
	),
	ul: ({ children }) => (
		<ul className="list-disc pl-5 space-y-1 mb-2 last:mb-0">{children}</ul>
	),
	ol: ({ children }) => (
		<ol className="list-decimal pl-5 space-y-1 mb-2 last:mb-0">{children}</ol>
	),
	li: ({ children }) => (
		<li className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
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
	const hasToolCalls = message.toolCalls && message.toolCalls.length > 0;
	const attachments = Array.isArray(message.attachments) ? message.attachments : [];
	const hasAttachments = attachments.length > 0;
	const bubbleText = (() => {
		if (isUser) return message.content ?? "";
		return displayedContent;
	})();

	const shouldShowEmptyAssistantFallback =
		!isUser &&
		!isSending &&
		!isError &&
		!hasToolCalls &&
		(!bubbleText || bubbleText.length === 0) &&
		!!isLast;
	const shouldRenderBubble =
		(bubbleText && bubbleText.length > 0) ||
		hasAttachments ||
		isSending ||
		isError ||
		shouldShowEmptyAssistantFallback;

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
		<div className={cn("flex gap-3 p-4", isUser && "flex-row-reverse")}>
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
					"flex w-full max-w-[85%] min-w-0 flex-col gap-1",
					isUser && "items-end",
				)}
			>
				{shouldRenderBubble && (
					<div
						className={cn(
							"w-fit max-w-full rounded-2xl px-4 py-2.5 text-sm shadow-sm",
							isUser
								? "bg-primary text-primary-foreground rounded-tr-sm"
								: "bg-muted/50 text-foreground border border-border/50 rounded-tl-sm",
							isError &&
								"bg-destructive/10 text-destructive border-destructive/20 shadow-none",
							isSending && "animate-pulse",
						)}
					>
						{hasAttachments && (
							<div
								className={cn(
									"grid gap-2 mb-2 last:mb-0",
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
											className={cn(
												"w-full rounded-md border border-border/50 object-cover",
												isUser && "border-primary/20",
											)}
										/>
									);
								})}
							</div>
						)}
						{isUser || shouldShowEmptyAssistantFallback || isSending ? (
							bubbleText.length > 0 ||
							shouldShowEmptyAssistantFallback ||
							(isSending && !isUser) ? (
								<p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed">
									{shouldShowEmptyAssistantFallback
										? t("common.unknownError")
										: bubbleText}
									{!isUser &&
										isSending &&
										(bubbleText.length === 0 ? (
											<span className="inline-flex items-center gap-1 h-4 ml-1 align-middle">
												<span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.3s]" />
												<span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce [animation-delay:-0.15s]" />
												<span className="w-1.5 h-1.5 bg-current rounded-full animate-bounce" />
											</span>
										) : (
											<span className="inline-block w-[2px] h-4 ml-1 bg-current align-middle animate-pulse" />
										))}
								</p>
							) : null
						) : (
							<ReactMarkdown
								skipHtml
								components={assistantMarkdownComponents}
							>
								{bubbleText}
							</ReactMarkdown>
						)}
						{isError && message.error && (
							<div className="mt-2 flex items-start gap-2 rounded bg-destructive/10 p-2 text-xs">
								<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
								<span>{translateErrorMessage(message.error, t)}</span>
							</div>
						)}
					</div>
				)}

				{hasToolCalls && !areToolApprovalsDisabled && (
					<div className="w-full max-w-full min-w-0 overflow-hidden space-y-1">
						{message.toolCalls!.length > 1 ? (
							<ToolGroup
								toolCalls={message.toolCalls!}
								onApproveToolCall={onApproveToolCall}
								onRejectToolCall={onRejectToolCall}
							/>
						) : (
							message.toolCalls!.map((toolCall) => {
								const effectiveExecutionId = (() => {
									if (
										typeof toolCall.executionId === "string" &&
										toolCall.executionId.length > 0
									) {
										return toolCall.executionId;
									}
									const data = toolCall.result?.data;
									if (
										!data ||
										typeof data !== "object" ||
										Array.isArray(data)
									) {
										return "";
									}
									const v = (data as { executionId?: unknown }).executionId;
									return typeof v === "string" && v.length > 0 ? v : "";
								})();
								const status =
									toolCall.status ??
									(effectiveExecutionId.length > 0 ? "executing" : "completed");
								const canApprove =
									status === "pending" &&
									effectiveExecutionId.length > 0 &&
									!!onApproveToolCall &&
									!!onRejectToolCall;

								return (
									<ToolCallBlock
										key={toolCall.id}
										toolCall={toolCall}
										status={status}
										result={toolCall.result}
										executionId={
											effectiveExecutionId.length > 0
												? effectiveExecutionId
												: undefined
										}
										onApprove={
											canApprove
												? () => onApproveToolCall?.(toolCall.id)
												: undefined
										}
										onReject={
											canApprove
												? () => onRejectToolCall?.(toolCall.id)
												: undefined
										}
									/>
								);
							})
						)}
					</div>
				)}

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
