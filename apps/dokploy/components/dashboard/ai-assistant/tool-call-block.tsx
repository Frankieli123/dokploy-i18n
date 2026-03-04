"use client";

import {
	AlertCircle,
	AppWindow,
	Archive,
	Bell,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Clock,
	Copy,
	CreditCard,
	Database,
	FileKey,
	FolderKanban,
	GitBranch,
	Globe,
	Layers,
	ListChecks,
	Loader2,
	Lock,
	RotateCcw,
	Server,
	Settings,
	ShieldAlert,
	User,
	Wrench,
} from "lucide-react";
import copyToClipboard from "copy-to-clipboard";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ToolCall } from "./use-chat";

interface ToolCallBlockProps {
	toolCall: ToolCall;
	status?:
		| "pending"
		| "approved"
		| "rejected"
		| "executing"
		| "completed"
		| "failed";
	result?: {
		success: boolean;
		message?: string;
		data?: unknown;
		error?: string;
	};
	executionId?: string;
	onApprove?: () => void;
	onReject?: () => void;
	className?: string;
}

const toolIcons: Record<string, typeof Wrench> = {
	postgres: Database,
	mysql: Database,
	mariadb: Database,
	mongo: Database,
	redis: Database,
	application: AppWindow,
	server: Server,
	compose: Layers,
	domain: Globe,
	backup: Archive,
	deployment: ListChecks,
	git: GitBranch,
	gitea: GitBranch,
	gitlab: GitBranch,
	bitbucket: GitBranch,
	github: GitBranch,
	registry: Database,
	traefik: Globe,
	destination: Archive,
	mount: Server,
	certificate: FileKey,
	project: FolderKanban,
	environment: GitBranch,
	notification: Bell,
	port: Server,
	preview: ListChecks,
	schedule: Clock,
	rollback: RotateCcw,
	security: Lock,
	settings: Settings,
	stripe: CreditCard,
	user: User,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getToolIcon(toolName: string) {
	const normalized = String(toolName ?? "")
		.trim()
		.toLowerCase();
	if (normalized.startsWith("volume_backup_")) {
		return toolIcons.backup ?? Wrench;
	}
	const category = normalized.split(/[._-]/)[0] ?? normalized;
	return toolIcons[category] ?? Wrench;
}

function getRiskColor(toolName: string) {
	if (
		toolName.includes("delete") ||
		toolName.includes("remove") ||
		toolName.includes("destroy") ||
		toolName.includes("purge") ||
		toolName.includes("uninstall") ||
		toolName.includes("reset") ||
		toolName.includes("rotate") ||
		toolName.includes("revoke") ||
		toolName.includes("restore")
	) {
		return "border-destructive/20 bg-destructive/5";
	}
	if (
		toolName.includes("deploy") ||
		toolName.includes("create") ||
		toolName.includes("update") ||
		toolName.includes("restart") ||
		toolName.includes("rollback")
	) {
		return "border-amber-500/20 bg-amber-500/5";
	}
	return "border-border/40 bg-muted/20";
}

function getConfirmLiteral(parsedArgs: unknown): string {
	if (
		!parsedArgs ||
		typeof parsedArgs !== "object" ||
		Array.isArray(parsedArgs)
	) {
		return "";
	}
	const entries = Object.entries(parsedArgs as Record<string, unknown>);
	const exact = entries.find(([k]) => k.toLowerCase() === "confirm");
	if (exact && typeof exact[1] === "string" && exact[1].trim().length > 0) {
		return exact[1].trim();
	}
	const loose = entries.find(([k]) => k.toLowerCase().includes("confirm"));
	if (loose && typeof loose[1] === "string" && loose[1].trim().length > 0) {
		return loose[1].trim();
	}
	return "";
}

function toPrettyText(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function countLines(text: string): number {
	const normalized = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const trimmed = normalized.replace(/\n+$/, "");
	if (trimmed.length === 0) return 0;
	return trimmed.split("\n").length;
}

export function ToolCallBlock({
	toolCall,
	status = "pending",
	result,
	onApprove,
	onReject,
	className,
}: ToolCallBlockProps) {
	const { t } = useTranslation("common");
	const [expanded, setExpanded] = useState(false);

	const Icon = getToolIcon(toolCall.function.name);
	const displayToolName = (() => {
		const raw = String(toolCall.function.name ?? "").trim();
		if (!raw.toLowerCase().startsWith("mcp/")) return raw;
		const parts = raw.split("/");
		if (parts.length < 3) return raw;
		const serverId = String(parts[1] ?? "");
		const toolName = parts.slice(2).join("/");
		const serverName =
			isRecord(result?.data) && typeof result.data.serverName === "string"
				? result.data.serverName.trim()
				: "";
		const serverLabel = serverName || (serverId ? serverId.slice(0, 8) : "");
		if (!serverLabel || !toolName) return raw;
		return `mcp/${serverLabel}/${toolName}`;
	})();

	const parsedArgs = (() => {
		try {
			return JSON.parse(toolCall.function.arguments);
		} catch {
			return toolCall.function.arguments;
		}
	})();

	const paramsText = toPrettyText(parsedArgs);
	const paramsLineCount = countLines(paramsText);

	const unknownToolInfo = (() => {
		if (!result || result.success !== false) return null;
		const errorText = typeof result.error === "string" ? result.error : "";
		const messageText = typeof result.message === "string" ? result.message : "";
		const looksUnknownTool =
			errorText.toLowerCase().startsWith("unknown tool:") ||
			(messageText.toLowerCase().includes("tool") &&
				messageText.toLowerCase().includes("not found"));
		if (!looksUnknownTool) return null;

		const data = isRecord(result.data) ? result.data : undefined;
		const nextCall = data && isRecord(data.nextCall) ? data.nextCall : undefined;
		const suggestedToolName =
			nextCall && typeof nextCall.toolName === "string" ? nextCall.toolName : "";
		const suggestedParams = nextCall ? nextCall.params : undefined;

		const suggestionsRaw =
			data && Array.isArray(data.suggestions) ? data.suggestions : [];
		const suggestions = suggestionsRaw
			.filter(isRecord)
			.map((s) => ({
				name: typeof s.name === "string" ? s.name : "",
				description: typeof s.description === "string" ? s.description : "",
				riskLevel: typeof s.riskLevel === "string" ? s.riskLevel : "",
				requiresApproval:
					typeof s.requiresApproval === "boolean" ? s.requiresApproval : false,
			}))
			.filter((s) => s.name.length > 0);

		return {
			suggestedToolName,
			suggestedParams,
			suggestions,
			errorText,
			messageText,
		};
	})();

	const isUnknownToolError = !!unknownToolInfo;
	const riskColor = isUnknownToolError
		? "border-amber-500/20 bg-amber-500/5"
		: getRiskColor(toolCall.function.name);

	const statusConfig = {
		pending: {
			icon: ShieldAlert,
			color: "text-amber-500",
			label: t("ai.toolCall.pendingApproval"),
		},
		approved: {
			icon: CheckCircle2,
			color: "text-emerald-500",
			label: t("ai.toolCall.approved"),
		},
		rejected: {
			icon: AlertCircle,
			color: "text-destructive",
			label: t("ai.toolCall.rejected"),
		},
		executing: {
			icon: Loader2,
			color: "text-blue-500",
			label: t("ai.toolCall.executing"),
		},
		completed: {
			icon: CheckCircle2,
			color: "text-emerald-500",
			label: t("ai.toolCall.completed"),
		},
		failed: {
			icon: AlertCircle,
			color: "text-destructive",
			label: t("ai.toolCall.failed"),
		},
	};

	const StatusIcon = isUnknownToolError ? ShieldAlert : statusConfig[status].icon;
	const statusColor = isUnknownToolError
		? "text-amber-500"
		: statusConfig[status].color;
	const isDestructive =
		!isUnknownToolError &&
		(toolCall.function.name.includes("delete") ||
			toolCall.function.name.includes("remove") ||
			toolCall.function.name.includes("destroy") ||
			toolCall.function.name.includes("purge") ||
			toolCall.function.name.includes("uninstall") ||
			toolCall.function.name.includes("reset") ||
			toolCall.function.name.includes("rotate") ||
			toolCall.function.name.includes("revoke") ||
			toolCall.function.name.includes("restore"));
	const confirmLiteral = getConfirmLiteral(parsedArgs);
	const confirmLiteralsFromResult = (() => {
		if (
			!result?.data ||
			typeof result.data !== "object" ||
			Array.isArray(result.data)
		) {
			return [] as string[];
		}
		const v = (result.data as { confirmLiterals?: unknown }).confirmLiterals;
		return Array.isArray(v)
			? v.filter(
					(x): x is string => typeof x === "string" && x.trim().length > 0,
				)
			: [];
	})();
	const exampleParamsFromResult = (() => {
		if (
			!result?.data ||
			typeof result.data !== "object" ||
			Array.isArray(result.data)
		) {
			return undefined;
		}
		const v = (result.data as { exampleParams?: unknown }).exampleParams;
		return v;
	})();
	const confirmHint = confirmLiteral || confirmLiteralsFromResult[0] || "";
	const resultPreview = (() => {
		if (
			status === "pending" ||
			status === "approved" ||
			status === "executing"
		) {
			return "";
		}
		if (!result) return "";
		if (isUnknownToolError) {
			const suggested = unknownToolInfo?.suggestedToolName ?? "";
			if (suggested.trim().length > 0) {
				return `${result.message || result.error || t("ai.toolCall.unknownTool")} -> ${suggested}`;
			}
			return result.message || result.error || "";
		}
		if (!result.success) {
			return result.message || result.error || "";
		}
		if (
			typeof result.message === "string" &&
			result.message.trim().length > 0
		) {
			return result.message.trim();
		}
		const data = result.data;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			const stdout = (data as { stdout?: unknown }).stdout;
			const stderr = (data as { stderr?: unknown }).stderr;
			const picked =
				typeof stdout === "string" && stdout.trim().length > 0
					? stdout.trim()
					: typeof stderr === "string" && stderr.trim().length > 0
						? stderr.trim()
						: "";
			if (picked.length > 0) {
				return picked.split(/\r?\n/)[0] ?? picked;
			}
		}
		return "";
	})();

	const resultOutputText = (() => {
		if (!result) return "";
		if (result.data != null) {
			const text = toPrettyText(result.data);
			if (text.trim().length > 0) return text;
		}
		if (typeof result.message === "string" && result.message.trim().length > 0) {
			return result.message.trim();
		}
		if (typeof result.error === "string" && result.error.trim().length > 0) {
			return result.error.trim();
		}
		return "";
	})();
	const resultLineCount = countLines(resultOutputText);

	const copyText = (text: string) => {
		if (text.trim().length === 0) return;
		const ok = copyToClipboard(text);
		if (ok) toast.success(t("common.copiedToClipboard"));
		else toast.error(t("common.unknownError"));
	};

	return (
		<>
			<div
				className={cn(
					"w-full max-w-full min-w-0 overflow-hidden rounded-xl border p-3 text-xs transition-all",
					riskColor,
					className,
				)}
			>
				<div
					className="flex items-center justify-between cursor-pointer select-none group min-w-0 gap-2"
					onClick={() => setExpanded(!expanded)}
				>
					<div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
						<div className="p-1.5 rounded-lg bg-background/50 border border-border/20 shadow-sm shrink-0">
							<Icon className="h-3 w-3 text-foreground" />
						</div>
						<div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
							<span className="font-semibold text-foreground text-[11px] min-w-0 truncate">
								{displayToolName}
							</span>
							<span
								className={cn(
									"flex items-center gap-1 font-medium text-[10px] shrink-0 max-w-[45%] overflow-hidden",
									statusColor,
								)}
							>
								<StatusIcon
									className={cn(
										"h-2.5 w-2.5",
										status === "executing" && "animate-spin",
									)}
								/>
								<span className="min-w-0 truncate">
									{statusConfig[status].label}
								</span>
							</span>
						</div>
					</div>
					<div className="flex items-center gap-1.5 shrink-0">
						{resultLineCount > 0 && (
							<span
								className="text-[10px] text-muted-foreground font-mono"
								onClick={(e) => e.stopPropagation()}
							>
								{t("logs.lines.custom", { count: resultLineCount })}
							</span>
						)}
						{resultOutputText.trim().length > 0 && (
							<Button
								variant="ghost"
								size="icon"
								className="!h-5 !w-5 !p-0 hover:bg-transparent opacity-50 group-hover:opacity-100 transition-opacity"
								onClick={(e) => {
									e.stopPropagation();
									copyText(resultOutputText);
								}}
								title={t("logs.copy")}
							>
								<Copy className="h-3.5 w-3.5 text-muted-foreground" />
								<span className="sr-only">{t("logs.copy")}</span>
							</Button>
						)}
						<Button
							variant="ghost"
							size="icon"
							className="!h-5 !w-5 !p-0 hover:bg-transparent opacity-50 group-hover:opacity-100 transition-opacity"
						>
							{expanded ? (
								<ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
							) : (
								<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
							)}
						</Button>
					</div>
				</div>

				{!expanded && (
					<div className="mt-1 text-[10px] text-muted-foreground font-mono break-words [overflow-wrap:anywhere]">
						<div className="opacity-75 truncate mb-0.5">
							{typeof parsedArgs === "string"
								? parsedArgs
								: JSON.stringify(parsedArgs)}
						</div>
						{resultPreview.length > 0 && <div>{resultPreview}</div>}
					</div>
				)}

				{expanded && (
					<div className="mt-2 space-y-2 pt-2 border-t border-border/50">
						<div className="space-y-1">
							<div className="flex items-center justify-between gap-2">
								<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
									{t("ai.toolCall.parameters")}
								</span>
								<div
									className="flex items-center gap-1.5 shrink-0"
									onClick={(e) => e.stopPropagation()}
								>
									{paramsLineCount > 0 && (
										<span className="text-[10px] text-muted-foreground font-mono">
											{t("logs.lines.custom", { count: paramsLineCount })}
										</span>
									)}
									{paramsText.trim().length > 0 && (
										<Button
											variant="ghost"
											size="icon"
											className="!h-5 !w-5 !p-0 hover:bg-transparent opacity-60 hover:opacity-100 transition-opacity"
											onClick={(e) => {
												e.stopPropagation();
												copyText(paramsText);
											}}
											title={t("logs.copy")}
										>
											<Copy className="h-3.5 w-3.5 text-muted-foreground" />
											<span className="sr-only">{t("logs.copy")}</span>
										</Button>
									)}
								</div>
							</div>
							<div className="max-w-full rounded bg-muted/50 p-2 font-mono text-[11px] border border-border/50 overflow-hidden">
								<pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
									{paramsText}
								</pre>
							</div>
						</div>

						{result && (
							<div className="space-y-1">
								<div className="flex items-center justify-between gap-2">
									<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
										{t("ai.toolCall.result")}
									</span>
									<div
										className="flex items-center gap-1.5 shrink-0"
										onClick={(e) => e.stopPropagation()}
									>
										{resultLineCount > 0 && (
											<span className="text-[10px] text-muted-foreground font-mono">
												{t("logs.lines.custom", { count: resultLineCount })}
											</span>
										)}
										{resultOutputText.trim().length > 0 && (
											<Button
												variant="ghost"
												size="icon"
												className="!h-5 !w-5 !p-0 hover:bg-transparent opacity-60 hover:opacity-100 transition-opacity"
												onClick={(e) => {
													e.stopPropagation();
													copyText(resultOutputText);
												}}
												title={t("logs.copy")}
											>
												<Copy className="h-3.5 w-3.5 text-muted-foreground" />
												<span className="sr-only">{t("logs.copy")}</span>
											</Button>
										)}
									</div>
								</div>
								<div
									className={cn(
										"max-w-full rounded p-2 border text-[11px] overflow-hidden",
										isUnknownToolError
											? "bg-amber-500/5 border-amber-500/20 text-amber-900 dark:text-amber-200"
											: result.success
												? "bg-emerald-500/5 border-emerald-500/20 text-emerald-900 dark:text-emerald-200"
												: "bg-destructive/5 border-destructive/20 text-destructive-foreground",
									)}
								>
									{result.message && (
										<p className="font-medium mb-1 break-words">
											{result.message}
										</p>
									)}
									{isUnknownToolError &&
										unknownToolInfo?.suggestedToolName.trim().length > 0 && (
											<p className="font-medium mb-1 break-words">
												{t("ai.toolCall.suggestedToolLabel")}{" "}
												<span className="font-mono">
													{unknownToolInfo.suggestedToolName}
												</span>
											</p>
										)}
									{result.data != null && (
										<pre className="font-mono opacity-90 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
											{toPrettyText(result.data)}
										</pre>
									)}
									{result.error && (
										<p
											className={cn(
												"font-medium break-words",
												isUnknownToolError
													? "text-amber-700 dark:text-amber-200"
													: "text-destructive",
											)}
										>
											{result.error}
										</p>
									)}
								</div>
							</div>
						)}
					</div>
				)}

				{status === "pending" && onApprove && onReject && (
					<div className="mt-2 pt-2 border-t border-border/50 space-y-2">
						{confirmHint.length > 0 && (
							<div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-[11px] text-amber-900 dark:text-amber-200">
									<div className="flex items-start gap-2">
										<ShieldAlert className="h-4 w-4 text-amber-500 mt-0.5" />
										<div className="min-w-0">
											<p className="font-medium">
												{t("ai.toolCall.confirmRequired")}
											</p>
											<p className="text-[10px] opacity-90">
												{t("ai.toolCall.confirmHintPrefix")}
												<span className="font-mono">confirm</span>
												{t("ai.toolCall.confirmHintTo")}
												<span className="font-mono font-semibold select-all">
													{confirmHint}
												</span>
												{t("ai.toolCall.confirmHintSuffix")}
											</p>
											{confirmLiteralsFromResult.length > 1 && (
												<p className="text-[10px] opacity-90 mt-1">
													{t("ai.toolCall.allowedLiterals")}
													<span className="font-mono">
														{confirmLiteralsFromResult.join(", ")}
													</span>
											</p>
										)}
									</div>
								</div>
							</div>
						)}
							{exampleParamsFromResult != null && (
								<div className="rounded-lg border p-3">
									<h4 className="text-[11px] font-medium mb-2">
										{t("ai.toolCall.exampleParams")}
									</h4>
									<div className="text-[10px] font-mono bg-muted p-2 rounded max-h-[220px] overflow-y-auto">
										<pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
											{JSON.stringify(exampleParamsFromResult, null, 2)}
									</pre>
								</div>
							</div>
						)}
						{isDestructive && (
							<div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-[11px] text-destructive">
								{t("ai.toolCall.cannotUndo")}
							</div>
						)}
						<div className="flex gap-2">
							<Button
								size="sm"
								className="h-6 px-2 text-[10px] flex-1"
								variant={isDestructive ? "destructive" : "default"}
								onClick={(e) => {
									e.stopPropagation();
									onApprove();
								}}
							>
								{t("ai.toolCall.reviewApprove")}
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="h-6 px-2 text-[10px] flex-1 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/50"
								onClick={(e) => {
									e.stopPropagation();
									onReject();
								}}
							>
								{t("ai.toolCall.reject")}
							</Button>
						</div>
					</div>
				)}
			</div>
		</>
	);
}
