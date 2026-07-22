import {
	CLEANUP_CRON_JOB,
	checkGPUStatus,
	checkPortInUse,
	cleanStoppedContainers,
	cleanUpDockerBuilder,
	cleanUpSystemPrune,
	cleanUpUnusedImages,
	cleanUpUnusedVolumes,
	DEFAULT_UPDATE_DATA,
	execAsync,
	findServerById,
	findUserById,
	getDokployImage,
	getDokployImageTag,
	getLogCleanupStatus,
	getUpdateData,
	getWebServerSettings,
	IS_CLOUD,
	parseRawConfig,
	paths,
	prepareEnvironmentVariables,
	processLogs,
	readConfig,
	readConfigInPath,
	readDirectory,
	readEnvironmentVariables,
	readMainConfig,
	readMonitoringConfig,
	readPorts,
	recreateDirectory,
	reloadDockerResource,
	reloadTraefik,
	sendDockerCleanupNotifications,
	setupGPUSupport,
	spawnAsync,
	startLogCleanup,
	stopLogCleanup,
	updateLetsEncryptEmail,
	updateServerById,
	updateWebServerSettings,
	writeConfig,
	writeMainConfig,
	writeTraefikConfigInPath,
	writeTraefikSetup,
} from "@dokploy/server";
import { checkPermission } from "@dokploy/server/services/permission";
import { updateUser } from "@dokploy/server/services/user";
import { parsePanelDomainsInput } from "@dokploy/server/utils/panel-domains";
import { updateServerTraefik } from "@dokploy/server/utils/traefik/web-server";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { db } from "@/server/db";
import {
	apiAssignDomain,
	apiEnableDashboard,
	apiModifyTraefikConfig,
	apiReadStatsLogs,
	apiReadTraefikConfig,
	apiSaveSSHKey,
	apiServerSchema,
	apiTraefikConfig,
	apiUpdateDockerCleanup,
	projects,
	server,
} from "@/server/db/schema";
import { cleanAllDeploymentQueue } from "@/server/queues/queueSetup";
import { audit } from "@/server/api/utils/audit";
import { removeJob, schedule } from "@/server/utils/backup";
import packageInfo from "../../../package.json";
import { appRouter } from "../root";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from "../trpc";

const auditSettings = (
	ctx: {
		user: { id: string; email: string; role: string };
		session: { activeOrganizationId: string };
	},
	action: "create" | "update" | "delete" | "reload" | "run",
	resourceName: string,
	metadata?: Record<string, unknown>,
) =>
	audit(ctx, {
		action,
		resourceType: "settings",
		resourceName,
		metadata,
	});

