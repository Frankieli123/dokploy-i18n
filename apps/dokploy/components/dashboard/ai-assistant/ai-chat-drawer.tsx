"use client";

import {
	Bot,
	History,
	Loader2,
	MessageSquarePlus,
	Search,
	Send,
	Square,
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
import { ToolExecutionHistory } from "./tool-execution-history";
import { useChat } from "./use-chat";

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
	const LAST_SERVER_ID_STORAGE_KEY = "dokploy.ai.lastServerId";
	const [autoLoadHistory, setAutoLoadHistory] = useState(true);
	const [input, setInput] = useState("");
	const [selectedAiId, setSelectedAiId] = useState<string>("");
	const [agentGoal, setAgentGoal] = useState("");
	const viewportRef = useRef<HTMLDivElement>(null);
	const isNearBottomRef = useRef(true);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!isOpen) {
			setAutoLoadHistory(true);
		}
	}, [isOpen]);

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
	const [pinnedServerId, setPinnedServerId] = useState<string>(() => {
		if (typeof window === "undefined") return "";
		try {
			return localStorage.getItem(LAST_SERVER_ID_STORAGE_KEY) ?? "";
		} catch {
			return "";
		}
	});
	const effectiveServerId =
		pinnedServerId.trim().length > 0
			? pinnedServerId.trim()
			: routeBoundServerId;
	const isServerContextReady = !!effectiveServerId;

	useEffect(() => {
		if (pinnedServerId.trim().length > 0) return;
		if (!routeBoundServerId || routeBoundServerId.trim().length === 0) return;
		setPinnedServerId(routeBoundServerId);
		try {
			localStorage.setItem(LAST_SERVER_ID_STORAGE_KEY, routeBoundServerId);
		} catch {}
	}, [pinnedServerId, routeBoundServerId]);

	const shouldPickDefaultServer =
		isOpen &&
		(!routeBoundServerId || routeBoundServerId.trim().length === 0) &&
		pinnedServerId.trim().length === 0;
	const { data: serversForDefaultPick } = api.server.all.useQuery(undefined, {
		enabled: shouldPickDefaultServer,
	});

	useEffect(() => {
		if (!shouldPickDefaultServer) return;
		if (!serversForDefaultPick || serversForDefaultPick.length === 0) return;

		const activeDeployServers = serversForDefaultPick.filter(
			(s) => s.serverStatus === "active" && s.serverType === "deploy",
		);
		const activeServers = serversForDefaultPick.filter(
			(s) => s.serverStatus === "active",
		);
		const picked =
			activeDeployServers[0]?.serverId || activeServers[0]?.serverId || "";
		if (!picked) return;

		setPinnedServerId(picked);
		try {
			localStorage.setItem(LAST_SERVER_ID_STORAGE_KEY, picked);
		} catch {}
	}, [serversForDefaultPick, shouldPickDefaultServer]);

	// Lazy load AI configs only when drawer is open
	const { data: aiConfigs, isLoading: isLoadingConfigs } =
		api.ai.getAll.useQuery(undefined, {
			enabled: isOpen,
		});

	const {
		messages,
		isLoading,
		conversationId,
		send,
		reset,
		retryMessage,
		approveToolCall,
		rejectToolCall,
		ensureConversation,
		refetchMessages,
		enableConversationAutoApprove,
		stopGeneration,
		openConversation,
		startAgent,
		isAgentRunning,
		agentRunId,
		stopAgentStream,
	} = useChat({
		onError: (error) => {
			const errorMessage = error.message || t("ai.chat.sendError");
			toast.error(translateErrorMessage(errorMessage, t));
		},
		projectId,
		serverId: effectiveServerId,
		enabled: isOpen,
		autoLoad: autoLoadHistory,
	});

	const cancelAgent = api.ai.agent.cancel.useMutation();
	const approveExecution = api.ai.agent.approve.useMutation();

	const handleStartAgent = async () => {
		if (!isServerContextReady) return;
		if (!selectedAiId || !agentGoal.trim() || isLoading || isAgentRunning)
			return;
		await startAgent(agentGoal.trim(), selectedAiId);
	};

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

	const handleSend = async () => {
		if (!isServerContextReady) return;
		if (!input.trim() || !selectedAiId || isLoading || isAgentRunning) return;

		const message = input;
		setInput("");
		await send(message, selectedAiId);
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
			await retryMessage(messageId, selectedAiId);
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
				className="w-full sm:w-[440px] p-0 flex flex-col gap-0"
			>
				<SheetHeader className="px-4 py-3 border-b">
					<div className="flex items-center justify-between">
						<SheetTitle className="flex items-center gap-2">
							<Bot className="h-5 w-5" />
							{t("ai.chat.title")}
						</SheetTitle>
						<div className="flex items-center gap-1">
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
							<Button
								variant="ghost"
								size="icon"
								onClick={() => {
									setAutoLoadHistory(false);
									reset();
								}}
								className="h-8 w-8"
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

				<div className="px-4 pt-4">
					<div className="flex gap-2">
						<Input
							value={agentGoal}
							onChange={(e) => setAgentGoal(e.target.value)}
							placeholder={t("ai.agent.goalPlaceholder")}
							disabled={
								!hasAiConfigs ||
								!isServerContextReady ||
								isLoading ||
								isAgentRunning
							}
							className="flex-1"
							aria-label={t("ai.agent.goalLabel")}
						/>
						{isAgentRunning ? (
							<Button
								variant="destructive"
								onClick={async () => {
									if (agentRunId) {
										await cancelAgent.mutateAsync({ runId: agentRunId });
										return;
									}
									stopAgentStream();
								}}
							>
								{t("common.cancel", "Cancel")}
							</Button>
						) : (
							<Button
								onClick={handleStartAgent}
								disabled={!hasAiConfigs || !agentGoal.trim() || isLoading}
							>
								{t("ai.agent.start", "Start Agent")}
							</Button>
						)}
					</div>
				</div>

				<ScrollArea
					className="flex-1 min-h-0"
					viewPortClassName="p-4"
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
										onApproveExecution={async (executionId) => {
											try {
												enableConversationAutoApprove();
												await approveExecution.mutateAsync({
													executionId,
													approved: true,
												});
												await refetchMessages().catch(() => {});
											} catch (error) {
												const errorMessage =
													error instanceof Error
														? error.message
														: t("ai.chat.sendError");
												toast.error(translateErrorMessage(errorMessage, t));
											}
										}}
										onRejectExecution={async (executionId) => {
											try {
												await approveExecution.mutateAsync({
													executionId,
													approved: false,
												});
												await refetchMessages().catch(() => {});
											} catch (error) {
												const errorMessage =
													error instanceof Error
														? error.message
														: t("ai.chat.sendError");
												toast.error(translateErrorMessage(errorMessage, t));
											}
										}}
										isLast={index === messages.length - 1}
										onRetry={() => handleRetry(message.messageId)}
									/>
								</div>
							))}
						</div>
					)}
				</ScrollArea>

				<div className="border-t p-4">
					<div className="flex gap-2">
						<Textarea
							ref={inputRef}
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={handleKeyPress}
							rows={1}
							placeholder={
								hasAiConfigs
									? t("ai.chat.inputPlaceholder")
									: t("ai.chat.configureFirst")
							}
							disabled={
								!hasAiConfigs ||
								!isServerContextReady ||
								isAgentRunning ||
								isLoading
							}
							className="flex-1 min-h-[40px] max-h-[180px] resize-none overflow-y-auto"
							aria-label={t("ai.chat.inputLabel")}
						/>
						{isLoading ? (
							<Button
								onClick={stopGeneration}
								variant="destructive"
								size="icon"
								aria-label={t("common.stop")}
							>
								<Square className="h-4 w-4 fill-current" />
							</Button>
						) : (
							<Button
								onClick={handleSend}
								disabled={
									!hasAiConfigs || !isServerContextReady || !input.trim()
								}
								size="icon"
								aria-label={t("ai.chat.sendMessage")}
							>
								<Send className="h-4 w-4" />
							</Button>
						)}
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
			projectId: props.projectId,
			serverId: props.serverId,
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
					: t("ai.chat.untitled", "未命名对话");
			return title.toLowerCase().includes(s);
		});
	}, [conversations, search, t]);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8"
					title={t("ai.chat.history", "历史对话")}
					aria-label={t("ai.chat.history", "历史对话")}
				>
					<History className="h-4 w-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-md max-h-[80vh] flex flex-col p-0 gap-0">
				<DialogHeader className="p-6 pb-2">
					<DialogTitle className="flex items-center gap-2">
						<History className="h-5 w-5" />
						{t("ai.chat.historyTitle", "历史对话")}
					</DialogTitle>
					<DialogDescription>
						{t("ai.chat.historyDescription", "选择一条历史对话以继续。")}
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

				<ScrollArea className="flex-1 p-6 pt-2">
					<div className="space-y-2">
						{isLoading ? (
							<div className="flex items-center justify-center py-10 text-muted-foreground">
								<Loader2 className="h-6 w-6 animate-spin" />
							</div>
						) : !conversations || conversations.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
								<History className="h-10 w-10 opacity-20 mb-2" />
								<p>{t("ai.chat.noHistory", "暂无历史对话")}</p>
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
										: t("ai.chat.untitled", "未命名对话");
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
