"use client";

import {
	AlertCircle,
	AlertTriangle,
	Bot,
	CheckCircle2,
	ListChecks,
	Loader2,
	RotateCcw,
	Sparkles,
	User,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { translateErrorMessage } from "@/utils/error-translation";
import { ToolCallBlock } from "./tool-call-block";
import { ToolGroup } from "./tool-call-group";
import type { Message, ToolCall } from "./use-chat";

interface MessageBubbleProps {
	message: Message;
	onApproveToolCall?: (toolCallId: string) => void;
	onRejectToolCall?: (toolCallId: string) => void;
	onApproveExecution?: (executionId: string) => void;
	onRejectExecution?: (executionId: string) => void;
	isLast?: boolean;
	onRetry?: () => void;
}

export function MessageBubble({
	message,
	onApproveToolCall,
	onRejectToolCall,
	onApproveExecution,
	onRejectExecution,
	isLast,
	onRetry,
}: MessageBubbleProps) {
	const { t } = useTranslation("common");

	const agentEvent = (() => {
		if (message.role !== "system") return null;
		const raw = message.content ?? "";
		if (!raw || raw.trim().length === 0) return null;
		try {
			const parsed = JSON.parse(raw) as {
				type?: unknown;
				runId?: unknown;
				goal?: unknown;
				steps?: unknown;
				stepId?: unknown;
				executionId?: unknown;
				toolName?: unknown;
				description?: unknown;
				requiresApproval?: unknown;
				success?: unknown;
				summary?: unknown;
				status?: unknown;
				parametersPreview?: unknown;
			};
			if (typeof parsed?.type !== "string") return null;
			if (!parsed.type.startsWith("agent.")) return null;
			return parsed;
		} catch {
			return null;
		}
	})();
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
	const bubbleText = (() => {
		if (isUser) return message.content ?? "";
		if (!agentEvent) return displayedContent;
		const type = agentEvent.type as string;
		if (type === "agent.run.start") {
			const goal = typeof agentEvent.goal === "string" ? agentEvent.goal : "";
			return goal
				? `${t("ai.agent.start", "Start Agent")}: ${goal}`
				: "Agent started";
		}
		if (type === "agent.plan") {
			const steps = Array.isArray(agentEvent.steps) ? agentEvent.steps : [];
			const lines = steps
				.map((s, idx) => {
					if (s && typeof s === "object" && "description" in (s as any)) {
						const d = (s as any).description;
						return `${idx + 1}. ${typeof d === "string" ? d : ""}`.trim();
					}
					return `${idx + 1}.`;
				})
				.filter((x) => x.trim().length > 0)
				.join("\n");
			return lines.length > 0
				? `${t("ai.agent.plan", "Plan")}:\n${lines}`
				: t("ai.agent.plan", "Plan");
		}
		if (type === "agent.step.start") {
			const d =
				typeof agentEvent.description === "string"
					? agentEvent.description
					: "";
			const toolName =
				typeof agentEvent.toolName === "string" ? agentEvent.toolName : "";
			return d
				? `${t("ai.agent.step", "Step")}: ${d}${toolName ? ` (${toolName})` : ""}`
				: `${t("ai.agent.step", "Step")}${toolName ? `: ${toolName}` : ""}`;
		}
		if (type === "agent.step.wait_approval") {
			const toolName =
				typeof agentEvent.toolName === "string" ? agentEvent.toolName : "";
			return toolName
				? `${t("ai.toolCall.pendingApproval")}: ${toolName}`
				: t("ai.toolCall.pendingApproval");
		}
		if (type === "agent.step.result") {
			const summary =
				typeof agentEvent.summary === "string" ? agentEvent.summary : "";
			const success =
				typeof agentEvent.success === "boolean"
					? agentEvent.success
					: undefined;
			if (typeof success === "boolean") {
				return summary
					? `${success ? t("status.success", "Success") : t("status.failed", "Failed")}: ${summary}`
					: success
						? t("status.success", "Success")
						: t("status.failed", "Failed");
			}
			return summary || t("ai.agent.result", "Result");
		}
		if (type === "agent.run.finish") {
			const status =
				typeof agentEvent.status === "string" ? agentEvent.status : "";
			return status
				? `${t("ai.agent.finished", "Finished")}: ${status}`
				: t("ai.agent.finished", "Finished");
		}
		if (type === "agent.run.summary") {
			const summary =
				typeof agentEvent.summary === "string" ? agentEvent.summary : "";
			return summary || t("ai.agent.summary", "Summary");
		}
		return displayedContent;
	})();

	const agentStructuredContent = (() => {
		if (!agentEvent) return null;
		const type = agentEvent.type as string;

		if (type === "agent.plan") {
			const steps = Array.isArray(agentEvent.steps) ? agentEvent.steps : [];
			const normalized = steps
				.map((s) => {
					if (!s || typeof s !== "object") {
						return { description: "", toolName: "" };
					}
					const anyStep = s as Record<string, unknown>;
					return {
						description:
							typeof anyStep.description === "string"
								? anyStep.description
								: "",
						toolName:
							typeof anyStep.toolName === "string" ? anyStep.toolName : "",
					};
				})
				.filter((x) => x.description.trim().length > 0);

			return (
				<div className="w-full rounded-md border bg-card overflow-hidden shadow-sm">
					<div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/10">
						<ListChecks className="h-4 w-4 text-muted-foreground" />
						<span className="text-xs font-medium text-foreground">
							{t("ai.agent.plan", "Plan")}
						</span>
					</div>
					<div className="px-3 py-2 space-y-2">
						{normalized.map((step, idx) => (
							<div key={idx} className="flex items-start gap-2">
								<span className="mt-0.5 w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
									{idx + 1}.
								</span>
								<span className="flex-1 min-w-0 text-sm text-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
									{step.description}
								</span>
								{step.toolName && (
									<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
										{step.toolName}
									</span>
								)}
							</div>
						))}
						{normalized.length === 0 && (
							<span className="text-xs text-muted-foreground">
								{t("ai.agent.plan", "Plan")}
							</span>
						)}
					</div>
				</div>
			);
		}

		if (type === "agent.step.start") {
			const description =
				typeof agentEvent.description === "string"
					? agentEvent.description
					: "";
			const toolName =
				typeof agentEvent.toolName === "string" ? agentEvent.toolName : "";
			const title = t("ai.agent.step", "Step");

			return (
				<div className="w-full rounded-md border bg-card overflow-hidden shadow-sm">
					<div className="flex items-center gap-2 px-3 py-2 border-b bg-blue-50/50 dark:bg-blue-900/10">
						<Loader2 className="h-4 w-4 text-blue-500 animate-spin" />
						<span className="text-xs font-medium text-foreground">{title}</span>
						{toolName && (
							<span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
								{toolName}
							</span>
						)}
					</div>
					{description && (
						<div className="px-3 py-2 text-sm text-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
							{description}
						</div>
					)}
					{!description && toolName && (
						<div className="px-3 py-2 text-sm text-muted-foreground">
							{toolName}
						</div>
					)}
				</div>
			);
		}

		if (type === "agent.step.result") {
			const summary =
				typeof agentEvent.summary === "string" ? agentEvent.summary : "";
			const success =
				typeof agentEvent.success === "boolean"
					? agentEvent.success
					: undefined;
			const statusLabel =
				success === true
					? t("status.success", "Success")
					: success === false
						? t("status.failed", "Failed")
						: t("ai.agent.result", "Result");
			const containerClass =
				success === true
					? "bg-emerald-500/5 border-emerald-500/20"
					: success === false
						? "bg-destructive/5 border-destructive/20"
						: "bg-card border-border";
			const iconClass =
				success === true
					? "text-emerald-500"
					: success === false
						? "text-destructive"
						: "text-muted-foreground";

			return (
				<div
					className={cn(
						"w-full rounded-md border overflow-hidden shadow-sm",
						containerClass,
					)}
				>
					<div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
						{success === true ? (
							<CheckCircle2 className={cn("h-4 w-4", iconClass)} />
						) : (
							<AlertCircle className={cn("h-4 w-4", iconClass)} />
						)}
						<span className="text-xs font-medium text-foreground">
							{t("ai.agent.result", "Result")}
						</span>
						<span className={cn("text-[10px] font-medium", iconClass)}>
							{statusLabel}
						</span>
					</div>
					{summary && (
						<div className="px-3 py-2 text-sm text-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
							{summary}
						</div>
					)}
				</div>
			);
		}

		if (type === "agent.step.wait_approval") {
			const executionId =
				typeof agentEvent.executionId === "string"
					? agentEvent.executionId
					: "";
			const toolName =
				typeof agentEvent.toolName === "string" ? agentEvent.toolName : "";
			const preview =
				typeof agentEvent.parametersPreview === "string"
					? agentEvent.parametersPreview
					: "";
			const canApprove =
				executionId.length > 0 && !!onApproveExecution && !!onRejectExecution;

			const toolCall: ToolCall = {
				id: executionId || `agent-${message.messageId}`,
				type: "function",
				executionId: executionId || undefined,
				function: {
					name: toolName || "unknown",
					arguments: preview.length > 0 ? preview : "{}",
				},
			};

			return (
				<div className="w-full">
					<ToolCallBlock
						toolCall={toolCall}
						status="pending"
						onApprove={
							canApprove ? () => onApproveExecution?.(executionId) : undefined
						}
						onReject={
							canApprove ? () => onRejectExecution?.(executionId) : undefined
						}
					/>
				</div>
			);
		}

		return null;
	})();

	const isStructuredAgentEvent =
		!!agentEvent &&
		[
			"agent.plan",
			"agent.step.start",
			"agent.step.result",
			"agent.step.wait_approval",
		].includes(agentEvent.type as string);

	const shouldShowEmptyAssistantFallback =
		!isUser &&
		!isSending &&
		!isError &&
		!hasToolCalls &&
		(!bubbleText || bubbleText.length === 0) &&
		!!isLast;
	const shouldRenderBubble =
		!isStructuredAgentEvent &&
		((bubbleText && bubbleText.length > 0) ||
			isSending ||
			isError ||
			shouldShowEmptyAssistantFallback);

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
						{isError && message.error && (
							<div className="mt-2 flex items-start gap-2 rounded bg-destructive/10 p-2 text-xs">
								<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
								<span>{translateErrorMessage(message.error, t)}</span>
							</div>
						)}
					</div>
				)}

				{agentStructuredContent}

				{hasToolCalls && (
					<div className="w-full space-y-1">
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
									(effectiveExecutionId.length > 0 ? "pending" : "completed");
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
