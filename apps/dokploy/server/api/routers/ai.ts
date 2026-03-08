import { IS_CLOUD } from "@dokploy/server/constants";
import {
	aiProviderTypeSchema,
	apiApproveExecution,
	apiCancelRun,
	apiCreateAi,
	apiCreateAiMcpServer,
	apiCreateConversation,
	apiDeleteAiMcpServer,
	apiFindConversation,
	apiGetAgentEvents,
	apiGetMessages,
	apiGetRun,
	apiListAiMcpServers,
	apiListConversations,
	apiSendMessage,
	apiSetToolBudgetMode,
	apiSetToolApprovalsDisabled,
	apiStartAgent,
	apiTestAiMcpServer,
	apiUpsertAiEmbeddingProvider,
	apiUpdateAiMcpServer,
	apiUpdateAi,
	apiUpdateConversation,
	deploySuggestionSchema,
} from "@dokploy/server/db/schema/ai";
import {
	createDomain,
	createMount,
	findEnvironmentById,
} from "@dokploy/server/index";
import {
	approveToolExecution,
	cancelRun,
	chat,
	createConversation,
	deleteAiSettings,
	deleteConversation,
	createAiMcpServer,
	deleteAiMcpServer,
	executeApprovedTool,
	getAiSettingById,
	getAiSettingsByOrganizationId,
	getAiEmbeddingProviderByOrganizationId,
	testAiEmbeddingProvider,
	listAiMcpServersByOrganizationId,
	testAiMcpServer,
	getConversationById,
	getConversationIdForToolExecution,
	getAgentEventMessages,
	getDisplayMessages,
	getRunById,
	getToolExecutionById,
	getToolExecutionsByIds,
	listConversations,
	resumeAgentRun,
	saveAiSettings,
	saveAiEmbeddingProvider,
	startAgentRun,
	suggestVariants,
	updateAiMcpServer,
	updateConversation,
	deleteAiEmbeddingProvider,
} from "@dokploy/server/services/ai";
import { createComposeByTemplate } from "@dokploy/server/services/compose";
import { findProjectById } from "@dokploy/server/services/project";
import {
	addNewService,
	checkServiceAccess,
} from "@dokploy/server/services/user";
import {
	getProviderHeaders,
	getProviderName,
	type Model,
	normalizeAiApiUrl,
} from "@dokploy/server/utils/ai/select-ai-provider";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { slugify } from "@/lib/slug";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";
import { generatePassword } from "@/templates/utils";

