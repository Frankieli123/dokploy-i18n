"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
	CheckCircle2,
	ChevronRight,
	Circle,
	Loader2,
	PenBoxIcon,
	PlusIcon,
	Trash2,
	XCircle,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { CardDescription } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { translateErrorMessage } from "@/utils/error-translation";

const mcpServerSchema = z
	.object({
		transportType: z.enum(["http", "stdio"]).optional().default("http"),
		name: z.string().min(1),
		serverUrl: z.string().optional().default(""),
		headersJson: z.string().optional().default(""),
		command: z.string().optional().default(""),
		envJson: z.string().optional().default(""),
		cwd: z.string().optional().default(""),
		isEnabled: z.boolean().optional().default(true),
	})
	.superRefine((val, ctx) => {
		const transportType = val.transportType ?? "http";
		if (transportType === "stdio") {
			if (!val.command.trim()) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["command"],
					message: "Command is required",
				});
			}
			return;
		}

		const serverUrl = val.serverUrl.trim();
		if (!serverUrl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["serverUrl"],
				message: "Server URL is required",
			});
			return;
		}
		try {
			new URL(serverUrl);
		} catch {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["serverUrl"],
				message: "Invalid URL",
			});
		}
	});

type McpServerFormValues = z.infer<typeof mcpServerSchema>;

type McpServerRow = {
	mcpServerId: string;
	name: string;
	transportType?: string | null;
	serverUrl?: string | null;
	headers?: Record<string, string> | null;
	command?: string | null;
	env?: Record<string, string> | null;
	cwd?: string | null;
	isEnabled: boolean;
};

