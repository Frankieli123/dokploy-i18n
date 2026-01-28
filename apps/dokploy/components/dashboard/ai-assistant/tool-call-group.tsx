"use client";

import {
	AlertCircle,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Layers,
	Loader2,
	ShieldAlert,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ToolCallBlock } from "./tool-call-block";
import type { ToolCall } from "./use-chat";

interface ToolGroupProps {
	toolCalls: ToolCall[];
	onApproveToolCall?: (toolCallId: string) => void;
	onRejectToolCall?: (toolCallId: string) => void;
}

export function ToolGroup({
	toolCalls,
	onApproveToolCall,
	onRejectToolCall,
}: ToolGroupProps) {
	const { t } = useTranslation("common");
	const [isOpen, setIsOpen] = useState(false);

	const isUnknownToolFailure = (tc: ToolCall) => {
		const errorText = tc.result?.error;
		const messageText = tc.result?.message;
		if (
			typeof errorText === "string" &&
			errorText.toLowerCase().startsWith("unknown tool:")
		) {
			return true;
		}
		if (
			typeof messageText === "string" &&
			messageText.toLowerCase().includes("tool") &&
			messageText.toLowerCase().includes("not found")
		) {
			return true;
		}
		return false;
	};

	const getEffectiveExecutionId = (tc: ToolCall) => {
		if (typeof tc.executionId === "string" && tc.executionId.length > 0) {
			return tc.executionId;
		}
		const data = tc.result?.data;
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			return "";
		}
		const v = (data as { executionId?: unknown }).executionId;
		return typeof v === "string" && v.length > 0 ? v : "";
	};

	const summary = useMemo(() => {
		let executing = 0;
		let pending = 0;
		let failed = 0;
		let completed = 0;
		let unknownToolFailures = 0;

		for (const tc of toolCalls) {
			const effectiveExecutionId = getEffectiveExecutionId(tc);
			const status =
				tc.status ??
				(effectiveExecutionId.length > 0 ? "executing" : "completed");
			if (status === "executing") executing++;
			else if (status === "pending") pending++;
			else if (status === "failed" || status === "rejected") {
				failed++;
				if (status === "failed" && isUnknownToolFailure(tc)) {
					unknownToolFailures++;
				}
			}
			else if (status === "completed" || status === "approved") completed++;
		}

		return { executing, pending, failed, completed, unknownToolFailures };
	}, [toolCalls]);

	const orderedToolCalls = useMemo(() => {
		return toolCalls
			.map((tc, idx) => {
				const effectiveExecutionId = getEffectiveExecutionId(tc);
				const status =
					tc.status ??
					(effectiveExecutionId.length > 0 ? "executing" : "completed");
				const canApprove =
					status === "pending" &&
					effectiveExecutionId.length > 0 &&
					!!onApproveToolCall &&
					!!onRejectToolCall;
				return { tc, idx, canApprove };
			})
			.sort((a, b) => {
				if (a.canApprove && !b.canApprove) return -1;
				if (!a.canApprove && b.canApprove) return 1;
				return a.idx - b.idx;
			})
			.map((x) => x.tc);
	}, [toolCalls, onApproveToolCall, onRejectToolCall]);

	const pendingHeaderAction = useMemo(() => {
		if (!onApproveToolCall || !onRejectToolCall) return null;
		for (const tc of orderedToolCalls) {
			const effectiveExecutionId = getEffectiveExecutionId(tc);
			const status =
				tc.status ??
				(effectiveExecutionId.length > 0 ? "executing" : "completed");
			if (status !== "pending") continue;
			if (effectiveExecutionId.length === 0) continue;
			return { toolCallId: tc.id };
		}
		return null;
	}, [onApproveToolCall, onRejectToolCall, orderedToolCalls]);

	const isExecuting = summary.executing > 0;
	const isPending = summary.pending > 0;
	const hasFailed = summary.failed > 0;
	const hasOnlyUnknownToolFailures =
		hasFailed &&
		summary.unknownToolFailures > 0 &&
		summary.unknownToolFailures === summary.failed;

	useEffect(() => {
		if (!isPending) return;
		setIsOpen(true);
	}, [isPending]);

	// Determine overall status color/icon for the header
	let HeaderIcon = Layers;
	let headerColor = "text-muted-foreground";
	let statusText = t("ai.toolCall.calls");

	if (isExecuting) {
		HeaderIcon = Loader2;
		headerColor = "text-blue-500";
		statusText = t("ai.toolCall.executing");
	} else if (isPending) {
		HeaderIcon = ShieldAlert;
		headerColor = "text-amber-500";
		statusText = t("ai.toolCall.pendingApproval");
	} else if (hasFailed) {
		HeaderIcon = hasOnlyUnknownToolFailures ? ShieldAlert : AlertCircle;
		headerColor = hasOnlyUnknownToolFailures ? "text-amber-500" : "text-destructive";
		statusText = t("ai.toolCall.failed");
	} else {
		HeaderIcon = CheckCircle2;
		headerColor = "text-emerald-500";
		statusText = t("ai.toolCall.completed");
	}

	return (
		<div className="rounded-md border bg-card my-1 overflow-hidden shadow-sm w-full max-w-full min-w-0">
			<div
				className={cn(
					"flex items-center justify-between px-3 py-2 cursor-pointer select-none hover:bg-muted/50 transition-colors min-w-0",
					isExecuting && "bg-blue-50/50 dark:bg-blue-900/10",
					isPending && "bg-amber-50/50 dark:bg-amber-900/10",
					hasOnlyUnknownToolFailures && "bg-amber-50/50 dark:bg-amber-900/10",
				)}
				onClick={() => setIsOpen(!isOpen)}
			>
				<div className="flex items-center gap-2.5 min-w-0">
					<HeaderIcon
						className={cn(
							"h-4 w-4 shrink-0",
							headerColor,
							isExecuting && "animate-spin",
						)}
					/>
					<div className="flex flex-col min-w-0">
							<span className="text-xs font-medium text-foreground truncate">
								{statusText}
							</span>
							<span className="text-[10px] text-muted-foreground truncate">
								{toolCalls.length === 1
									? t("ai.toolCall.toolCountOne", { count: toolCalls.length })
									: t("ai.toolCall.toolCountMany", { count: toolCalls.length })}
							</span>
						</div>
					</div>
				<div className="flex items-center gap-2">
					{pendingHeaderAction && (
						<div
							className="flex items-center gap-1"
							onClick={(e) => e.stopPropagation()}
						>
							<Button
								size="sm"
								className="h-6 px-2 text-[10px]"
								onClick={(e) => {
									e.stopPropagation();
									onApproveToolCall?.(pendingHeaderAction.toolCallId);
								}}
							>
								{t("ai.toolCall.reviewApprove")}
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="h-6 px-2 text-[10px]"
								onClick={(e) => {
									e.stopPropagation();
									onRejectToolCall?.(pendingHeaderAction.toolCallId);
								}}
							>
								{t("ai.toolCall.reject")}
							</Button>
						</div>
					)}
					{isPending && (
						<span className="flex h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
					)}
					{isOpen ? (
						<ChevronUp className="h-4 w-4 text-muted-foreground" />
					) : (
						<ChevronDown className="h-4 w-4 text-muted-foreground" />
					)}
				</div>
			</div>

			{isOpen && (
				<div className="border-t bg-muted/10 divide-y divide-border/50 max-w-full min-w-0 max-h-[40vh] overflow-y-auto overflow-x-hidden">
					{orderedToolCalls.map((tc) => {
						const effectiveExecutionId = getEffectiveExecutionId(tc);
						const status =
							tc.status ??
							(effectiveExecutionId.length > 0 ? "pending" : "completed");
						const canApprove =
							status === "pending" &&
							effectiveExecutionId.length > 0 &&
							!!onApproveToolCall &&
							!!onRejectToolCall;

						return (
							<div
								key={tc.id}
								className="px-2 py-1 max-w-full min-w-0 overflow-hidden"
							>
								<ToolCallBlock
									toolCall={tc}
									status={status}
									result={tc.result}
									executionId={
										effectiveExecutionId.length > 0
											? effectiveExecutionId
											: undefined
									}
									onApprove={
										canApprove ? () => onApproveToolCall?.(tc.id) : undefined
									}
									onReject={
										canApprove ? () => onRejectToolCall?.(tc.id) : undefined
									}
									className="my-0 shadow-none border-none bg-transparent"
								/>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
