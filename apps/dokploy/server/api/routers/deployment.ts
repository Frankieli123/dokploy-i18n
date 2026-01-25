import { promises as fs } from "node:fs";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findApplicationById,
	findComposeById,
	findDeploymentById,
	findServerById,
	IS_CLOUD,
	updateDeploymentStatus,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import {
	apiFindAllByApplication,
	apiFindAllByCompose,
	apiFindAllByServer,
	apiFindAllByType,
	deployments,
} from "@/server/db/schema";
import { myQueue } from "@/server/queues/queueSetup";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const MAX_BYTES_HARD_LIMIT = 2 * 1024 * 1024;
const TAIL_MAX_LINES = 2000;

async function tailFile(
	filePath: string,
	lines: number,
	maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
	const clampedBytes = Math.max(1, Math.min(MAX_BYTES_HARD_LIMIT, maxBytes));
	const clampedLines = Math.max(1, Math.min(TAIL_MAX_LINES, lines));

	const st = await fs.stat(filePath);
	const start = Math.max(0, st.size - clampedBytes);
	const handle = await fs.open(filePath, "r");
	try {
		const len = Math.max(0, st.size - start);
		const buffer = Buffer.alloc(len);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const parts = text.split(/\r?\n/);
		return {
			content: parts.slice(-clampedLines).join("\n"),
			truncated: start > 0,
		};
	} finally {
		await handle.close();
	}
}

function isPathInsideBase(basePath: string, filePath: string): boolean {
	const norm = (value: string) => value.replace(/\\/g, "/");
	const base = path.posix.normalize(norm(basePath)).replace(/\/+$/g, "");
	const full = path.posix.normalize(norm(filePath));
	return full === base || full.startsWith(`${base}/`);
}

function shQuote(value: string): string {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export const deploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllByApplication)
		.query(async ({ input, ctx }) => {
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}
			return await findAllDeploymentsByApplicationId(input.applicationId);
		}),

	allByCompose: protectedProcedure
		.input(apiFindAllByCompose)
		.query(async ({ input, ctx }) => {
			const compose = await findComposeById(input.composeId);
			if (
				compose.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this compose",
				});
			}
			return await findAllDeploymentsByComposeId(input.composeId);
		}),
	allByServer: protectedProcedure
		.input(apiFindAllByServer)
		.query(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this server",
				});
			}
			return await findAllDeploymentsByServerId(input.serverId);
		}),

	allByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input }) => {
			const deploymentsList = await db.query.deployments.findMany({
				where: eq(deployments[`${input.type}Id`], input.id),
				orderBy: desc(deployments.createdAt),
				with: {
					rollback: true,
				},
			});

			return deploymentsList;
		}),

	queueByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input, ctx }) => {
			if (IS_CLOUD) return [];
			try {
				if (input.type !== "application" && input.type !== "compose") {
					return [];
				}

				if (input.type === "application") {
					const application = await findApplicationById(input.id);
					if (
						application.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this application",
						});
					}
				}

				if (input.type === "compose") {
					const compose = await findComposeById(input.id);
					if (
						compose.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this compose",
						});
					}
				}

				const [activeJobs, waitingJobs, delayedJobs] = await Promise.all([
					myQueue.getJobs(["active"]),
					myQueue.getJobs(["waiting"]),
					myQueue.getJobs(["delayed"]),
				]);

				const jobs = [
					...activeJobs.map((job) => ({ job, state: "active" as const })),
					...waitingJobs.map((job) => ({ job, state: "waiting" as const })),
					...delayedJobs.map((job) => ({ job, state: "delayed" as const })),
				];

				return jobs
					.filter((job) => {
						if (input.type === "application") {
							return (
								job.job.data?.applicationType === "application" &&
								job.job.data?.applicationId === input.id
							);
						}
						return (
							job.job.data?.applicationType === "compose" &&
							job.job.data?.composeId === input.id
						);
					})
					.map(({ job, state }) => ({
						jobId: String(job.id ?? ""),
						state,
						name: job.name,
						createdAt: new Date(job.timestamp).toISOString(),
						data: job.data,
					}));
			} catch (error) {
				if (error instanceof TRPCError) {
					throw error;
				}
				return [];
			}
		}),

	killProcess: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input }) => {
			const deployment = await findDeploymentById(input.deploymentId);

			if (!deployment.pid) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}

			const command = `kill -9 ${deployment.pid}`;
			if (deployment.schedule?.serverId) {
				await execAsyncRemote(deployment.schedule.serverId, command);
			} else {
				await execAsync(command);
			}

			await updateDeploymentStatus(deployment.deploymentId, "error");
		}),

	readLog: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
				lines: z.number().min(1).max(TAIL_MAX_LINES).optional().default(200),
				maxBytes: z
					.number()
					.min(1)
					.max(MAX_BYTES_HARD_LIMIT)
					.optional()
					.default(64 * 1024),
			}),
		)
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);

			if (deployment.applicationId) {
				const application = await findApplicationById(deployment.applicationId);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this application",
					});
				}
			} else if (deployment.composeId) {
				const compose = await findComposeById(deployment.composeId);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this compose",
					});
				}
			} else if (deployment.serverId) {
				const server = await findServerById(deployment.serverId);
				if (server.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}
			}

			const logServerId =
				deployment.buildServerId ||
				deployment.serverId ||
				deployment.application?.buildServerId ||
				deployment.application?.serverId ||
				deployment.schedule?.serverId ||
				null;
			const basePath = paths(!!logServerId).BASE_PATH;
			if (!isPathInsideBase(basePath, deployment.logPath)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Log path is outside Dokploy base path",
				});
			}

			if (logServerId) {
				const cmd = `tail -n ${input.lines} -- ${shQuote(deployment.logPath)}`;
				const { stdout, stderr } = await execAsyncRemote(logServerId, cmd);
				return {
					logPath: deployment.logPath,
					serverId: logServerId,
					content: stdout,
					stderr,
					truncated: false,
				};
			}

			const result = await tailFile(deployment.logPath, input.lines, input.maxBytes);
			return {
				logPath: deployment.logPath,
				serverId: null,
				stderr: "",
				...result,
			};
		}),
});
