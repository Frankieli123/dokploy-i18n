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
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
		return "border-destructive bg-destructive/5";
	}
	if (
		toolName.includes("deploy") ||
		toolName.includes("create") ||
		toolName.includes("update") ||
		toolName.includes("restart") ||
		toolName.includes("rollback")
	) {
		return "border-amber-500/50 bg-amber-500/5";
	}
	return "border-border bg-card";
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
	const [showApprovalDialog, setShowApprovalDialog] = useState(false);

	const Icon = getToolIcon(toolCall.function.name);
	const riskColor = getRiskColor(toolCall.function.name);

	const parsedArgs = (() => {
		try {
			return JSON.parse(toolCall.function.arguments);
		} catch {
			return toolCall.function.arguments;
		}
	})();

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

	const StatusIcon = statusConfig[status].icon;
	const isDestructive =
		toolCall.function.name.includes("delete") ||
		toolCall.function.name.includes("remove") ||
		toolCall.function.name.includes("destroy") ||
		toolCall.function.name.includes("purge") ||
		toolCall.function.name.includes("uninstall") ||
		toolCall.function.name.includes("reset") ||
		toolCall.function.name.includes("rotate") ||
		toolCall.function.name.includes("revoke") ||
		toolCall.function.name.includes("restore");
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

	return (
		<>
			<div
				className={cn(
					"rounded border p-2 my-1 text-xs transition-colors shadow-sm",
					riskColor,
					className,
				)}
			>
				<div
					className="flex items-center justify-between cursor-pointer select-none group"
					onClick={() => setExpanded(!expanded)}
				>
					<div className="flex items-center gap-2">
						<div className="p-1 rounded bg-background border shadow-sm">
							<Icon className="h-3 w-3 text-foreground" />
						</div>
						<div className="flex items-center gap-2">
							<span className="font-semibold text-foreground text-[11px]">
								{toolCall.function.name}
							</span>
							<span
								className={cn(
									"flex items-center gap-1 font-medium text-[10px]",
									statusConfig[status].color,
								)}
							>
								<StatusIcon
									className={cn(
										"h-2.5 w-2.5",
										status === "executing" && "animate-spin",
									)}
								/>
								{statusConfig[status].label}
							</span>
						</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="h-5 w-5 p-0 hover:bg-transparent opacity-50 group-hover:opacity-100 transition-opacity"
					>
						{expanded ? (
							<ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
						) : (
							<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
						)}
					</Button>
				</div>

				{expanded && (
					<div className="mt-2 space-y-2 pt-2 border-t border-border/50">
						<div className="space-y-1">
							<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
								Arguments
							</span>
							<div className="rounded bg-muted/50 p-2 font-mono text-[10px] border border-border/50 max-h-[300px] overflow-y-auto overflow-x-auto">
								<pre className="whitespace-pre min-w-max">
									{JSON.stringify(parsedArgs, null, 2)}
								</pre>
							</div>
						</div>

						{result && (
							<div className="space-y-1">
								<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
									Result
								</span>
								<div
									className={cn(
										"rounded p-2 border text-[10px] max-h-[300px] overflow-y-auto overflow-x-auto",
										result.success
											? "bg-emerald-500/5 border-emerald-500/20 text-emerald-900 dark:text-emerald-200"
											: "bg-destructive/5 border-destructive/20 text-destructive-foreground",
									)}
								>
									{result.message && (
										<p className="font-medium mb-1 break-words">
											{result.message}
										</p>
									)}
									{result.data != null && (
										<pre className="font-mono opacity-90 whitespace-pre min-w-max">
											{JSON.stringify(result.data, null, 2)}
										</pre>
									)}
									{result.error && (
										<p className="font-medium text-destructive break-words">
											{result.error}
										</p>
									)}
								</div>
							</div>
						)}
					</div>
				)}

				{status === "pending" && onApprove && onReject && (
					<div className="mt-2 pt-2 border-t border-border/50 flex gap-2">
						<Button
							size="sm"
							className="h-6 px-2 text-[10px] flex-1"
							variant={isDestructive ? "destructive" : "default"}
							onClick={(e) => {
								e.stopPropagation();
								setShowApprovalDialog(true);
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
				)}
			</div>

			<Dialog open={showApprovalDialog} onOpenChange={setShowApprovalDialog}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							{isDestructive && (
								<AlertCircle className="h-5 w-5 text-destructive" />
							)}
							{t("ai.toolCall.confirmAction")}
						</DialogTitle>
						<DialogDescription>
							{t("ai.toolCall.aiRequestExecute")}{" "}
							<strong>{toolCall.function.name}</strong>
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						<div className="rounded-lg border p-3">
							<h4 className="text-sm font-medium mb-2">
								{t("ai.toolCall.parameters")}
							</h4>
							<div className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto">
								<pre className="min-w-max">
									{JSON.stringify(parsedArgs, null, 2)}
								</pre>
							</div>
						</div>
						{confirmHint.length > 0 && (
							<div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm text-amber-900 dark:text-amber-200">
								<div className="flex items-start gap-2">
									<ShieldAlert className="h-4 w-4 text-amber-500 mt-0.5" />
									<div className="min-w-0">
										<p className="font-medium">Confirm required</p>
										<p className="text-xs opacity-90">
											Set <span className="font-mono">confirm</span> to{" "}
											<span className="font-mono font-semibold select-all">
												{confirmHint}
											</span>
											(must match exactly).
										</p>
										{confirmLiteralsFromResult.length > 1 && (
											<p className="text-xs opacity-90 mt-1">
												Allowed:{" "}
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
								<h4 className="text-sm font-medium mb-2">Example params</h4>
								<div className="text-xs font-mono bg-muted p-2 rounded overflow-x-auto">
									<pre className="min-w-max">
										{JSON.stringify(exampleParamsFromResult, null, 2)}
									</pre>
								</div>
							</div>
						)}
						{isDestructive && (
							<div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
								{t("ai.toolCall.cannotUndo")}
							</div>
						)}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setShowApprovalDialog(false);
								onReject?.();
							}}
						>
							{t("common.cancel")}
						</Button>
						<Button
							variant={isDestructive ? "destructive" : "default"}
							onClick={() => {
								setShowApprovalDialog(false);
								onApprove?.();
							}}
						>
							{t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
