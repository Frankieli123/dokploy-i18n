"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Circle, Loader2, Plug, Server, XCircle } from "lucide-react";
import { useTranslation } from "next-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

type McpTestResult = {
	status: "ok" | "error";
	toolCount?: number;
	latencyMs?: number;
	error?: string;
};

export function McpControlDialog(props: {
	isMcpEnabled: boolean;
	setMcpEnabled: (enabled: boolean) => Promise<void>;
}) {
	const { t } = useTranslation("common");
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [isTogglingConversation, setIsTogglingConversation] = useState(false);

	const { data: servers, isLoading: isLoadingServers } =
		api.ai.mcpServers.list.useQuery(
			{ limit: 100, offset: 0 },
			{ enabled: open, refetchOnWindowFocus: false },
		);
	const { mutateAsync: updateServer, isLoading: isUpdatingServer } =
		api.ai.mcpServers.update.useMutation();

	const [testResults, setTestResults] = useState<Record<string, McpTestResult>>(
		{},
	);
	const [testing, setTesting] = useState<Record<string, boolean>>({});
	const testedIdsRef = useRef<Set<string>>(new Set());
	const inFlightTestIdsRef = useRef<Set<string>>(new Set());

	const serverRows = useMemo(() => {
		if (!Array.isArray(servers)) return [];
		return servers.map((s) => ({
			mcpServerId: s.mcpServerId,
			name: s.name,
			serverUrl: s.serverUrl,
			isEnabled: s.isEnabled,
		}));
	}, [servers]);

	const enabledServers = useMemo(() => {
		return serverRows.filter((s) => s.isEnabled);
	}, [serverRows]);

	const runTest = useCallback(async (mcpServerId: string) => {
		const id = String(mcpServerId ?? "").trim();
		if (!id) return;
		if (inFlightTestIdsRef.current.has(id)) return;

		inFlightTestIdsRef.current.add(id);
		setTesting((prev) => ({ ...prev, [id]: true }));
		try {
			const res = (await utils.ai.mcpServers.test.fetch({
				mcpServerId: id,
			})) as McpTestResult;
			setTestResults((prev) => ({ ...prev, [id]: res }));
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			setTestResults((prev) => ({
				...prev,
				[id]: { status: "error", error: errorMessage },
			}));
		} finally {
			setTesting((prev) => ({ ...prev, [id]: false }));
			inFlightTestIdsRef.current.delete(id);
		}
	}, [utils]);

	useEffect(() => {
		if (!open) {
			testedIdsRef.current = new Set();
			inFlightTestIdsRef.current = new Set();
			return;
		}
		if (serverRows.length === 0) return;

		let cancelled = false;
		const run = async () => {
			for (const s of serverRows) {
				if (cancelled) return;
				const id = s.mcpServerId;
				if (!id || testedIdsRef.current.has(id)) continue;
				testedIdsRef.current.add(id);
				await runTest(id);
			}
		};
		void run();

		return () => {
			cancelled = true;
		};
	}, [open, runTest, serverRows]);

	const toggleConversation = async (enabled: boolean) => {
		if (!enabled) {
			await props.setMcpEnabled(false);
			toast.info(t("ai.chat.mcp.disabled"));
			return;
		}

		if (enabledServers.length === 0) {
			toast.error(t("ai.chat.mcp.noEnabledServers"));
			return;
		}

		setIsTogglingConversation(true);
		const toastId = toast.loading(t("ai.chat.mcp.testing"));
		try {
			for (const s of enabledServers) {
				const res = (await utils.ai.mcpServers.test.fetch({
					mcpServerId: s.mcpServerId,
				})) as McpTestResult;
				setTestResults((prev) => ({ ...prev, [s.mcpServerId]: res }));
				if (res.status === "error") {
					throw new Error(`${s.name}: ${res.error ?? "MCP test failed"}`);
				}
			}

			await props.setMcpEnabled(true);
			toast.success(t("ai.chat.mcp.enabled"));
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			toast.error(t("ai.chat.mcp.connectionFailed"), {
				description: errorMessage,
			});
		} finally {
			toast.dismiss(toastId);
			setIsTogglingConversation(false);
		}
	};

	const toggleServer = async (mcpServerId: string, isEnabled: boolean) => {
		const id = mcpServerId.trim();
		if (!id) return;
		try {
			await updateServer({ mcpServerId: id, isEnabled });
			await utils.ai.mcpServers.list.invalidate();
			if (isEnabled) {
				void runTest(id);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			toast.error(t("common.unknownError"), { description: errorMessage });
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant={props.isMcpEnabled ? "secondary" : "ghost"}
					size="icon"
					className={
						props.isMcpEnabled ? "bg-primary/10 text-primary hover:bg-primary/20" : ""
					}
					title={t("ai.chat.mcp.manage")}
					aria-label={t("ai.chat.mcp.manage")}
				>
					<Plug className="h-4 w-4" />
				</Button>
			</DialogTrigger>

			<DialogContent
				noInnerScroll
				className="max-w-xl max-h-[80vh] flex flex-col min-h-0 p-0 gap-0"
			>
				<DialogHeader className="p-6 pb-2">
					<DialogTitle className="flex items-center gap-2">
						<Plug className="h-5 w-5" />
						{t("ai.chat.mcp.dialog.title")}
					</DialogTitle>
					<DialogDescription>
						{t("ai.chat.mcp.dialog.description")}
					</DialogDescription>

					<div className="mt-4 flex items-center justify-between rounded-lg border bg-muted/10 p-3 gap-4">
						<div className="min-w-0">
							<div className="flex items-center gap-2 min-w-0">
								<Plug className="h-4 w-4 text-muted-foreground shrink-0" />
								<span className="text-sm font-medium truncate">
									{t("ai.chat.mcp.useInChat")}
								</span>
							</div>
						</div>
						<Switch
							checked={props.isMcpEnabled}
							onCheckedChange={(v) => void toggleConversation(v)}
							disabled={
								isTogglingConversation ||
								isLoadingServers
							}
						/>
					</div>
				</DialogHeader>

				<ScrollArea
					type="always"
					className="flex-1 min-h-0"
					viewPortClassName="px-6 pb-6"
				>
					{isLoadingServers ? (
						<div className="flex items-center justify-center py-10 text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" />
						</div>
					) : serverRows.length === 0 ? (
						<div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
							<Plug className="h-10 w-10 opacity-20 mb-2" />
							<p>{t("ai.chat.mcp.noServers")}</p>
						</div>
					) : (
						<div className="space-y-2">
							{serverRows.map((server) => {
								const result = testResults[server.mcpServerId];
								const status = result?.status ?? "unknown";
								const toolCount =
									status === "ok" && typeof result?.toolCount === "number"
										? result.toolCount
										: null;
								const isTesting = testing[server.mcpServerId] === true;

								const statusIcon = isTesting ? (
									<Loader2 className="h-3 w-3 animate-spin" />
								) : status === "ok" ? (
									<CheckCircle2 className="h-3 w-3" />
								) : status === "error" ? (
									<XCircle className="h-3 w-3" />
								) : (
									<Circle className="h-3 w-3" />
								);

								const statusVariant =
									status === "ok"
										? "green"
										: status === "error"
											? "red"
											: "blank";

								return (
									<div
										key={server.mcpServerId}
										className="flex items-center justify-between gap-4 rounded-lg border bg-background/40 p-3"
									>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 min-w-0">
												<Server className="h-4 w-4 text-muted-foreground shrink-0" />
												<span className="text-sm font-medium truncate">
													{server.name}
												</span>
												<Badge
													variant={statusVariant}
													className="h-5 px-2 text-[10px] gap-1 tabular-nums"
												>
													{statusIcon}
													{toolCount == null
														? t("ai.chat.mcp.server.toolsUnknown")
														: t("ai.chat.mcp.server.tools", { count: toolCount })}
												</Badge>
											</div>
											<div
												className="mt-1 text-xs text-muted-foreground truncate"
												title={server.serverUrl}
											>
												{server.serverUrl}
											</div>
											{status === "error" && result?.error && (
												<div
													className="mt-1 text-[10px] text-destructive truncate"
													title={result.error}
												>
													{result.error}
												</div>
											)}
										</div>

										<Switch
											checked={server.isEnabled}
											onCheckedChange={(checked) =>
												void toggleServer(server.mcpServerId, checked)
											}
											disabled={isUpdatingServer}
										/>
									</div>
								);
							})}
						</div>
					)}
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
}