type McpTestResult = {
	status: "ok" | "error";
	toolCount?: number;
	toolNames?: string[];
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

export const AiMcpServersForm = () => {
	const { t } = useTranslation("settings");
	const utils = api.useUtils();

	const { data: servers, isPending } = api.ai.mcpServers.list.useQuery(
		{ limit: 50, offset: 0 },
		{ refetchOnWindowFocus: false },
	);
	const { mutateAsync: createServer, isPending: isCreating } =
		api.ai.mcpServers.create.useMutation();
	const { mutateAsync: updateServer, isPending: isUpdating } =
		api.ai.mcpServers.update.useMutation();
	const { mutateAsync: deleteServer, isPending: isDeleting } =
		api.ai.mcpServers.delete.useMutation();

	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<McpServerRow | null>(null);

	const [testResults, setTestResults] = useState<Record<string, McpTestResult>>(
		{},
	);
	const [testing, setTesting] = useState<Record<string, boolean>>({});

	const form = useForm<McpServerFormValues>({
		resolver: zodResolver(mcpServerSchema as any) as any,
		defaultValues: {
			transportType: "http",
			name: "",
			serverUrl: "",
			headersJson: "",
			command: "",
			envJson: "",
			cwd: "",
			isEnabled: true,
		},
	});

	const transportType = form.watch("transportType") ?? "http";

	useEffect(() => {
		if (!open) {
			setEditing(null);
			form.reset({
				transportType: "http",
				name: "",
				serverUrl: "",
				headersJson: "",
				command: "",
				envJson: "",
				cwd: "",
				isEnabled: true,
			});
			return;
		}

		if (!editing) return;
		const transportType =
			editing.transportType === "stdio" ? "stdio" : ("http" as const);
		form.reset({
			transportType,
			name: editing.name,
			serverUrl: transportType === "http" ? String(editing.serverUrl ?? "") : "",
			headersJson:
				transportType === "http" && editing.headers && typeof editing.headers === "object"
					? JSON.stringify(editing.headers, null, 2)
					: "",
			command: transportType === "stdio" ? String(editing.command ?? "") : "",
			envJson:
				transportType === "stdio" && editing.env && typeof editing.env === "object"
					? JSON.stringify(editing.env, null, 2)
					: "",
			cwd: transportType === "stdio" ? String(editing.cwd ?? "") : "",
			isEnabled: editing.isEnabled,
		});
	}, [editing, form, open]);

	const totalServers = Array.isArray(servers) ? servers.length : 0;
	const serverRows: McpServerRow[] = useMemo(() => {
		if (!Array.isArray(servers)) return [];
		return servers.map((s) => ({
			mcpServerId: s.mcpServerId,
			name: s.name,
			transportType: (s as any).transportType ?? null,
			serverUrl: (s as any).serverUrl ?? null,
			headers: (s as any).headers ?? null,
			command: (s as any).command ?? null,
			env: (s as any).env ?? null,
			cwd: (s as any).cwd ?? null,
			isEnabled: s.isEnabled,
		}));
	}, [servers]);

	const runTest = async (mcpServerId: string) => {
		setTesting((prev) => ({ ...prev, [mcpServerId]: true }));
		try {
			const res = await utils.ai.mcpServers.test.fetch({ mcpServerId });
			setTestResults((prev) => ({ ...prev, [mcpServerId]: res as McpTestResult }));
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			setTestResults((prev) => ({
				...prev,
				[mcpServerId]: { status: "error", error: errorMessage },
			}));
		} finally {
			setTesting((prev) => ({ ...prev, [mcpServerId]: false }));
		}
	};

	const onSubmit = async (values: McpServerFormValues) => {
		const transportType = values.transportType ?? "http";
		const name = values.name.trim();
		const isEnabled = values.isEnabled ?? true;

		if (transportType === "stdio") {
			const env = safeJsonParseObject(values.envJson ?? "");
			if (env === null) {
				form.setError("envJson", {
					type: "validate",
					message: t("settings.ai.mcpServers.form.envInvalid"),
				});
				return;
			}

			const command = values.command.trim();
			const cwd = values.cwd.trim();
			try {
				if (editing) {
					await updateServer({
						mcpServerId: editing.mcpServerId,
						name,
						command,
						env,
						cwd: cwd.length > 0 ? cwd : null,
						isEnabled,
					});
				} else {
					await createServer({
						transportType: "stdio",
						name,
						command,
						env,
						cwd: cwd.length > 0 ? cwd : null,
						isEnabled,
					});
				}

				await utils.ai.mcpServers.list.invalidate();
				toast.success(t("settings.ai.mcpServers.toast.saveSuccess"));
				setOpen(false);
			} catch (error) {
				const errorMessage =
					error instanceof Error
						? error.message
						: t("settings.ai.toast.unknownError");
				toast.error(t("settings.ai.mcpServers.toast.saveError"), {
					description: translateErrorMessage(errorMessage, t),
				});
			}
			return;
		}

		const headers = safeJsonParseObject(values.headersJson ?? "");
		if (headers === null) {
			form.setError("headersJson", {
				type: "validate",
				message: t("settings.ai.mcpServers.form.headersInvalid"),
			});
			return;
		}

		try {
			if (editing) {
				await updateServer({
					mcpServerId: editing.mcpServerId,
					name,
					serverUrl: values.serverUrl.trim(),
					headers,
					isEnabled,
				});
			} else {
				await createServer({
					transportType: "http",
					name,
					serverUrl: values.serverUrl.trim(),
					headers,
					isEnabled,
				});
			}

			await utils.ai.mcpServers.list.invalidate();
			toast.success(t("settings.ai.mcpServers.toast.saveSuccess"));
			setOpen(false);
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: t("settings.ai.toast.unknownError");
			toast.error(t("settings.ai.mcpServers.toast.saveError"), {
				description: translateErrorMessage(errorMessage, t),
			});
		}
	};

	return (
		<div className="flex flex-col gap-3 w-full">
			<div className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg">
				<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full">
					<div>
						<span className="text-sm font-medium">
							{t("settings.ai.mcpServers.title")}
						</span>
						<CardDescription>
							{totalServers > 0
								? t("settings.ai.mcpServers.count", { count: totalServers })
								: t("settings.ai.mcpServers.empty")}
						</CardDescription>
					</div>

					<Dialog
						open={open}
						onOpenChange={(nextOpen) => {
							setOpen(nextOpen);
							if (!nextOpen) {
								setEditing(null);
							}
						}}
					>
						<DialogTrigger asChild>
							<Button className="cursor-pointer space-x-3">
								<PlusIcon className="h-4 w-4" />
								{t("settings.ai.mcpServers.add")}
							</Button>
						</DialogTrigger>
						<DialogContent className="sm:max-w-lg">
							<DialogHeader>
								<DialogTitle>
									{editing
										? t("settings.ai.mcpServers.form.editTitle")
										: t("settings.ai.mcpServers.form.addTitle")}
								</DialogTitle>
								<DialogDescription>
									{t("settings.ai.mcpServers.form.description")}
								</DialogDescription>
							</DialogHeader>

								<Form {...form}>
									<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
										<FormField
											control={form.control}
											name="name"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													{t("settings.ai.mcpServers.form.name.label")}
												</FormLabel>
												<FormControl>
													<Input
														placeholder={t(
															"settings.ai.mcpServers.form.name.placeholder",
														)}
														{...field}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
											)}
										/>

										<FormField
											control={form.control}
											name="transportType"
											render={({ field }) => (
												<FormItem>
													<FormLabel>
														{t("settings.ai.mcpServers.form.transportType.label")}
													</FormLabel>
													<FormControl>
														<Select
															value={field.value ?? "http"}
															onValueChange={field.onChange}
															disabled={!!editing}
														>
															<SelectTrigger>
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																<SelectItem value="http">
																	{t(
																		"settings.ai.mcpServers.form.transportType.http",
																	)}
																</SelectItem>
																<SelectItem value="stdio">
																	{t(
																		"settings.ai.mcpServers.form.transportType.stdio",
																	)}
																</SelectItem>
															</SelectContent>
														</Select>
													</FormControl>
													<FormDescription>
														{t(
															"settings.ai.mcpServers.form.transportType.description",
														)}
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>

										{transportType === "stdio" ? (
											<>
												<FormField
													control={form.control}
													name="command"
													render={({ field }) => (
														<FormItem>
															<FormLabel>
																{t("settings.ai.mcpServers.form.command.label")}
															</FormLabel>
															<FormControl>
																<Input
																	placeholder={t(
																		"settings.ai.mcpServers.form.command.placeholder",
																	)}
																	{...field}
																/>
															</FormControl>
															<FormDescription>
																{t(
																	"settings.ai.mcpServers.form.command.description",
																)}
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>

												<FormField
													control={form.control}
													name="envJson"
													render={({ field }) => (
														<FormItem>
															<FormLabel>
																{t("settings.ai.mcpServers.form.env.label")}
															</FormLabel>
															<FormControl>
																<Textarea
																	rows={6}
																	placeholder={t(
																		"settings.ai.mcpServers.form.env.placeholder",
																	)}
																	className="font-mono text-xs"
																	{...field}
																/>
															</FormControl>
															<FormDescription>
																{t("settings.ai.mcpServers.form.env.description")}
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>

												<FormField
													control={form.control}
													name="cwd"
													render={({ field }) => (
														<FormItem>
															<FormLabel>
																{t("settings.ai.mcpServers.form.cwd.label")}
															</FormLabel>
															<FormControl>
																<Input
																	placeholder={t(
																		"settings.ai.mcpServers.form.cwd.placeholder",
																	)}
																	{...field}
																/>
															</FormControl>
															<FormDescription>
																{t("settings.ai.mcpServers.form.cwd.description")}
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>
											</>
										) : (
											<>
												<FormField
													control={form.control}
													name="serverUrl"
													render={({ field }) => (
														<FormItem>
															<FormLabel>
																{t(
																	"settings.ai.mcpServers.form.serverUrl.label",
																)}
															</FormLabel>
															<FormControl>
																<Input
																	placeholder={t(
																		"settings.ai.mcpServers.form.serverUrl.placeholder",
																	)}
																	{...field}
																/>
															</FormControl>
															<FormDescription>
																{t(
																	"settings.ai.mcpServers.form.serverUrl.description",
																)}
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>

												<FormField
													control={form.control}
													name="headersJson"
													render={({ field }) => (
														<FormItem>
															<FormLabel>
																{t("settings.ai.mcpServers.form.headers.label")}
															</FormLabel>
															<FormControl>
																<Textarea
																	rows={6}
																	placeholder={t(
																		"settings.ai.mcpServers.form.headers.placeholder",
																	)}
																	className="font-mono text-xs"
																	{...field}
																/>
															</FormControl>
															<FormDescription>
																{t(
																	"settings.ai.mcpServers.form.headers.description",
																)}
															</FormDescription>
															<FormMessage />
														</FormItem>
													)}
												/>
											</>
										)}

										<FormField
											control={form.control}
											name="isEnabled"
										render={({ field }) => (
											<FormItem className="flex items-center justify-between rounded-lg border p-4">
												<div className="space-y-0.5">
													<FormLabel className="text-base">
														{t("settings.ai.mcpServers.form.isEnabled.label")}
													</FormLabel>
													<FormDescription>
														{t(
															"settings.ai.mcpServers.form.isEnabled.description",
														)}
													</FormDescription>
												</div>
												<FormControl>
													<Switch
														checked={field.value ?? true}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
											</FormItem>
										)}
									/>

									<div className="flex justify-end gap-2">
										<Button
											type="button"
											variant="outline"
											onClick={() => setOpen(false)}
										>
											{t("settings.common.cancel")}
										</Button>
										<Button
											type="submit"
											isPending={isCreating || isUpdating}
											disabled={isCreating || isUpdating}
										>
											{t("settings.common.save")}
											<ChevronRight className="ml-2 h-4 w-4" />
										</Button>
									</div>
								</form>
							</Form>
						</DialogContent>
					</Dialog>
				</div>
			</div>

			{isPending ? (
				<div className="flex items-center justify-center text-sm text-muted-foreground min-h-[12vh]">
					<span>{t("settings.common.loading")}</span>
					<Loader2 className="animate-spin size-4 ml-2" />
				</div>
			) : serverRows.length === 0 ? null : (
				<div className="flex flex-col gap-2">
						{serverRows.map((server) => {
							const result = testResults[server.mcpServerId];
							const isTesting = !!testing[server.mcpServerId];
							const status = result?.status ?? "unknown";
							const transportType =
								server.transportType === "stdio" ? "stdio" : "http";
							const subtitle =
								transportType === "stdio"
									? String(server.command ?? "")
									: String(server.serverUrl ?? "");
							return (
								<div
									key={server.mcpServerId}
									className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg"
								>
									<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full">
										<div className="min-w-0">
											<div className="text-sm font-medium truncate">
												{server.name}
											</div>
											<CardDescription className="truncate">
												{`${transportType.toUpperCase()}${
													subtitle.trim().length > 0 ? ` 鈥?${subtitle}` : ""
												}`}
											</CardDescription>
										</div>

									<div className="flex items-center gap-2 shrink-0">
										<TooltipProvider delayDuration={0}>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="icon"
														className="hover:bg-transparent"
														onClick={(e) => {
															e.preventDefault();
															void runTest(server.mcpServerId);
														}}
													>
														{isTesting && (
															<Loader2 className="size-4 animate-spin text-muted-foreground" />
														)}
														{!isTesting && status === "ok" && (
															<CheckCircle2 className="size-4 text-green-500" />
														)}
														{!isTesting && status === "error" && (
															<XCircle className="size-4 text-red-500" />
														)}
														{!isTesting && status === "unknown" && (
															<Circle className="size-4 text-muted-foreground" />
														)}
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{isTesting && t("settings.ai.mcpServers.test.testing")}
													{!isTesting && status === "ok" && (
														<div className="flex flex-col gap-1 text-xs max-w-[260px]">
															<span className="font-semibold text-green-500">
																{t("settings.ai.mcpServers.test.status.ok")}
															</span>
															{typeof result?.toolCount === "number" && (
																<span>
																	{t("settings.ai.mcpServers.test.tools")}:{" "}
																	{result.toolCount}
																</span>
															)}
															{typeof result?.latencyMs === "number" && (
																<span>
																	{t("settings.ai.mcpServers.test.latency")}:{" "}
																	{result.latencyMs}ms
																</span>
															)}
															{Array.isArray(result?.toolNames) &&
																result.toolNames.length > 0 && (
																	<span className="break-words">
																		{result.toolNames.join(", ")}
																	</span>
																)}
														</div>
													)}
													{!isTesting && status === "error" && (
														<div className="flex flex-col gap-1 text-xs max-w-[260px]">
															<span className="font-semibold text-red-500">
																{t("settings.ai.mcpServers.test.status.error")}
															</span>
															{result?.error && (
																<span className="break-words">
																	{result.error}
																</span>
															)}
														</div>
													)}
													{!isTesting && status === "unknown" && (
														<span className="text-xs">
															{t("settings.ai.mcpServers.test.status.unknown")}
														</span>
													)}
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>

										<Switch
											checked={server.isEnabled}
											onCheckedChange={(checked) => {
												void updateServer({
													mcpServerId: server.mcpServerId,
													isEnabled: checked,
												})
													.then(() => utils.ai.mcpServers.list.invalidate())
													.catch(() => {});
											}}
										/>

										<Button
											variant="ghost"
											size="icon"
											className="group hover:bg-blue-500/10"
											onClick={() => {
												setEditing(server);
												setOpen(true);
											}}
										>
											<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
										</Button>

										<DialogAction
											title={t("settings.ai.mcpServers.delete.title")}
											description={t("settings.ai.mcpServers.delete.description")}
											type="destructive"
											onClick={async () => {
												await deleteServer({ mcpServerId: server.mcpServerId })
													.then(() => {
														toast.success(
															t("settings.ai.mcpServers.delete.success"),
														);
														utils.ai.mcpServers.list.invalidate();
													})
													.catch((error) => {
														const message =
															error instanceof Error
																? error.message
																: String(error);
														toast.error(
															t("settings.ai.mcpServers.delete.error"),
															{
																description: translateErrorMessage(message, t),
															},
														);
													});
											}}
										>
											<Button
												variant="ghost"
												size="icon"
												className={cn(
													"group hover:bg-red-500/10",
													isDeleting && "opacity-50 pointer-events-none",
												)}
											>
												<Trash2 className="size-4 text-primary group-hover:text-red-500" />
											</Button>
										</DialogAction>
									</div>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

