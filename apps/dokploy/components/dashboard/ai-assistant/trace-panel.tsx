"use client";

import { useMemo, useState } from "react";
import {
	Activity,
	AlertTriangle,
	BrainCircuit,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Flag,
	Play,
	Search,
	Wrench,
} from "lucide-react";
import { useTranslation } from "next-i18next";
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
import { cn } from "@/lib/utils";
import type { TraceEvent } from "./use-chat";

export function TracePanel({ events }: { events: TraceEvent[] }) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const { t } = useTranslation("common");

	const filtered = useMemo(() => {
		const s = search.trim().toLowerCase();
		if (!s) return events;
		return events.filter((e) => {
			if (e.title.toLowerCase().includes(s)) return true;
			try {
				return JSON.stringify(e.data ?? {})
					.toLowerCase()
					.includes(s);
			} catch {
				return false;
			}
		});
	}, [events, search]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8 p-0"
					title={t("ai.trace.button")}
					aria-label={t("ai.trace.button")}
				>
					<Activity className="h-4 w-4" />
				</Button>
			</DialogTrigger>
			<DialogContent
				noInnerScroll
				className="max-w-2xl max-h-[80vh] flex flex-col min-h-0 p-0 gap-0"
			>
				<DialogHeader className="p-6 pb-2">
					<DialogTitle className="flex items-center gap-2">
						<Activity className="h-5 w-5" />
						{t("ai.trace.title")}
					</DialogTitle>
					<DialogDescription>{t("ai.trace.description")}</DialogDescription>
					<div className="relative mt-4">
						<Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
						<Input
							placeholder={t("ai.trace.searchPlaceholder")}
							className="pl-8"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
				</DialogHeader>

				<div className="flex-1 min-h-0 overflow-y-auto p-6 pt-2">
					{filtered.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
							<Activity className="h-10 w-10 opacity-20 mb-2" />
							<p>{t("ai.trace.empty")}</p>
						</div>
					) : (
						<div className="space-y-2">
							{filtered.map((event) => (
								<TraceEventRow key={event.id} event={event} />
							))}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function safePrettyJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? null, null, 2);
	} catch {
		return String(value);
	}
}

function TraceEventRow({ event }: { event: TraceEvent }) {
	const [expanded, setExpanded] = useState(false);
	const time = new Date(event.timestamp).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});

	const icon = (() => {
		switch (event.type) {
			case "start":
				return Play;
			case "reasoning":
				return BrainCircuit;
			case "tool-call":
				return Wrench;
			case "tool-result":
				return CheckCircle2;
			case "done":
				return Flag;
			case "error":
				return AlertTriangle;
			default:
				return Activity;
		}
	})();

	const color = (() => {
		switch (event.type) {
			case "error":
				return "text-destructive";
			case "tool-call":
				return "text-purple-500";
			case "tool-result":
				return "text-emerald-600";
			case "reasoning":
				return "text-amber-500";
			case "done":
				return "text-primary";
			default:
				return "text-muted-foreground";
		}
	})();

	const Icon = icon;
	const hasDetails = event.data !== undefined;
	const details = (() => {
		if (!hasDetails) return "";
		if (
			event.type === "reasoning" &&
			event.data &&
			typeof event.data === "object" &&
			"text" in event.data
		) {
			const text = (event.data as { text?: unknown }).text;
			return typeof text === "string" ? text : safePrettyJson(event.data);
		}
		return safePrettyJson(event.data);
	})();

	return (
		<div className="rounded-lg border bg-card">
			<button
				type="button"
				className={cn(
					"w-full p-3 text-left flex items-start gap-3 hover:bg-muted/30 transition-colors",
					expanded && "bg-muted/30",
				)}
				onClick={() => setExpanded((v) => !v)}
			>
				<div className={cn("mt-0.5 shrink-0", color)}>
					<Icon className="h-4 w-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 min-w-0">
						<span className="text-xs text-muted-foreground tabular-nums shrink-0">
							{time}
						</span>
						<span className="text-xs text-muted-foreground shrink-0">
							{event.source}
						</span>
						<span className="text-sm font-medium break-words [overflow-wrap:anywhere] min-w-0">
							{event.title}
						</span>
					</div>
					{hasDetails && !expanded && (
						<div className="mt-1 text-xs text-muted-foreground truncate font-mono opacity-80">
							{details.replace(/\s+/g, " ").slice(0, 160)}
							{details.length > 160 ? "..." : ""}
						</div>
					)}
				</div>
				<div className="shrink-0 mt-0.5 text-muted-foreground">
					{expanded ? (
						<ChevronUp className="h-4 w-4" />
					) : (
						<ChevronDown className="h-4 w-4" />
					)}
				</div>
			</button>

			{expanded && hasDetails && (
				<pre
					className={cn(
						"border-t bg-background/40 p-3 text-xs font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
						event.type === "reasoning" &&
							"text-amber-600/90 dark:text-amber-500/90",
					)}
				>
					{details}
				</pre>
			)}
		</div>
	);
}
