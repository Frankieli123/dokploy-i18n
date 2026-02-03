"use client";

import { CheckCircle2, Search, Wrench } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToolCallBlock } from "./tool-call-block";
import type { Message } from "./use-chat";

interface ToolExecutionHistoryProps {
	messages: Message[];
}

export function ToolExecutionHistory({ messages }: ToolExecutionHistoryProps) {
	const { t } = useTranslation("common");
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const toolExecutions = useMemo(() => {
		const executions: Array<{
			messageId: string;
			createdAt: string;
			toolCall: NonNullable<Message["toolCalls"]>[number];
		}> = [];

		messages.forEach((msg) => {
			if (
				msg.role === "assistant" &&
				msg.toolCalls &&
				msg.toolCalls.length > 0
			) {
				msg.toolCalls.forEach((toolCall) => {
					executions.push({
						messageId: msg.messageId,
						createdAt: msg.createdAt,
						toolCall,
					});
				});
			}
		});

		const withIndex = executions.map((e, idx) => ({ ...e, idx }));
		return withIndex
			.sort((a, b) => {
				const aStatus =
					a.toolCall.status ??
					(a.toolCall.executionId ? "pending" : "completed");
				const bStatus =
					b.toolCall.status ??
					(b.toolCall.executionId ? "pending" : "completed");

				const aNeedsApproval =
					aStatus === "pending" && !!a.toolCall.executionId;
				const bNeedsApproval =
					bStatus === "pending" && !!b.toolCall.executionId;

				if (aNeedsApproval && !bNeedsApproval) return -1;
				if (!aNeedsApproval && bNeedsApproval) return 1;

				const timeDiff =
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
				if (timeDiff !== 0) return timeDiff;

				return a.idx - b.idx;
			})
			.map(({ idx, ...rest }) => rest);
	}, [messages]);

	const filteredExecutions = useMemo(() => {
		if (!search) return toolExecutions;
		const lowerSearch = search.toLowerCase();
		return toolExecutions.filter(
			(item) =>
				item.toolCall.function.name.toLowerCase().includes(lowerSearch) ||
				item.toolCall.function.arguments.toLowerCase().includes(lowerSearch),
		);
	}, [toolExecutions, search]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8 p-0 -ml-1"
					title={t("ai.tools.history")}
					aria-label={t("ai.tools.history")}
				>
					<Wrench className="h-4 w-4" />
				</Button>
			</DialogTrigger>
			<DialogContent
				noInnerScroll
				className="max-w-2xl max-h-[80vh] flex flex-col min-h-0 p-0 gap-0"
			>
				<DialogHeader className="p-6 pb-2">
					<DialogTitle className="flex items-center gap-2">
						<Wrench className="h-5 w-5" />
						{t("ai.tools.historyTitle")}
					</DialogTitle>
					<DialogDescription>
						{t("ai.tools.historyDescription")}
					</DialogDescription>
					<div className="relative mt-4">
						<Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
						<Input
							placeholder={t("ai.tools.searchPlaceholder")}
							className="pl-8"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
				</DialogHeader>

				<ScrollArea className="flex-1 min-h-0" viewPortClassName="p-6 pt-2">
					<div className="space-y-4">
						{filteredExecutions.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
								<Wrench className="h-10 w-10 opacity-20 mb-2" />
								<p>{t("ai.tools.noExecutions")}</p>
							</div>
						) : (
							filteredExecutions.map(({ messageId, createdAt, toolCall }) => (
								<div
									key={`${messageId}-${toolCall.id}`}
									className="border rounded-lg p-3 space-y-2 hover:bg-muted/30 transition-colors"
								>
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-2">
											<div className="flex items-center justify-center w-6 h-6 rounded-full bg-primary/10">
												<CheckCircle2 className="h-3.5 w-3.5 text-primary" />
											</div>
											<span className="font-medium text-sm">
												{toolCall.function.name}
											</span>
										</div>
										<span className="text-xs text-muted-foreground tabular-nums">
											{new Date(createdAt).toLocaleString()}
										</span>
									</div>
									<div className="pl-8">
										<ToolCallBlock
											toolCall={toolCall}
											status={
												toolCall.status ??
												(toolCall.executionId ? "pending" : "completed")
											}
											result={toolCall.result}
											executionId={toolCall.executionId}
										/>
									</div>
								</div>
							))
						)}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
}