export const settingsRouter = createTRPCRouter({
	reloadServer: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await reloadDockerResource("dokploy", undefined, packageInfo.version);
		await auditSettings(ctx, "reload", "dokploy");
		return true;
	}),
	getUpdateTagsUrl: protectedProcedure.query(async ({ ctx }) => {
		if (IS_CLOUD) {
			return null;
		}
		const user = await findUserById(ctx.user.id);
		return user.updateTagsUrl ?? null;
	}),
	getAutoCheckUpdates: protectedProcedure.query(async ({ ctx }) => {
		if (IS_CLOUD) {
			return null;
		}
		const user = await findUserById(ctx.user.id);
		return user.enableAutoCheckUpdates ?? true;
	}),
	setUpdateTagsUrl: protectedProcedure
		.input(
			z.object({
				tagsUrl: z.string().trim().url().nullable(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (IS_CLOUD) {
				return true;
			}
			await updateUser(ctx.user.id, {
				updateTagsUrl: input.tagsUrl,
			});
			await auditSettings(ctx, "update", "update-tags-url", {
				tagsUrl: input.tagsUrl,
			});
			return true;
		}),
	setAutoCheckUpdates: protectedProcedure
		.input(
			z.object({
				enabled: z.boolean(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (IS_CLOUD) {
				return true;
			}
			await updateUser(ctx.user.id, {
				enableAutoCheckUpdates: input.enabled,
			});
			await auditSettings(ctx, "update", "auto-check-updates", {
				enabled: input.enabled,
			});
			return true;
		}),
	cleanRedis: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}

		const { stdout: containerId } = await execAsync(
			`docker ps --filter "name=dokploy-redis" --filter "status=running" -q | head -n 1`,
		);

		if (!containerId) {
			throw new Error("Redis container not found");
		}

		const redisContainerId = containerId.trim();

		await execAsync(`docker exec -i ${redisContainerId} redis-cli flushall`);
		await auditSettings(ctx, "delete", "redis-cache");
		return true;
	}),
	reloadRedis: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await reloadDockerResource("dokploy-redis");
		await auditSettings(ctx, "reload", "dokploy-redis");
		return true;
	}),
	cleanAllDeploymentQueue: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const result = cleanAllDeploymentQueue();
		await auditSettings(ctx, "delete", "deployment-queue");
		return result;
	}),
	reloadTraefik: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await reloadTraefik(input?.serverId);
			await auditSettings(ctx, "reload", "dokploy-traefik", {
				serverId: input?.serverId,
			});
			return true;
		}),
	toggleDashboard: adminProcedure
		.input(apiEnableDashboard)
		.mutation(async ({ input, ctx }) => {
			const ports = await readPorts("dokploy-traefik", input.serverId);
			const env = await readEnvironmentVariables(
				"dokploy-traefik",
				input.serverId,
			);
			const preparedEnv = prepareEnvironmentVariables(env);
			let newPorts = ports;
			// If receive true, add 8080 to ports
			if (input.enableDashboard) {
				const portCheck = await checkPortInUse(8080, input.serverId);
				if (portCheck.isInUse) {
					throw new TRPCError({
						code: "CONFLICT",
						message: portCheck.conflictingContainer
							? `Port 8080 is already in use by ${portCheck.conflictingContainer}`
							: "Port 8080 is already in use",
					});
				}
				newPorts.push({
					targetPort: 8080,
					publishedPort: 8080,
					protocol: "tcp",
				});
			} else {
				newPorts = ports.filter((port) => port.targetPort !== 8080);
			}

			void writeTraefikSetup({
				env: preparedEnv,
				additionalPorts: newPorts,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("toggleDashboard background writeTraefikSetup:", err);
			});
			await auditSettings(ctx, "update", "traefik-dashboard", {
				serverId: input.serverId,
				enableDashboard: input.enableDashboard,
			});
			return true;
		}),
	cleanUnusedImages: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanUpUnusedImages(input?.serverId);
			await auditSettings(ctx, "delete", "unused-images", {
				serverId: input?.serverId,
			});
			return true;
		}),
	cleanUnusedVolumes: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanUpUnusedVolumes(input?.serverId);
			await auditSettings(ctx, "delete", "unused-volumes", {
				serverId: input?.serverId,
			});
			return true;
		}),
	cleanStoppedContainers: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanStoppedContainers(input?.serverId);
			await auditSettings(ctx, "delete", "stopped-containers", {
				serverId: input?.serverId,
			});
			return true;
		}),
	cleanDockerBuilder: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanUpDockerBuilder(input?.serverId);
			await auditSettings(ctx, "delete", "docker-builder", {
				serverId: input?.serverId,
			});
			return true;
		}),
	cleanDockerPrune: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanUpSystemPrune(input?.serverId);
			await cleanUpDockerBuilder(input?.serverId);
			await auditSettings(ctx, "delete", "docker-prune", {
				serverId: input?.serverId,
			});
			return true;
		}),
	cleanAll: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanUpUnusedImages(input?.serverId);
			await cleanStoppedContainers(input?.serverId);
			await cleanUpDockerBuilder(input?.serverId);
			await cleanUpSystemPrune(input?.serverId);
			await auditSettings(ctx, "delete", "docker-clean-all", {
				serverId: input?.serverId,
			});
			return true;
		}),
	cleanMonitoring: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		const { MONITORING_PATH } = paths();
		await recreateDirectory(MONITORING_PATH);
		await auditSettings(ctx, "delete", "monitoring-data");
		return true;
	}),
	saveSSHPrivateKey: adminProcedure
		.input(apiSaveSSHKey)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			await updateUser(ctx.user.id, {
				sshPrivateKey: input.sshPrivateKey,
			});
			await updateWebServerSettings({
				sshPrivateKey: input.sshPrivateKey,
			});
			await auditSettings(ctx, "update", "ssh-private-key");
			return true;
		}),
	assignDomainServer: adminProcedure
		.input(apiAssignDomain)
		.mutation(async ({ ctx, input }) => {
			if (IS_CLOUD) {
				return true;
			}
			const currentUser = await findUserById(ctx.user.id);
			const legacyProtocol = (input.https ?? currentUser.https)
				? "https"
				: "http";
			const rawDomains =
				input.domains?.trim() ||
				(input.host?.trim()
					? `${legacyProtocol}://${input.host.trim()}`
					: "");
			const parsedDomains = parsePanelDomainsInput(rawDomains);
			const certificateType = parsedDomains.https
				? (input.certificateType ?? "none")
				: "none";
			const user = await updateUser(ctx.user.id, {
				host: parsedDomains.primaryHost,
				additionalHosts: parsedDomains.additionalHosts,
				...(input.letsEncryptEmail && {
					letsEncryptEmail: input.letsEncryptEmail,
				}),
				certificateType,
				https: parsedDomains.https,
			});
			await updateWebServerSettings({
				host: parsedDomains.primaryHost,
				additionalHosts: parsedDomains.additionalHosts,
				letsEncryptEmail: input.letsEncryptEmail ?? null,
				certificateType,
				https: parsedDomains.https,
			});

			if (!user) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found",
				});
			}

			updateServerTraefik(
				user as any,
				parsedDomains.primaryHost,
				parsedDomains.additionalHosts,
			);
			if (
				parsedDomains.https &&
				certificateType === "letsencrypt" &&
				input.letsEncryptEmail
			) {
				updateLetsEncryptEmail(input.letsEncryptEmail);
			}
			await auditSettings(ctx, "update", "panel-domains", {
				host: parsedDomains.primaryHost,
				additionalHosts: parsedDomains.additionalHosts,
				https: parsedDomains.https,
				certificateType,
			});
			return user;
		}),
	cleanSSHPrivateKey: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}
		await updateUser(ctx.user.id, {
			sshPrivateKey: null,
		});
		await updateWebServerSettings({
			sshPrivateKey: null,
		});
		await auditSettings(ctx, "delete", "ssh-private-key");
		return true;
	}),
	updateDockerCleanup: adminProcedure
		.input(apiUpdateDockerCleanup)
		.mutation(async ({ input, ctx }) => {
			if (input.serverId) {
				await updateServerById(input.serverId, {
					enableDockerCleanup: input.enableDockerCleanup,
				});

				const server = await findServerById(input.serverId);

				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}

				if (server.enableDockerCleanup) {
					const server = await findServerById(input.serverId);
					if (server.serverStatus === "inactive") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Server is inactive",
						});
					}
					if (IS_CLOUD) {
						await schedule({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						scheduleJob(server.serverId, CLEANUP_CRON_JOB, async () => {
							console.log(
								`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
							);
							await cleanUpUnusedImages(server.serverId);
							await cleanUpDockerBuilder(server.serverId);
							await cleanUpSystemPrune(server.serverId);
							await sendDockerCleanupNotifications(server.organizationId);
						});
					}
				} else {
					if (IS_CLOUD) {
						await removeJob({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						const currentJob = scheduledJobs[server.serverId];
						currentJob?.cancel();
					}
				}
			} else if (!IS_CLOUD) {
				const userUpdated = await updateUser(ctx.user.id, {
					enableDockerCleanup: input.enableDockerCleanup,
				});
				await updateWebServerSettings({
					enableDockerCleanup: input.enableDockerCleanup,
				});

				if (userUpdated?.enableDockerCleanup) {
					scheduleJob("docker-cleanup", CLEANUP_CRON_JOB, async () => {
						console.log(
							`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
						);
						await cleanUpUnusedImages();
						await cleanUpDockerBuilder();
						await cleanUpSystemPrune();
						await sendDockerCleanupNotifications(
							ctx.session.activeOrganizationId,
						);
					});
				} else {
					const currentJob = scheduledJobs["docker-cleanup"];
					currentJob?.cancel();
				}
			}
			await auditSettings(ctx, "update", "docker-cleanup", {
				serverId: input.serverId,
				enableDockerCleanup: input.enableDockerCleanup,
			});
			return true;
		}),

	readTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readMainConfig();
		return traefikConfig;
	}),

	updateTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeMainConfig(input.traefikConfig);
			await auditSettings(ctx, "update", "traefik-config");
			return true;
		}),

	readWebServerTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("dokploy");
		return traefikConfig;
	}),
	updateWebServerTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("dokploy", input.traefikConfig);
			await auditSettings(ctx, "update", "dokploy-traefik-config");
			return true;
		}),

	readMiddlewareTraefikConfig: adminProcedure.query(() => {
		if (IS_CLOUD) {
			return true;
		}
		const traefikConfig = readConfig("middlewares");
		return traefikConfig;
	}),

	updateMiddlewareTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			writeConfig("middlewares", input.traefikConfig);
			await auditSettings(ctx, "update", "middlewares-traefik-config");
			return true;
		}),
	getUpdateData: protectedProcedure
		.input(z.object({ tagsUrl: z.string().nullish() }).optional())
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return DEFAULT_UPDATE_DATA;
			}
			const user = await findUserById(ctx.user.id);
			return await getUpdateData(input?.tagsUrl ?? user.updateTagsUrl);
		}),
	updateServer: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			return true;
		}

		const user = await findUserById(ctx.user.id);
		const data = await getUpdateData(user.updateTagsUrl);
		const targetTag =
			data.updateAvailable && data.latestVersion
				? data.latestVersion
				: getDokployImageTag();

		if (!targetTag) {
			return true;
		}

		// This causes restart of dokploy, thus it will not finish executing properly, so don't await it
		// Status after restart is checked via frontend /api/health endpoint
		void spawnAsync("docker", [
			"service",
			"update",
			"--force",
			"--image",
			getDokployImage(targetTag),
			"dokploy",
		]);
		await auditSettings(ctx, "update", "dokploy-version", {
			targetTag,
		});
		return true;
	}),

	getDokployVersion: protectedProcedure.query(() => {
		return packageInfo.version;
	}),
	getReleaseTag: protectedProcedure.query(() => {
		return getDokployImageTag();
	}),
	readDirectories: protectedProcedure
		.input(apiServerSchema)
		.query(async ({ ctx, input }) => {
			try {
				await checkPermission(ctx, { traefikFiles: ["read"] });
				const { MAIN_TRAEFIK_PATH } = paths(!!input?.serverId);
				const result = await readDirectory(MAIN_TRAEFIK_PATH, input?.serverId);
				return result || [];
			} catch (error) {
				throw error;
			}
		}),

	updateTraefikFile: protectedProcedure
		.input(apiModifyTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await writeTraefikConfigInPath(
				input.path,
				input.traefikConfig,
				input?.serverId,
			);
			await auditSettings(ctx, "update", "traefik-file", {
				path: input.path,
				serverId: input?.serverId,
			});
			return true;
		}),

	readTraefikFile: protectedProcedure
		.input(apiReadTraefikConfig)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["read"] });

			if (input.serverId) {
				const server = await findServerById(input.serverId);

				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}

			return readConfigInPath(input.path, input.serverId);
		}),
	getIp: protectedProcedure.query(async ({ ctx }) => {
		if (IS_CLOUD) {
			return "";
		}
		const settings = await getWebServerSettings().catch(() => null);
		if (settings?.serverIp) {
			return settings.serverIp;
		}
		const user = await findUserById(ctx.user.ownerId);
		return user.serverIp || "";
	}),

	getOpenApiDocument: protectedProcedure.query(
		async ({ ctx }): Promise<unknown> => {
			const protocol = ctx.req.headers["x-forwarded-proto"];
			const url = `${protocol}://${ctx.req.headers.host}/api`;
			const openApiDocument = generateOpenApiDocument(appRouter, {
				title: "tRPC OpenAPI",
				version: "1.0.0",
				baseUrl: url,
				docsUrl: `${url}/settings.getOpenApiDocument`,
				tags: [
					"admin",
					"docker",
					"compose",
					"registry",
					"cluster",
					"user",
					"domain",
					"destination",
					"backup",
					"deployment",
					"mounts",
					"certificates",
					"settings",
					"security",
					"redirects",
					"port",
					"project",
					"application",
					"mysql",
					"postgres",
					"redis",
					"mongo",
					"mariadb",
					"sshRouter",
					"gitProvider",
					"bitbucket",
					"github",
					"gitlab",
					"gitea",
				],
			});

			openApiDocument.info = {
				title: "Dokploy API",
				description: "Endpoints for dokploy",
				version: "1.0.0",
			};

			// Add security schemes configuration
			openApiDocument.components = {
				...openApiDocument.components,
				securitySchemes: {
					apiKey: {
						type: "apiKey",
						in: "header",
						name: "x-api-key",
						description: "API key authentication",
					},
				},
			};

			// Apply security globally to all endpoints
			openApiDocument.security = [
				{
					apiKey: [],
				},
			];
			return openApiDocument;
		},
	),
	readTraefikEnv: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			const envVars = await readEnvironmentVariables(
				"dokploy-traefik",
				input?.serverId,
			);
			return envVars;
		}),

	writeTraefikEnv: adminProcedure
		.input(z.object({ env: z.string(), serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			const envs = prepareEnvironmentVariables(input.env);
			const ports = await readPorts("dokploy-traefik", input?.serverId);

			await writeTraefikSetup({
				env: envs,
				additionalPorts: ports,
				serverId: input.serverId,
			});
			await auditSettings(ctx, "update", "traefik-env", {
				serverId: input.serverId,
			});
			return true;
		}),
	haveTraefikDashboardPortEnabled: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			try {
				const ports = await readPorts("dokploy-traefik", input?.serverId);
				return ports.some((port) => port.targetPort === 8080);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "Resource type not found"
				) {
					return false;
				}
				throw error;
			}
		}),

	readStatsLogs: protectedProcedure
		.meta({
			openapi: {
				path: "/read-stats-logs",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiReadStatsLogs)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return {
					data: [],
					totalCount: 0,
				};
			}
			const rawConfig = await readMonitoringConfig(
				!!input.dateRange?.start && !!input.dateRange?.end,
			);

			const parsedConfig = parseRawConfig(
				rawConfig as string,
				input.page,
				input.sort,
				input.search,
				input.status,
				input.dateRange,
			);

			return parsedConfig;
		}),
	readStats: adminProcedure
		.meta({
			openapi: {
				path: "/read-stats",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z
				.object({
					dateRange: z
						.object({
							start: z.string().optional(),
							end: z.string().optional(),
						})
						.optional(),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			if (IS_CLOUD) {
				return [];
			}
			const rawConfig = await readMonitoringConfig(
				!!input?.dateRange?.start || !!input?.dateRange?.end,
			);
			const processedLogs = processLogs(rawConfig as string, input?.dateRange);
			return processedLogs || [];
		}),
	haveActivateRequests: protectedProcedure.query(async () => {
		if (IS_CLOUD) {
			return true;
		}
		const config = readMainConfig();

		if (!config) return false;
		const parsedConfig = parse(config) as {
			accessLog?: {
				filePath: string;
			};
		};

		return !!parsedConfig?.accessLog?.filePath;
	}),
	toggleRequests: protectedProcedure
		.input(
			z.object({
				enable: z.boolean(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const mainConfig = readMainConfig();
			if (!mainConfig) return false;

			const currentConfig = parse(mainConfig) as {
				accessLog?: {
					filePath: string;
				};
			};

			if (input.enable) {
				const config = {
					accessLog: {
						filePath: "/etc/dokploy/traefik/dynamic/access.log",
						format: "json",
						bufferingSize: 100,
						filters: {
							retryAttempts: true,
							minDuration: "10ms",
						},
					},
				};
				currentConfig.accessLog = config.accessLog;
			} else {
				currentConfig.accessLog = undefined;
			}

			writeMainConfig(stringify(currentConfig));
			await auditSettings(ctx, "update", "access-requests", {
				enable: input.enable,
			});
			return true;
		}),
	isCloud: publicProcedure.query(async () => {
		return IS_CLOUD;
	}),
	isUserSubscribed: protectedProcedure.query(async ({ ctx }) => {
		const haveServers = await db.query.server.findMany({
			where: eq(server.organizationId, ctx.session?.activeOrganizationId || ""),
		});
		const haveProjects = await db.query.projects.findMany({
			where: eq(
				projects.organizationId,
				ctx.session?.activeOrganizationId || "",
			),
		});
		return haveServers.length > 0 || haveProjects.length > 0;
	}),
	health: publicProcedure.query(async () => {
		try {
			await db.execute(sql`SELECT 1`);
			return { status: "ok" };
		} catch (error) {
			console.error("Database connection error:", error);
			throw error;
		}
	}),
	setupGPU: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD && !input.serverId) {
				throw new Error("Select a server to enable the GPU Setup");
			}

			try {
				await setupGPUSupport(input.serverId);
				await auditSettings(ctx, "run", "gpu-setup", {
					serverId: input.serverId,
				});
				return { success: true };
			} catch (error) {
				console.error("GPU Setup Error:", error);
				throw error;
			}
		}),
	checkGPUStatus: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input }) => {
			if (IS_CLOUD && !input.serverId) {
				return {
					driverInstalled: false,
					driverVersion: undefined,
					gpuModel: undefined,
					runtimeInstalled: false,
					runtimeConfigured: false,
					cudaSupport: undefined,
					cudaVersion: undefined,
					memoryInfo: undefined,
					availableGPUs: 0,
					swarmEnabled: false,
					gpuResources: 0,
				};
			}

			try {
				return await checkGPUStatus(input.serverId || "");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to check GPU status";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	updateTraefikPorts: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				additionalPorts: z.array(
					z.object({
						targetPort: z.number(),
						publishedPort: z.number(),
						protocol: z.enum(["tcp", "udp", "sctp"]),
					}),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				if (IS_CLOUD && !input.serverId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "Please set a serverId to update Traefik ports",
					});
				}
				const env = await readEnvironmentVariables(
					"dokploy-traefik",
					input?.serverId,
				);
				for (const port of input.additionalPorts) {
					const portCheck = await checkPortInUse(
						port.publishedPort,
						input.serverId,
					);
					if (portCheck.isInUse) {
						throw new TRPCError({
							code: "CONFLICT",
							message: portCheck.conflictingContainer
								? `Port ${port.publishedPort} is already in use by ${portCheck.conflictingContainer}`
								: `Port ${port.publishedPort} is already in use`,
						});
					}
				}
				const preparedEnv = prepareEnvironmentVariables(env);

				await writeTraefikSetup({
					env: preparedEnv,
					additionalPorts: input.additionalPorts,
					serverId: input.serverId,
				});
				await auditSettings(ctx, "update", "traefik-ports", {
					serverId: input.serverId,
					additionalPorts: input.additionalPorts,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error updating Traefik ports",
					cause: error,
				});
			}
		}),
	getTraefikPorts: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			try {
				const ports = await readPorts("dokploy-traefik", input?.serverId);
				return ports;
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "Resource type not found"
				) {
					return [];
				}
				throw error;
			}
		}),
	updateLogCleanup: protectedProcedure
		.input(
			z.object({
				cronExpression: z.string().nullable(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			if (input.cronExpression) {
				const result = await startLogCleanup(input.cronExpression);
				await auditSettings(ctx, "update", "log-cleanup", {
					cronExpression: input.cronExpression,
				});
				return result;
			}
			const result = await stopLogCleanup();
			await auditSettings(ctx, "update", "log-cleanup", {
				cronExpression: null,
			});
			return result;
		}),

	getLogCleanupStatus: protectedProcedure.query(async () => {
		return getLogCleanupStatus();
	}),

	getDokployCloudIps: adminProcedure.query(async () => {
		if (!IS_CLOUD) {
			return [];
		}
		const ips = process.env.DOKPLOY_CLOUD_IPS?.split(",");
		return ips;
	}),
});