export const aiRouter = createTRPCRouter({
	one: protectedProcedure
		.input(z.object({ aiId: z.string() }))
		.query(async ({ ctx, input }) => {
			const normalizedAiId = input.aiId.trim();
			if (normalizedAiId.length === 0) return null;
			const aiSetting = await getAiSettingById(normalizedAiId);
			if (aiSetting.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "settings.ai.errors.noAccessToAiConfig",
				});
			}
			return aiSetting;
		}),

	getModels: protectedProcedure
		.input(
			z.object({
				apiUrl: z.string().min(1),
				apiKey: z.string(),
				providerType: aiProviderTypeSchema.optional(),
			}),
		)
		.query(async ({ input }) => {
			try {
				const detectedProvider = getProviderName(input.apiUrl);
				const explicitProvider = input.providerType;
				const providerName = explicitProvider
					? explicitProvider
					: detectedProvider === "custom"
						? "openai_compatible"
						: detectedProvider;
				const apiUrl = normalizeAiApiUrl({
					apiUrl: input.apiUrl,
					providerType: providerName,
				});
				const headers = getProviderHeaders(apiUrl, input.apiKey, providerName);
				let response = null;
				switch (providerName) {
					case "ollama":
						response = await fetch(`${apiUrl}/api/tags`, { headers });
						break;
					case "gemini":
						response = await fetch(
							`${apiUrl}/models?key=${encodeURIComponent(input.apiKey)}`,
							{ headers: {} },
						);
						break;
					default:
					if (!input.apiKey)
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "settings.ai.errors.apiKeyRequired",
						});
						response = await fetch(`${apiUrl}/models`, { headers });
				}

				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					const details = [
						`status=${response.status}`,
						`provider=${providerName}`,
						`url=${response.url || apiUrl}`,
					]
						.filter(Boolean)
						.join(" ");
					throw new Error(
						`Failed to fetch models (${details})${errorText ? `: ${errorText}` : ""}`,
					);
				}

				const res = await response.json();

				if (Array.isArray(res)) {
					return res.map((model) => ({
						id: model.id || model.name,
						object: "model",
						created: Date.now(),
						owned_by: "provider",
					}));
				}

				if (res.models) {
					return res.models.map((model: any) => ({
						id: model.id || model.name,
						object: "model",
						created: Date.now(),
						owned_by: "provider",
					})) as Model[];
				}

				if (res.data) {
					return res.data as Model[];
				}

				const possibleModels =
					(Object.values(res).find(Array.isArray) as any[]) || [];
				return possibleModels.map((model) => ({
					id: model.id || model.name,
					object: "model",
					created: Date.now(),
					owned_by: "provider",
				})) as Model[];
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
				});
			}
		}),
	create: adminProcedure.input(apiCreateAi).mutation(async ({ ctx, input }) => {
		return await saveAiSettings(ctx.session.activeOrganizationId, input);
	}),

	update: protectedProcedure
		.input(apiUpdateAi)
		.mutation(async ({ ctx, input }) => {
			return await saveAiSettings(ctx.session.activeOrganizationId, input);
		}),

	getAll: adminProcedure.query(async ({ ctx }) => {
		return await getAiSettingsByOrganizationId(
			ctx.session.activeOrganizationId,
		);
	}),

	embeddingProvider: createTRPCRouter({
		get: adminProcedure.query(async ({ ctx }) => {
			return await getAiEmbeddingProviderByOrganizationId(
				ctx.session.activeOrganizationId,
			);
		}),
		test: adminProcedure.query(async ({ ctx }) => {
			return await testAiEmbeddingProvider({
				organizationId: ctx.session.activeOrganizationId,
			});
		}),
		upsert: adminProcedure
			.input(apiUpsertAiEmbeddingProvider)
			.mutation(async ({ ctx, input }) => {
				return await saveAiEmbeddingProvider(ctx.session.activeOrganizationId, input);
			}),
		delete: adminProcedure.mutation(async ({ ctx }) => {
			return await deleteAiEmbeddingProvider(ctx.session.activeOrganizationId);
		}),
	}),

	mcpServers: createTRPCRouter({
		list: adminProcedure.input(apiListAiMcpServers).query(async ({ ctx, input }) => {
			return await listAiMcpServersByOrganizationId({
				organizationId: ctx.session.activeOrganizationId,
				limit: input.limit,
				offset: input.offset,
			});
		}),
		create: adminProcedure
			.input(apiCreateAiMcpServer)
			.mutation(async ({ ctx, input }) => {
				return await createAiMcpServer(ctx.session.activeOrganizationId, input);
			}),
		update: adminProcedure
			.input(apiUpdateAiMcpServer)
			.mutation(async ({ ctx, input }) => {
				return await updateAiMcpServer(ctx.session.activeOrganizationId, input);
			}),
		delete: adminProcedure
			.input(apiDeleteAiMcpServer)
			.mutation(async ({ ctx, input }) => {
				await deleteAiMcpServer(
					ctx.session.activeOrganizationId,
					input.mcpServerId,
				);
			}),
		test: adminProcedure.input(apiTestAiMcpServer).query(async ({ ctx, input }) => {
			return await testAiMcpServer({
				organizationId: ctx.session.activeOrganizationId,
				mcpServerId: input.mcpServerId,
			});
		}),
	}),

	get: protectedProcedure
		.input(z.object({ aiId: z.string() }))
		.query(async ({ ctx, input }) => {
			const aiSetting = await getAiSettingById(input.aiId);
			if (aiSetting.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "settings.ai.errors.noAccessToAiConfig",
				});
			}
			return aiSetting;
		}),

	delete: protectedProcedure
		.input(z.object({ aiId: z.string() }))
		.mutation(async ({ ctx, input }) => {
			const aiSetting = await getAiSettingById(input.aiId);
			if (aiSetting.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "settings.ai.errors.noAccessToAiConfig",
				});
			}
			return await deleteAiSettings(input.aiId);
		}),

	suggest: protectedProcedure
		.input(
			z.object({
				aiId: z.string(),
				input: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				return await suggestVariants({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
				});
			}
		}),
	deploy: protectedProcedure
		.input(deploySuggestionSchema)
		.mutation(async ({ ctx, input }) => {
			const environment = await findEnvironmentById(input.environmentId);
			const project = await findProjectById(environment.projectId);
			if (ctx.user.role === "member") {
				await checkServiceAccess(
					ctx.session.activeOrganizationId,
					environment.projectId,
					"create",
				);
			}

			if (IS_CLOUD && !input.serverId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "settings.ai.errors.serverRequiredForCompose",
				});
			}

			const projectName = slugify(`${project.name} ${input.id}`);

			const compose = await createComposeByTemplate({
				...input,
				composeFile: input.dockerCompose,
				env: input.envVariables,
				serverId: input.serverId,
				name: input.name,
				sourceType: "raw",
				appName: `${projectName}-${generatePassword(6)}`,
				isolatedDeployment: true,
				environmentId: input.environmentId,
			});

			if (input.domains && input.domains?.length > 0) {
				for (const domain of input.domains) {
					await createDomain({
						...domain,
						domainType: "compose",
						certificateType: "none",
						composeId: compose.composeId,
					});
				}
			}
			if (input.configFiles && input.configFiles?.length > 0) {
				for (const mount of input.configFiles) {
					await createMount({
						filePath: mount.filePath,
						mountPath: "",
						content: mount.content,
						serviceId: compose.composeId,
						serviceType: "compose",
						type: "file",
					});
				}
			}

			if (ctx.user.role === "member") {
				await addNewService(
					ctx.session.activeOrganizationId,
					ctx.user.ownerId,
					compose.composeId,
				);
			}

			return null;
		}),

	// ============================================
	// Conversation Management
	// ============================================

	conversations: createTRPCRouter({
		create: protectedProcedure
			.input(apiCreateConversation)
			.mutation(async ({ ctx, input }) => {
				const normalizedAiId =
					typeof input.aiId === "string" && input.aiId.trim().length > 0
						? input.aiId
						: undefined;
				const normalizedInput = {
					...input,
					aiId: normalizedAiId,
					title: input.title ?? undefined,
					projectId: input.projectId ?? undefined,
					serverId: input.serverId ?? undefined,
				};
				return await createConversation({
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					...normalizedInput,
					uiLocale: ctx.req?.cookies?.DOKPLOY_LOCALE,
				});
			}),

		get: protectedProcedure
			.input(apiFindConversation)
			.query(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToConversation",
					});
				}
				return conversation;
			}),

		list: protectedProcedure
			.input(apiListConversations)
			.query(async ({ ctx, input }) => {
				return await listConversations({
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					...input,
				});
			}),

		update: protectedProcedure
			.input(apiUpdateConversation)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToConversation",
					});
				}
				return await updateConversation(input.conversationId, {
					title: input.title,
					status: input.status,
				});
			}),

		setToolApprovalsDisabled: protectedProcedure
			.input(apiSetToolApprovalsDisabled)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToConversation",
					});
				}

				const nextMetadata = (() => {
					const base =
						conversation.metadata &&
						typeof conversation.metadata === "object" &&
						!Array.isArray(conversation.metadata)
							? { ...(conversation.metadata as Record<string, unknown>) }
							: {};
					if (input.disabled) (base as any).toolApprovalsDisabled = true;
					else delete (base as any).toolApprovalsDisabled;
					return base;
				})();

				return await updateConversation(input.conversationId, {
					metadata: nextMetadata,
				});
			}),

		setToolBudgetMode: protectedProcedure
			.input(apiSetToolBudgetMode)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToConversation",
					});
				}

				const nextMetadata = (() => {
					const base =
						conversation.metadata &&
						typeof conversation.metadata === "object" &&
						!Array.isArray(conversation.metadata)
							? { ...(conversation.metadata as Record<string, unknown>) }
							: {};
					if (input.mode === "standard") (base as any).toolBudgetMode = "standard";
					else delete (base as any).toolBudgetMode;
					return base;
				})();

				return await updateConversation(input.conversationId, {
					metadata: nextMetadata,
				});
			}),

		delete: protectedProcedure
			.input(apiFindConversation)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToConversation",
					});
				}
				await deleteConversation(input.conversationId);
				return { success: true };
			}),
	}),

	// ============================================
	// Chat Operations
	// ============================================

	chat: createTRPCRouter({
		send: protectedProcedure
			.input(apiSendMessage)
			.mutation(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToConversation",
					});
				}

				return await chat({
					conversationId: input.conversationId,
					message: input.message,
					aiId: input.aiId,
					attachments: input.attachments,
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					uiLocale: ctx.req?.cookies?.DOKPLOY_LOCALE,
				});
			}),

		messages: protectedProcedure
			.input(apiGetMessages)
			.query(async ({ ctx, input }) => {
				const conversation = await getConversationById(input.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToConversation",
					});
				}
				return await getDisplayMessages(input);
			}),
	}),

	// ============================================
	// Agent Operations
	// ============================================

	agent: createTRPCRouter({
		start: protectedProcedure
			.input(apiStartAgent)
			.mutation(async ({ ctx, input }) => {
				return await startAgentRun({
					conversationId: input.conversationId,
					goal: input.goal,
					aiId: input.aiId,
					attachments: input.attachments,
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					uiLocale: ctx.req?.cookies?.DOKPLOY_LOCALE,
				});
			}),

		getRun: protectedProcedure
			.input(apiGetRun)
			.query(async ({ ctx, input }) => {
				const run = await getRunById(input.runId);
				const conversation = await getConversationById(run.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToRun",
					});
				}
				return run;
			}),

		events: protectedProcedure
			.input(apiGetAgentEvents)
			.query(async ({ ctx, input }) => {
				const run = await getRunById(input.runId);
				const conversation = await getConversationById(run.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToRun",
					});
				}
				return await getAgentEventMessages({
					conversationId: run.conversationId,
					runId: input.runId,
					limit: input.limit,
					before: input.before,
					beforeMessageId: input.beforeMessageId,
				});
			}),

		cancel: protectedProcedure
			.input(apiCancelRun)
			.mutation(async ({ ctx, input }) => {
				const run = await getRunById(input.runId);
				const conversation = await getConversationById(run.conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToRun",
					});
				}
				return await cancelRun(input.runId);
			}),

		approve: protectedProcedure
			.input(apiApproveExecution)
			.mutation(async ({ ctx, input }) => {
				const conversationId = await getConversationIdForToolExecution(
					input.executionId,
				);
				if (!conversationId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "settings.ai.errors.toolExecutionNotLinked",
					});
				}
				const conversation = await getConversationById(conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToToolExecution",
					});
				}

				const updated = await approveToolExecution(
					input.executionId,
					input.approved,
					ctx.user.id,
				);

				if (updated?.runId) {
					await resumeAgentRun({
						runId: updated.runId,
						organizationId: ctx.session.activeOrganizationId,
						userId: ctx.user.id,
					});
				}

				return updated;
			}),

		execute: protectedProcedure
			.input(
				z.object({
					executionId: z.string(),
					conversationId: z.string().optional(),
				}),
			)
			.mutation(async ({ ctx, input }) => {
				const execution = await getToolExecutionById(input.executionId);
				if (execution.status !== "approved") {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "settings.ai.errors.toolExecutionMustBeApproved",
					});
				}

				let projectId: string | undefined;
				let serverId: string | undefined;
				const conversationId =
					input.conversationId ??
					(await getConversationIdForToolExecution(input.executionId));
				if (!conversationId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "settings.ai.errors.toolExecutionNotFound",
					});
				}
				if (conversationId) {
					const conversation = await getConversationById(conversationId);
					if (
						conversation.organizationId !== ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "settings.ai.errors.noAccessToToolExecution",
						});
					}
					projectId = conversation.projectId || undefined;
					serverId = conversation.serverId || undefined;
				}

				return await executeApprovedTool(input.executionId, {
					organizationId: ctx.session.activeOrganizationId,
					userId: ctx.user.id,
					projectId,
					serverId,
				});
			}),

		getExecution: protectedProcedure
			.input(z.object({ executionId: z.string() }))
			.query(async ({ ctx, input }) => {
				const conversationId = await getConversationIdForToolExecution(
					input.executionId,
				);
				if (!conversationId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "settings.ai.errors.toolExecutionNotFound",
					});
				}
				const conversation = await getConversationById(conversationId);
				if (conversation.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "settings.ai.errors.noAccessToToolExecution",
					});
				}
				return await getToolExecutionById(input.executionId);
			}),

		getExecutions: protectedProcedure
			.input(
				z.object({
					executionIds: z.array(z.string().min(1)).min(1).max(50),
				}),
			)
			.query(async ({ ctx, input }) => {
				return await getToolExecutionsByIds({
					executionIds: input.executionIds,
					organizationId: ctx.session.activeOrganizationId,
				});
			}),
	}),
});
