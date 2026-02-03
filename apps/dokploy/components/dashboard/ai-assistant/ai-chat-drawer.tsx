"use client";

import {
	AlertTriangle,
	Bot,
	Check,
	History,
	Laptop,
	Loader2,
	MessageSquare,
	MessageSquarePlus,
	Plus,
	Search,
	Send,
	ShieldAlert,
	ShieldCheck,
	Square,
	X,
} from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";
import { translateErrorMessage } from "@/utils/error-translation";
import { MessageBubble } from "./message-bubble";
import { TracePanel } from "./trace-panel";
import { ToolExecutionHistory } from "./tool-execution-history";
import { useChat } from "./use-chat";

type DraftImage = {
	id: string;
	file: File;
	previewUrl: string;
};

interface AIChatDrawerProps {
	projectId?: string;
	serverId?: string;
}

export function AIChatDrawer({
	projectId: _projectId,
	serverId: _serverId,
}: AIChatDrawerProps) {
	const router = useRouter();
	const { t } = useTranslation("common");
	const [isOpen, setIsOpen] = useState(false);
	const SERVER_CONTEXT_STORAGE_KEY = "dokploy.ai.serverContext.v2";
	const LOCAL_SERVER_CONTEXT = "local";
	const [autoLoadHistory, setAutoLoadHistory] = useState(true);
	const [input, setInput] = useState("");
	const [selectedAiId, setSelectedAiId] = useState<string>("");
	const [isAgentMode, setIsAgentMode] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);
	const isNearBottomRef = useRef(true);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
	const draftImagesRef = useRef<DraftImage[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const MAX_IMAGE_ATTACHMENTS = 4;
	const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

	const clearDraftImages = useCallback(() => {
		setDraftImages((prev) => {
			for (const img of prev) {
				try {
					URL.revokeObjectURL(img.previewUrl);
				} catch {}
			}
			return [];
		});
	}, []);

	useEffect(() => {
		draftImagesRef.current = draftImages;
	}, [draftImages]);

	useEffect(() => {
		return () => {
			for (const img of draftImagesRef.current) {
				try {
					URL.revokeObjectURL(img.previewUrl);
				} catch {}
			}
		};
	}, []);

	useEffect(() => {
		if (!isOpen) {
			setAutoLoadHistory(true);
			clearDraftImages();
		}
	}, [clearDraftImages, isOpen]);

	const routeProjectId =
		typeof router.query.projectId === "string"
			? router.query.projectId
			: Array.isArray(router.query.projectId)
				? router.query.projectId[0]
				: undefined;
	const routeServerId =
		typeof router.query.serverId === "string"
			? router.query.serverId
			: Array.isArray(router.query.serverId)
				? router.query.serverId[0]
				: undefined;

	const projectId = _projectId ?? routeProjectId;
	const routeBoundServerId = _serverId ?? routeServerId;
	const [serverContext, setServerContext] = useState<string>(() => {
		if (typeof window === "undefined") return LOCAL_SERVER_CONTEXT;
		try {
			const saved = localStorage.getItem(SERVER_CONTEXT_STORAGE_KEY) ?? "";
			return saved.trim().length > 0 ? saved.trim() : LOCAL_SERVER_CONTEXT;
		} catch {
			return LOCAL_SERVER_CONTEXT;
		}
	});

	const effectiveServerId =
		serverContext === LOCAL_SERVER_CONTEXT ? undefined : serverContext;

	useEffect(() => {
		if (!isOpen) return;
		const bound =
			typeof routeBoundServerId === "string" ? routeBoundServerId.trim() : "";
		if (!bound) return;
		if (serverContext !== LOCAL_SERVER_CONTEXT) return;
		setServerContext(bound);
	}, [isOpen, routeBoundServerId, serverContext]);

	const { data: serversForDefaultPick } = api.server.all.useQuery(undefined, {
		enabled: isOpen,
	});

	useEffect(() => {
		if (!isOpen) return;
		if (!serversForDefaultPick) return;
		if (serverContext === LOCAL_SERVER_CONTEXT) return;
		const exists = serversForDefaultPick.some(
			(s) => s.serverId === serverContext,
		);
		if (exists) return;
		setServerContext(LOCAL_SERVER_CONTEXT);
		try {
			localStorage.setItem(SERVER_CONTEXT_STORAGE_KEY, LOCAL_SERVER_CONTEXT);
		} catch {}
	}, [isOpen, serversForDefaultPick, serverContext]);

	// Lazy load AI configs only when drawer is open
	const { data: aiConfigs, isLoading: isLoadingConfigs } =
		api.ai.getAll.useQuery(undefined, {
			enabled: isOpen,
		});

	const {
		messages,
		isLoading,
		conversationId,
		areToolApprovalsDisabled,
		setToolApprovalsDisabled,
		send,
		reset,
		retryMessage,
		approveToolCall,
		rejectToolCall,
		stopGeneration,
		openConversation,
		pendingApproval,
		approvePending,
		rejectPending,
		traceEvents,
	} = useChat({
		onError: (error) => {
			const errorMessage = error.message || t("ai.chat.sendError");
			toast.error(translateErrorMessage(errorMessage, t));
		},
		projectId,
		serverId: effectiveServerId,
		enabled: isOpen,
		uiVisible: isOpen,
		autoLoad: autoLoadHistory,
	});

	const serversForPicker = useMemo(() => {
		const servers = serversForDefaultPick ?? [];
		const score = (s: (typeof servers)[number]) => {
			const status = String((s as any).serverStatus ?? "").toLowerCase();
			const type = String((s as any).serverType ?? "").toLowerCase();
			const statusScore = status === "active" ? 0 : 10;
			const typeScore = type === "deploy" ? 0 : 5;
			return statusScore + typeScore;
		};
		return [...servers].sort((a, b) => score(a) - score(b));
	}, [serversForDefaultPick]);

	const currentServerLabel = useMemo(() => {
		if (serverContext === LOCAL_SERVER_CONTEXT) {
			return t("server.local");
		}
		const match = (serversForDefaultPick ?? []).find(
			(s) => s.serverId === serverContext,
		);
		const name = (match as any)?.name;
		return typeof name === "string" && name.trim().length > 0
			? name
			: serverContext;
	}, [LOCAL_SERVER_CONTEXT, serverContext, serversForDefaultPick, t]);

	// Auto-select first AI config
	useEffect(() => {
		if (aiConfigs && aiConfigs.length > 0 && !selectedAiId) {
			const enabledConfig = aiConfigs.find((c) => c.isEnabled);
			if (enabledConfig) {
				setSelectedAiId(enabledConfig.aiId);
			}
		}
	}, [aiConfigs, selectedAiId]);

	// Track scroll position
	const handleViewportScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			const target = e.currentTarget;
			const threshold = 100;
			isNearBottomRef.current =
				target.scrollHeight - target.scrollTop - target.clientHeight <
				threshold;
		},
		[],
	);

	// Smart auto-scroll - only if near bottom
	useEffect(() => {
		if (viewportRef.current && isNearBottomRef.current) {
			viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
		}
	}, [messages]);

	useEffect(() => {
		if (!isOpen) return;
		if (!viewportRef.current) return;
		viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
	}, [isOpen]);

	const addDraftImages = useCallback(
		(files: File[]) => {
			if (files.length === 0) return;

			setDraftImages((prev) => {
				const remaining = MAX_IMAGE_ATTACHMENTS - prev.length;
				if (remaining <= 0) {
					toast.error(`Max ${MAX_IMAGE_ATTACHMENTS} images allowed`);
					return prev;
				}

				const next: DraftImage[] = [];
				for (const file of files) {
					if (!file.type.startsWith("image/")) continue;
					if (file.size > MAX_IMAGE_BYTES) {
						toast.error(
							`Max ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)}MB per image`,
						);
						continue;
					}
					if (next.length >= remaining) break;
					const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
					next.push({ id, file, previewUrl: URL.createObjectURL(file) });
				}
				return [...prev, ...next];
			});
		},
		[MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES],
	);

	const handleSelectImages = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const picked = Array.from(e.target.files ?? []);
			addDraftImages(picked);
			e.target.value = "";
		},
		[addDraftImages],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const items = e.clipboardData?.items;
			if (!items) return;

			const files: File[] = [];
			for (let index = 0; index < items.length; index++) {
				const item = items[index];
				if (item?.kind !== "file") continue;
				if (!item.type.startsWith("image/")) continue;
				const file = item.getAsFile();
				if (file) files.push(file);
			}

			if (files.length === 0) return;

			const text = e.clipboardData?.getData("text/plain") ?? "";
			const hasText = typeof text === "string" && text.length > 0;
			if (!hasText) {
				e.preventDefault();
			}
			addDraftImages(files);
		},
		[addDraftImages],
	);

	const removeDraftImage = useCallback((id: string) => {
		setDraftImages((prev) => {
			const target = prev.find((img) => img.id === id);
			if (target) {
				try {
					URL.revokeObjectURL(target.previewUrl);
				} catch {}
			}
			return prev.filter((img) => img.id !== id);
		});
	}, []);

	const handleSend = async () => {
		const trimmedInput = input.trim();
		if (trimmedInput.length === 0 && draftImages.length === 0) return;

		const normalized = trimmedInput.toLowerCase();
		const isApproveCommand =
			normalized === "批准" ||
			normalized === "同意" ||
			normalized === "approve" ||
			normalized === "approved";
		const isRejectCommand =
			normalized === "拒绝" ||
			normalized === "不同意" ||
			normalized === "reject" ||
			normalized === "rejected";

		if (draftImages.length === 0 && (isApproveCommand || isRejectCommand)) {
			const pendingToolCallId = (() => {
				for (const msg of messages) {
					for (const tc of msg.toolCalls || []) {
						const status =
							tc.status ?? (tc.executionId ? "pending" : "completed");
						if (status !== "pending") continue;
						const executionId = (() => {
							if (
								typeof tc.executionId === "string" &&
								tc.executionId.trim().length > 0
							) {
								return tc.executionId.trim();
							}
							const data = tc.result?.data;
							if (!data || typeof data !== "object" || Array.isArray(data)) {
								return "";
							}
							const v = (data as { executionId?: unknown }).executionId;
							return typeof v === "string" && v.trim().length > 0
								? v.trim()
								: "";
						})();
						if (!executionId) continue;
						return tc.id;
					}
				}
				return "";
			})();

			if (pendingToolCallId) {
				setInput("");
				if (isApproveCommand) {
					await approveToolCall(pendingToolCallId);
				} else {
					await rejectToolCall(pendingToolCallId);
				}
				return;
			}
		}

		if (!selectedAiId || isLoading) return;

		type ImageAttachment = {
			type: "image";
			data: string;
			mediaType: string;
			name: string;
			size: number;
		};

		const toDataUrl = (file: File) =>
			new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result ?? ""));
				reader.onerror = () => reject(new Error("Failed to read image"));
				reader.readAsDataURL(file);
			});

		const parseBase64DataUrl = (
			dataUrl: string,
		): { mediaType: string; data: string } | null => {
			const match = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl.trim());
			if (!match) return null;
			return { mediaType: match[1] ?? "", data: match[2] ?? "" };
		};

		const maybeAttachments = await Promise.all(
			draftImages.map(async (img) => {
				try {
					const parsed = parseBase64DataUrl(await toDataUrl(img.file));
					if (!parsed) return null;
					if (!parsed.mediaType.startsWith("image/")) return null;
					if (!parsed.data) return null;
					return {
						type: "image",
						data: parsed.data,
						mediaType: parsed.mediaType,
						name: img.file.name,
						size: img.file.size,
					} satisfies ImageAttachment;
				} catch {
					return null;
				}
			}),
		);
		const attachments = maybeAttachments.filter(
			(att): att is ImageAttachment => att != null,
		);

		const message = trimmedInput;
		setInput("");
		clearDraftImages();
		await send(message, selectedAiId, isAgentMode, attachments);
	};

	const handleKeyPress = (e: React.KeyboardEvent) => {
		if ((e.nativeEvent as { isComposing?: boolean }).isComposing) {
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
	};

	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.style.height = "auto";
		const maxHeight = 180;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	}, [input]);

	const handleRetry = async (messageId: string) => {
		if (selectedAiId) {
			await retryMessage(messageId, selectedAiId, isAgentMode);
		}
	};

	const hasAiConfigs = aiConfigs && aiConfigs.length > 0;

	return (
		<Sheet open={isOpen} onOpenChange={setIsOpen}>
			<SheetTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg hover:shadow-xl transition-shadow z-50"
					aria-label={t("ai.chat.openAssistant")}
				>
					<Bot className="h-6 w-6" />
				</Button>
			</SheetTrigger>
			<SheetContent
				hideClose
				className="w-full sm:w-[440px] p-0 flex flex-col gap-0 overflow-x-hidden"
			>
				<SheetHeader className="px-4 py-3">
					<div className="flex items-center justify-between gap-2 min-w-0">
						<SheetTitle className="flex items-center gap-2 min-w-0 flex-1">
							<Bot className="h-5 w-5" />
							<span className="truncate whitespace-nowrap">
								{t("ai.chat.title")}
							</span>
						</SheetTitle>
						<div className="flex items-center gap-0 shrink-0">
							<ConversationHistoryDialog
								projectId={projectId}
								serverId={effectiveServerId}
								currentConversationId={conversationId}
								onSelect={(nextId) => {
									setAutoLoadHistory(false);
									openConversation(nextId);
								}}
							/>
							<ToolExecutionHistory messages={messages} />
							<TracePanel events={traceEvents} />
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									setAutoLoadHistory(false);
									reset();
								}}
								className="h-8 w-8 p-0 -ml-1"
								title={t("ai.chat.newConversation")}
								aria-label={t("ai.chat.newConversation")}
							>
								<MessageSquarePlus className="h-4 w-4" />
							</Button>
						</div>
					</div>
					{hasAiConfigs && (
						<Select value={selectedAiId} onValueChange={setSelectedAiId}>
							<SelectTrigger
								className="w-full mt-2"
								aria-label={t("ai.chat.selectModel")}
							>
								<SelectValue placeholder={t("ai.chat.selectModel")} />
							</SelectTrigger>
							<SelectContent>
								{aiConfigs
									.filter((c) => c.isEnabled)
									.map((config) => (
										<SelectItem key={config.aiId} value={config.aiId}>
											{config.name} ({config.model})
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					)}
				</SheetHeader>

				<ScrollArea
					className="flex-1 min-h-0"
					viewPortClassName="p-4 overflow-x-hidden min-w-0 max-w-full [&>div]:!block [&>div]:!w-full [&>div]:!min-w-0 [&>div]:!max-w-full"
					viewportRef={viewportRef}
					onViewportScroll={handleViewportScroll}
					role="log"
					aria-live="polite"
					aria-label={t("ai.chat.messagesAriaLabel")}
				>
					{!hasAiConfigs && !isLoadingConfigs ? (
						<div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-4 py-20">
							<Bot className="h-12 w-12" />
							<div>
								<p className="font-medium">{t("ai.chat.noConfigured")}</p>
								<p className="text-sm">{t("ai.chat.goToSettings")}</p>
							</div>
						</div>
					) : isLoadingConfigs ? (
						<div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-4 py-20">
							<Loader2 className="h-8 w-8 animate-spin" />
							<p className="text-sm">{t("common.loading")}</p>
						</div>
					) : messages.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-6 px-8">
							<div className="bg-primary/10 p-4 rounded-full">
								<Bot className="h-12 w-12 text-primary" />
							</div>
							<div className="space-y-2">
								<p className="font-medium text-lg text-foreground">
									{t("ai.chat.welcomeTitle")}
								</p>
								<p className="text-sm leading-relaxed max-w-[280px] mx-auto">
									{t("ai.chat.welcomeDescription")}
								</p>
							</div>
						</div>
					) : (
						<div className="space-y-1">
							{messages.map((message, index) => (
								<div key={message.messageId}>
									<MessageBubble
										message={message}
										onApproveToolCall={approveToolCall}
										onRejectToolCall={rejectToolCall}
										isLast={index === messages.length - 1}
										onRetry={() => handleRetry(message.messageId)}
										areToolApprovalsDisabled={areToolApprovalsDisabled}
									/>
								</div>
							))}
						</div>
					)}
				</ScrollArea>

				{pendingApproval && (
					<div className="mx-4 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
						<div className="flex items-start gap-2 text-amber-900 dark:text-amber-200">
							<AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
							<div className="min-w-0 flex-1">
								<div className="text-sm font-medium">
									{t("ai.toolCall.pendingApproval")}
								</div>
								{pendingApproval.toolName.trim().length > 0 && (
									<div className="mt-1 text-xs">
										<span className="opacity-80">Tool:</span>{" "}
										<span className="font-mono break-words [overflow-wrap:anywhere]">
											{pendingApproval.toolName}
										</span>
									</div>
								)}
								{pendingApproval.parametersPreview && (
									<pre className="mt-2 max-h-32 overflow-y-auto rounded bg-background/60 p-2 text-xs font-mono whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
										{pendingApproval.parametersPreview}
									</pre>
								)}
							</div>
						</div>
						<div className="mt-2 flex gap-2 justify-end">
							<Button
								size="sm"
								variant="outline"
								onClick={rejectPending}
								className="h-7 text-xs border-amber-500/30 hover:bg-amber-500/10 hover:text-destructive hover:border-destructive/50"
							>
								<X className="mr-1 h-3 w-3" />
								{t("ai.toolCall.reject")}
							</Button>
							<Button
								size="sm"
								onClick={approvePending}
								className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white"
							>
								<Check className="mr-1 h-3 w-3" />
								{t("ai.toolCall.reviewApprove")}
							</Button>
						</div>
					</div>
				)}

				<div className="border-t p-4">
					<div
						className="flex flex-col gap-2"
						onMouseDown={(e) => {
							const textarea = inputRef.current;
							if (!textarea || textarea.disabled) return;
							const target = e.target as HTMLElement | null;
							if (!target) return;
							if (target.closest("textarea,input,button,a,[role='button']")) {
								return;
							}
							textarea.focus();
						}}
					>
						{draftImages.length > 0 && (
							<div className="flex gap-2 overflow-x-auto pb-1">
								{draftImages.map((img) => (
									<div
										key={img.id}
										className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border"
									>
										{/* biome-ignore lint/performance/noImgElement: preview thumbnails */}
										<img
											src={img.previewUrl}
											alt={img.file.name || "attachment"}
											className="h-full w-full object-cover"
										/>
										<Button
											type="button"
											variant="secondary"
											size="icon"
											className="absolute right-1 top-1 h-6 w-6 rounded-full bg-background/80 hover:bg-background"
											onClick={() => removeDraftImage(img.id)}
											aria-label={t("common.delete")}
										>
											<X className="h-3 w-3" />
										</Button>
									</div>
								))}
							</div>
						)}

						<div className="flex items-end gap-2">
							<div className="flex-1 rounded-md bg-input px-4 py-2.5">
								<Textarea
									ref={inputRef}
									value={input}
									onChange={(e) => setInput(e.target.value)}
									onKeyDown={handleKeyPress}
									onPaste={handlePaste}
									rows={1}
									placeholder={
										hasAiConfigs
											? t("ai.chat.inputPlaceholder")
											: t("ai.chat.configureFirst")
									}
									disabled={!hasAiConfigs || isLoading || !!pendingApproval}
									className="min-h-[20px] max-h-[180px] resize-none overflow-y-auto border-0 bg-transparent p-0 shadow-none focus-visible:ring-0"
									aria-label={t("ai.chat.inputLabel")}
								/>
							</div>

							<div className="shrink-0">
								{isLoading ? (
									<Button
										onClick={stopGeneration}
										variant="destructive"
										size="icon"
										className="rounded-md"
										aria-label={t("common.stop")}
									>
										<Square className="h-4 w-4 fill-current" />
									</Button>
								) : (
									<Button
										onClick={handleSend}
										disabled={
											!hasAiConfigs ||
											!!pendingApproval ||
											(input.trim().length === 0 && draftImages.length === 0)
										}
										size="icon"
										className="rounded-md bg-muted-foreground text-background hover:bg-muted-foreground/90"
										aria-label={t("ai.chat.sendMessage")}
									>
										<Send className="h-4 w-4" />
									</Button>
								)}
							</div>
						</div>
					</div>

					<div className="mt-2 flex min-w-0 items-center gap-2 overflow-x-auto no-scrollbar">
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={handleSelectImages}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
							disabled={!hasAiConfigs || isLoading || !!pendingApproval}
							onClick={() => fileInputRef.current?.click()}
							title="Attach images"
							aria-label="Attach images"
						>
							<Plus className="h-5 w-5" />
						</Button>

						<Select
							value={isAgentMode ? "agent" : "chat"}
							onValueChange={(v) => setIsAgentMode(v === "agent")}
							disabled={!hasAiConfigs || isLoading || !!pendingApproval}
						>
							<SelectTrigger className="h-8 w-auto shrink-0 gap-2 rounded-full border-0 bg-secondary/50 px-3 text-xs shadow-none hover:bg-secondary/80 focus-visible:ring-0 focus-visible:ring-offset-0">
								<SelectValue>
									<span className="flex items-center gap-1.5">
										{isAgentMode ? (
											<Bot className="h-3.5 w-3.5" />
										) : (
											<MessageSquare className="h-3.5 w-3.5" />
										)}
										<span>
											{isAgentMode
												? t("ai.chat.mode.agent")
												: t("ai.chat.mode.chat")}
										</span>
									</span>
								</SelectValue>
							</SelectTrigger>
							<SelectContent side="top" align="start">
								<SelectItem value="chat">
									<div className="flex items-center gap-2">
										<MessageSquare className="h-4 w-4" />
										<span>{t("ai.chat.mode.chat")}</span>
									</div>
								</SelectItem>
								<SelectItem value="agent">
									<div className="flex items-center gap-2">
										<Bot className="h-4 w-4" />
										<span>{t("ai.chat.mode.agent")}</span>
									</div>
								</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={areToolApprovalsDisabled ? "auto" : "manual"}
							onValueChange={(v) => void setToolApprovalsDisabled(v === "auto")}
							disabled={!hasAiConfigs || isLoading || !!pendingApproval}
						>
							<SelectTrigger className="h-8 w-auto shrink-0 gap-2 rounded-full border-0 bg-secondary/50 px-3 text-xs shadow-none hover:bg-secondary/80 focus-visible:ring-0 focus-visible:ring-offset-0">
								<SelectValue>
									<span className="flex items-center gap-1.5">
										{areToolApprovalsDisabled ? (
											<ShieldCheck className="h-3.5 w-3.5" />
										) : (
											<ShieldAlert className="h-3.5 w-3.5" />
										)}
										<span>
											{areToolApprovalsDisabled
												? t("ai.chat.toolApprovals.auto")
												: t("ai.chat.toolApprovals.manual")}
										</span>
									</span>
								</SelectValue>
							</SelectTrigger>
							<SelectContent side="top" align="start">
								<SelectItem value="manual">
									<div className="flex items-center gap-2">
										<ShieldAlert className="h-4 w-4" />
										<span>{t("ai.chat.toolApprovals.manual")}</span>
									</div>
								</SelectItem>
								<SelectItem value="auto">
									<div className="flex items-center gap-2">
										<ShieldCheck className="h-4 w-4" />
										<span>{t("ai.chat.toolApprovals.auto")}</span>
									</div>
								</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={serverContext}
							onValueChange={(next) => {
								const normalized =
									typeof next === "string" && next.trim().length > 0
										? next.trim()
										: LOCAL_SERVER_CONTEXT;
								setServerContext(normalized);
								try {
									localStorage.setItem(SERVER_CONTEXT_STORAGE_KEY, normalized);
								} catch {}
							}}
						>
							<SelectTrigger
								className="h-8 w-auto max-w-[140px] shrink-0 gap-2 rounded-full border-0 bg-secondary/50 px-3 text-xs shadow-none hover:bg-secondary/80 focus-visible:ring-0 focus-visible:ring-offset-0"
								aria-label={t("server.select")}
							>
								<SelectValue>
									<span className="flex items-center gap-2 whitespace-nowrap">
										<Laptop className="h-3.5 w-3.5 shrink-0 opacity-70" />
										<span className="truncate">{currentServerLabel}</span>
									</span>
								</SelectValue>
							</SelectTrigger>
							<SelectContent side="top" align="start">
								<SelectItem value={LOCAL_SERVER_CONTEXT}>
									{t("server.local")}
								</SelectItem>
								{serversForPicker.map((s) => (
									<SelectItem key={s.serverId} value={s.serverId}>
										{(s as any).name || s.serverId}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}

function ConversationHistoryDialog(props: {
	projectId?: string;
	serverId?: string;
	currentConversationId?: string;
	onSelect: (conversationId: string) => void;
}) {
	const { t } = useTranslation("common");
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const { data: conversations, isLoading } = api.ai.conversations.list.useQuery(
		{
			status: "active",
			limit: 20,
			offset: 0,
		},
		{
			enabled: open,
			refetchOnWindowFocus: false,
		},
	);

	useEffect(() => {
		if (!open) {
			setSearch("");
		}
	}, [open]);

	const filteredConversations = useMemo(() => {
		if (!conversations) return [];
		const s = search.trim().toLowerCase();
		if (s.length === 0) return conversations;
		return conversations.filter((c) => {
			const title =
				typeof c.title === "string" && c.title.trim().length > 0
					? c.title
					: t("ai.chat.untitled");
			return title.toLowerCase().includes(s);
		});
	}, [conversations, search, t]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8 p-0"
					title={t("ai.chat.history")}
					aria-label={t("ai.chat.history")}
				>
					<History className="h-4 w-4" />
				</Button>
			</DialogTrigger>
			<DialogContent
				noInnerScroll
				className="max-w-md max-h-[80vh] flex flex-col min-h-0 p-0 gap-0"
			>
				<DialogHeader className="p-6 pb-2">
					<DialogTitle className="flex items-center gap-2">
						<History className="h-5 w-5" />
						{t("ai.chat.historyTitle")}
					</DialogTitle>
					<DialogDescription>
						{t("ai.chat.historyDescription")}
					</DialogDescription>
					<div className="relative mt-4">
						<Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
						<Input
							placeholder={t("search.placeholder")}
							className="pl-8"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
						/>
					</div>
				</DialogHeader>

				<ScrollArea className="flex-1 min-h-0" viewPortClassName="p-6 pt-2">
					<div className="space-y-2">
						{isLoading ? (
							<div className="flex items-center justify-center py-10 text-muted-foreground">
								<Loader2 className="h-6 w-6 animate-spin" />
							</div>
						) : !conversations || conversations.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
								<History className="h-10 w-10 opacity-20 mb-2" />
								<p>{t("ai.chat.noHistory")}</p>
							</div>
						) : filteredConversations.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
								<History className="h-10 w-10 opacity-20 mb-2" />
								<p>{t("search.noResults")}</p>
							</div>
						) : (
							filteredConversations.map((c) => {
								const isCurrent =
									c.conversationId === props.currentConversationId;
								const title =
									typeof c.title === "string" && c.title.trim().length > 0
										? c.title
										: t("ai.chat.untitled");
								const ts =
									typeof c.updatedAt === "string" && c.updatedAt.length > 0
										? c.updatedAt
										: c.createdAt;
								return (
									<Button
										key={c.conversationId}
										variant={isCurrent ? "secondary" : "ghost"}
										className="w-full justify-start h-auto px-3 py-2 flex-col items-start gap-1"
										onClick={() => {
											props.onSelect(c.conversationId);
											setOpen(false);
										}}
									>
										<span className="font-medium text-sm w-full text-left truncate">
											{title}
										</span>
										<span className="text-xs text-muted-foreground tabular-nums">
											{new Date(ts).toLocaleString()}
										</span>
									</Button>
								);
							})
						)}
					</div>
				</ScrollArea>
			</DialogContent>
		</Dialog>
	);
}
