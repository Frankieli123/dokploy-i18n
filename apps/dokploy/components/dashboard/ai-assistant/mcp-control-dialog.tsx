"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	CheckCircle2,
	Circle,
	Loader2,
	Plug,
	Plus,
	Server,
	XCircle,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

type McpTestResult = {
	status: "ok" | "error";
	toolCount?: number;
	latencyMs?: number;
	error?: string;
};

function safeJsonParseObject(input: string): Record<string, string> | null {
	const trimmed = input.trim();
	if (!trimmed) return {};
	let value: unknown;
	try {
		value = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		const key = String(k ?? "").trim();
		if (!key) continue;
		out[key] = typeof v === "string" ? v : v == null ? "" : String(v);
	}
	return out;
}

export function McpControlDialog() {
	const { t } = useTranslation("common");
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"list" | "add">("list");

	const {
		data: servers,
		isLoading: isLoadingServers,
		isError: isServersError,
		error: serversError,
		refetch: refetchServers,
	} =
		api.ai.mcpServers.list.useQuery(
			{ limit: 100, offset: 0 },
			{
				enabled: open,
				refetchOnWindowFocus: false,
				retry: false,
				staleTime: 60_000,
			},
		);
	const { mutateAsync: createServer, isLoading: isCreatingServer } =
		api.ai.mcpServers.create.useMutation();
	const { mutateAsync: updateServer, isLoading: isUpdatingServer } =
		api.ai.mcpServers.update.useMutation();

	const [formName, setFormName] = useState("");
	const [formUrl, setFormUrl] = useState("");
	const [formHeaders, setFormHeaders] = useState("");
	const [formEnabled, setFormEnabled] = useState(true);

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
	const hasEnabledServers = enabledServers.length > 0;

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
			setView("list");
			setFormName("");
			setFormUrl("");
			setFormHeaders("");
			setFormEnabled(true);
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

	const submitAdd = async () => {
		const name = formName.trim();
		const serverUrl = formUrl.trim();
		if (!name || !serverUrl) return;

		const headers = safeJsonParseObject(formHeaders);
		if (headers === null) {
			toast.error(t("ai.chat.mcp.form.headersInvalid"));
			return;
		}

		try {
			const created = await createServer({
				name,
				serverUrl,
				headers,
				isEnabled: formEnabled,
			});
			await utils.ai.mcpServers.list.invalidate();
			setFormName("");
			setFormUrl("");
			setFormHeaders("");
			setFormEnabled(true);
			setView("list");
			toast.success(t("ai.chat.mcp.form.created"));
			if (created?.mcpServerId) {
				void runTest(created.mcpServerId);
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
					variant={hasEnabledServers ? "secondary" : "ghost"}
					size="icon"
					className={cn(
						"h-8 w-8 p-0",
						hasEnabledServers &&
							"bg-primary/10 text-primary hover:bg-primary/20",
					)}
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

					<div className="mt-4 flex items-center justify-between gap-2">
						<div className="text-xs text-muted-foreground">
							{isLoadingServers
								? t("common.loading")
								: t("ai.chat.mcp.panel.count", { count: serverRows.length })}
						</div>
						{view === "list" ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 px-2 text-xs gap-1"
								onClick={() => setView("add")}
							>
								<Plus className="h-3 w-3" />
								{t("ai.chat.mcp.panel.add")}
							</Button>
						) : (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
								onClick={() => setView("list")}
							>
								{t("button.back")}
							</Button>
						)}
					</div>
					{view === "list" && (
						<div className="mt-1 text-xs text-muted-foreground">
							{t("ai.chat.mcp.panel.hint")}
						</div>
					)}
				</DialogHeader>

				<ScrollArea
					type="always"
					className="flex-1 min-h-0"
					viewPortClassName="px-6 pb-6"
				>
					{view === "add" ? (
						<div className="space-y-4">
							<div className="text-sm font-medium">
								{t("ai.chat.mcp.form.addTitle")}
							</div>

							<div className="space-y-2">
								<Label htmlFor="mcp-name">{t("ai.chat.mcp.form.nameLabel")}</Label>
								<Input
									id="mcp-name"
									value={formName}
									placeholder={t("ai.chat.mcp.form.namePlaceholder")}
									onChange={(e) => setFormName(e.target.value)}
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="mcp-url">{t("ai.chat.mcp.form.urlLabel")}</Label>
								<Input
									id="mcp-url"
									value={formUrl}
									placeholder={t("ai.chat.mcp.form.urlPlaceholder")}
									onChange={(e) => setFormUrl(e.target.value)}
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="mcp-headers">
									{t("ai.chat.mcp.form.headersLabel")}
								</Label>
								<Textarea
									id="mcp-headers"
									value={formHeaders}
									placeholder={t("ai.chat.mcp.form.headersPlaceholder")}
									onChange={(e) => setFormHeaders(e.target.value)}
									className="min-h-[96px] font-mono text-xs"
								/>
							</div>

							<div className="flex items-center justify-between rounded-lg border bg-muted/10 p-3">
								<div className="text-sm">
									{t("ai.chat.mcp.form.enabledLabel")}
								</div>
								<Switch
									checked={formEnabled}
									onCheckedChange={(v) => setFormEnabled(v)}
									disabled={isCreatingServer}
								/>
							</div>

							<div className="flex justify-end gap-2 pt-2">
								<Button
									type="button"
									variant="ghost"
									className="h-8"
									onClick={() => setView("list")}
									disabled={isCreatingServer}
								>
									{t("button.cancel")}
								</Button>
								<Button
									type="button"
									className="h-8"
									onClick={() => void submitAdd()}
									disabled={
										isCreatingServer ||
										formName.trim().length === 0 ||
										formUrl.trim().length === 0
									}
								>
									{isCreatingServer && (
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									)}
									{t("button.create")}
								</Button>
							</div>
						</div>
					) : isLoadingServers ? (
						<div className="flex items-center justify-center py-10 text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin" />
						</div>
					) : isServersError ? (
						<div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
							<XCircle className="h-10 w-10 opacity-20 mb-2" />
							<p className="text-sm">{t("common.unknownError")}</p>
							{serversError?.message && (
								<p className="mt-1 max-w-full text-[10px] text-muted-foreground/80 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
									{serversError.message}
								</p>
							)}
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="mt-3 h-7 px-2 text-xs"
								onClick={() => void refetchServers()}
							>
								{t("ai.chat.retry")}
							</Button>
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
