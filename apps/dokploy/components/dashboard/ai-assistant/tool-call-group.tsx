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
import { useMemo, useState } from "react";
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

		for (const tc of toolCalls) {
			const effectiveExecutionId = getEffectiveExecutionId(tc);
			const status =
				tc.status ??
				(effectiveExecutionId.length > 0 ? "pending" : "completed");
			if (status === "executing") executing++;
			else if (status === "pending") pending++;
			else if (status === "failed" || status === "rejected") failed++;
			else if (status === "completed" || status === "approved") completed++;
		}

		return { executing, pending, failed, completed };
	}, [toolCalls]);

	const orderedToolCalls = useMemo(() => {
		return toolCalls
			.map((tc, idx) => {
				const effectiveExecutionId = getEffectiveExecutionId(tc);
				const status =
					tc.status ??
					(effectiveExecutionId.length > 0 ? "pending" : "completed");
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

	const isExecuting = summary.executing > 0;
	const isPending = summary.pending > 0;
	const hasFailed = summary.failed > 0;

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
		HeaderIcon = AlertCircle;
		headerColor = "text-destructive";
		statusText = t("ai.toolCall.failed");
	} else {
		HeaderIcon = CheckCircle2;
		headerColor = "text-emerald-500";
		statusText = t("ai.toolCall.completed");
	}

	return (
		<div className="rounded-md border bg-card my-1 overflow-hidden shadow-sm w-full">
			<div
				className={cn(
					"flex items-center justify-between px-3 py-2 cursor-pointer select-none hover:bg-muted/50 transition-colors",
					isExecuting && "bg-blue-50/50 dark:bg-blue-900/10",
					isPending && "bg-amber-50/50 dark:bg-amber-900/10",
				)}
				onClick={() => setIsOpen(!isOpen)}
			>
				<div className="flex items-center gap-2.5">
					<HeaderIcon
						className={cn(
							"h-4 w-4 shrink-0",
							headerColor,
							isExecuting && "animate-spin",
						)}
					/>
					<div className="flex flex-col">
						<span className="text-xs font-medium text-foreground">
							{statusText}
						</span>
						<span className="text-[10px] text-muted-foreground">
							{toolCalls.length} {toolCalls.length === 1 ? "tool" : "tools"}
						</span>
					</div>
				</div>
				<div className="flex items-center gap-2">
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
				<div className="border-t bg-muted/10 divide-y divide-border/50">
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
							<div key={tc.id} className="px-2 py-1">
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
