import path from "node:path";
import { db } from "@dokploy/server/db";
import type { z } from "zod";
import {
	type apiCreateProject,
	backups,
	applications,
	compose,
	mounts,
	volumeBackups,
	previewDeployments,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@dokploy/server/db/schema";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { deleteAllMiddlewares } from "@dokploy/server/utils/traefik/middleware";
import { removeService } from "@dokploy/server/utils/docker/utils";
import {
	removeComposeDirectory,
	removeDirectoryCode,
	removeDirectoryIfExistsContent,
	removeMonitoringDirectory,
} from "@dokploy/server/utils/filesystem/directory";
import { removeTraefikConfig } from "@dokploy/server/utils/traefik/application";
import { IS_CLOUD } from "@dokploy/server/constants";
import { paths } from "@dokploy/server/constants";
import { execAsync, execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { quote } from "shell-quote";
import { createProductionEnvironment } from "./environment";
import { findBackupsByDbId } from "./backup";

export type Project = typeof projects.$inferSelect;

export const createProject = async (
	input: z.infer<typeof apiCreateProject>,
	organizationId: string,
) => {
	const newProject = await db
		.insert(projects)
		.values({
			...input,
			organizationId: organizationId,
		})
		.returning()
		.then((value) => value[0]);

	if (!newProject) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the project",
		});
	}

	// Automatically create a production environment
	const newEnvironment = await createProductionEnvironment(
		newProject.projectId,
	);
	return {
		project: newProject,
		environment: newEnvironment,
	};
};

export const findProjectById = async (projectId: string) => {
	const project = await db.query.projects.findFirst({
		where: eq(projects.projectId, projectId),
		with: {
			environments: {
				with: {
					applications: true,
					mariadb: true,
					mongo: true,
					mysql: true,
					postgres: true,
					redis: true,
					compose: true,
				},
			},
		},
	});
	if (!project) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	}
	return project;
};

export const deleteProject = async (projectId: string) => {
	const project = await db
		.delete(projects)
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((value) => value[0]);

	return project;
};

export const deleteProjectWithCleanup = async (params: {
	projectId: string;
	deleteComposeVolumes?: boolean;
	deleteDatabaseVolumes?: boolean;
	deleteApplicationVolumes?: boolean;
}) => {
	const currentProject = await findProjectById(params.projectId);
	const environmentIds = currentProject.environments.map((e) => e.environmentId);

	const deleteComposeVolumes = params.deleteComposeVolumes ?? false;
	const deleteDatabaseVolumes = params.deleteDatabaseVolumes ?? false;
	const deleteApplicationVolumes = params.deleteApplicationVolumes ?? false;

	const cancelBackupJobs = async (
		items: Array<{ backupId: string; schedule: string; enabled: boolean | null }>,
	) => {
		for (const backup of items) {
			if (!backup.enabled) continue;
			if (IS_CLOUD) {
				try {
					await fetch(`${process.env.JOBS_URL}/remove-job`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-API-Key": process.env.API_KEY || "NO-DEFINED",
						},
						body: JSON.stringify({
							type: "backup",
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
						}),
					});
				} catch {}
			} else {
				try {
					const { removeScheduleBackup } = await import(
						"@dokploy/server/utils/backups/utils"
					);
					removeScheduleBackup(backup.backupId);
				} catch {}
			}
		}
	};

	const removeDockerVolumes = async (volumeNames: string[], serverId?: string | null) => {
		const unique = Array.from(
			new Set(volumeNames.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0)),
		);
		for (const v of unique) {
			try {
				const cmd = `docker volume rm ${quote([v])}`;
				if (serverId) {
					await execAsyncRemote(serverId, cmd);
				} else {
					await execAsync(cmd);
				}
			} catch {}
		}
	};

	const cancelVolumeBackupJobs = async (items: Array<{
		volumeBackupId: string;
		cronExpression: string;
		enabled: boolean | null;
	}>) => {
		for (const vb of items) {
			if (!vb.enabled) continue;
			if (IS_CLOUD) {
				try {
					await fetch(`${process.env.JOBS_URL}/remove-job`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-API-Key": process.env.API_KEY || "NO-DEFINED",
						},
						body: JSON.stringify({
							type: "volume-backup",
							cronSchedule: vb.cronExpression,
							volumeBackupId: vb.volumeBackupId,
						}),
					});
				} catch {}
			} else {
				try {
					const { removeVolumeBackupJob } = await import(
						"@dokploy/server/utils/volume-backups/utils"
					);
					await removeVolumeBackupJob(vb.volumeBackupId);
				} catch {}
			}
		}
	};

	const removeLogsDirectory = async (
		appName: string,
		serverId?: string | null,
	) => {
		const { LOGS_PATH } = paths(!!serverId);
		const logsPath = path.join(LOGS_PATH, appName);
		if (serverId) {
			try {
				await execAsyncRemote(serverId, `rm -rf ${logsPath}`);
			} catch {}
			return;
		}
		try {
			await removeDirectoryIfExistsContent(logsPath);
		} catch {}
	};

	if (environmentIds.length > 0) {
		const apps = await db.query.applications.findMany({
			where: inArray(applications.environmentId, environmentIds),
			with: {
				mounts: true,
				security: true,
				redirects: true,
				ports: true,
				registry: true,
				buildRegistry: true,
				environment: { with: { project: true } },
			},
		});

		for (const app of apps) {
			const appVolumeBackups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.applicationId, app.applicationId),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
				},
			});
			await cancelVolumeBackupJobs(appVolumeBackups);

			const previews = await db.query.previewDeployments.findMany({
				where: eq(previewDeployments.applicationId, app.applicationId),
			});
			for (const preview of previews) {
				try {
					await removeService(preview.appName, app.serverId ?? null);
					await removeLogsDirectory(preview.appName, app.serverId ?? null);
					await removeDirectoryCode(preview.appName, app.serverId ?? null);
					await removeTraefikConfig(preview.appName, app.serverId ?? null);
				} catch {}
			}

			const nested = app as unknown as ApplicationNested;
			const appMounts = deleteApplicationVolumes
				? await db.query.mounts.findMany({
						where: eq(mounts.applicationId, app.applicationId),
						columns: { type: true, volumeName: true },
					})
				: [];
			const cleanupOperations = [
				async () => await deleteAllMiddlewares(nested),
				async () => await removeLogsDirectory(app.appName, app.serverId ?? null),
				async () => await removeDirectoryCode(app.appName, app.serverId ?? null),
				async () =>
					await removeMonitoringDirectory(app.appName, app.serverId ?? null),
				async () => await removeTraefikConfig(app.appName, app.serverId ?? null),
				async () => await removeService(app.appName, app.serverId ?? null),
				async () =>
					await removeDockerVolumes(
						appMounts
							.filter((m) => m.type === "volume")
							.map((m) => m.volumeName ?? "")
							.filter((v) => v.length > 0),
						app.serverId ?? null,
					),
			];
			for (const operation of cleanupOperations) {
				try {
					await operation();
				} catch {}
			}
		}

		const composeServices = await db.query.compose.findMany({
			where: inArray(compose.environmentId, environmentIds),
		});
		for (const s of composeServices) {
			const composeVolumeBackups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.composeId, s.composeId),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
				},
			});
			await cancelVolumeBackupJobs(composeVolumeBackups);

			const composeMounts = deleteComposeVolumes
				? await db.query.mounts.findMany({
						where: eq(mounts.composeId, s.composeId),
						columns: { type: true, volumeName: true },
					})
				: [];
			const cleanupOperations = [
				async () => {
					const svc = await db.query.compose.findFirst({
						where: eq(compose.composeId, s.composeId),
						with: {
							environment: { with: { project: true } },
							deployments: true,
							mounts: true,
							domains: true,
							backups: true,
							server: true,
						},
					});
					if (svc) {
						const composeBackups = await db.query.backups.findMany({
							where: eq(backups.composeId, svc.composeId),
							columns: {
								backupId: true,
								schedule: true,
								enabled: true,
							},
						});
						await cancelBackupJobs(
							composeBackups.map((b) => ({
								backupId: b.backupId,
								schedule: b.schedule,
								enabled: b.enabled,
							})),
						);
						await (await import("./compose")).removeCompose(
							svc as never,
							deleteComposeVolumes,
						);
					}
				},
				async () => await removeLogsDirectory(s.appName, s.serverId ?? null),
				async () => await removeComposeDirectory(s.appName, s.serverId ?? null),
				async () =>
					await removeDockerVolumes(
						composeMounts
							.filter((m) => m.type === "volume")
							.map((m) => m.volumeName ?? "")
							.filter((v) => v.length > 0),
						s.serverId ?? null,
					),
			];
			for (const operation of cleanupOperations) {
				try {
					await operation();
				} catch {}
			}
		}

		const postgresServices = await db.query.postgres.findMany({
			where: inArray(postgres.environmentId, environmentIds),
		});
		for (const s of postgresServices) {
			const dbVolumeBackups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.postgresId, s.postgresId),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
				},
			});
			await cancelVolumeBackupJobs(dbVolumeBackups);

			const backupsList = await findBackupsByDbId(s.postgresId, "postgres");
			await cancelBackupJobs(
				backupsList.map((b) => ({
					backupId: b.backupId,
					schedule: b.schedule,
					enabled: b.enabled,
				})),
			);
			const volumeNames = deleteDatabaseVolumes
				? (
						await db.query.mounts.findMany({
							where: eq(mounts.postgresId, s.postgresId),
							columns: { type: true, volumeName: true },
						})
					)
						.filter((m) => m.type === "volume")
						.map((m) => m.volumeName ?? "")
						.filter((v) => v.length > 0)
				: [];
			try {
				await removeService(s.appName, s.serverId ?? null);
			} catch {}
			try {
				await removeDockerVolumes(volumeNames, s.serverId ?? null);
			} catch {}
		}

		const mysqlServices = await db.query.mysql.findMany({
			where: inArray(mysql.environmentId, environmentIds),
		});
		for (const s of mysqlServices) {
			const dbVolumeBackups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.mysqlId, s.mysqlId),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
				},
			});
			await cancelVolumeBackupJobs(dbVolumeBackups);

			const backupsList = await findBackupsByDbId(s.mysqlId, "mysql");
			await cancelBackupJobs(
				backupsList.map((b) => ({
					backupId: b.backupId,
					schedule: b.schedule,
					enabled: b.enabled,
				})),
			);
			const volumeNames = deleteDatabaseVolumes
				? (
						await db.query.mounts.findMany({
							where: eq(mounts.mysqlId, s.mysqlId),
							columns: { type: true, volumeName: true },
						})
					)
						.filter((m) => m.type === "volume")
						.map((m) => m.volumeName ?? "")
						.filter((v) => v.length > 0)
				: [];
			try {
				await removeService(s.appName, s.serverId ?? null);
			} catch {}
			try {
				await removeDockerVolumes(volumeNames, s.serverId ?? null);
			} catch {}
		}

		const mariadbServices = await db.query.mariadb.findMany({
			where: inArray(mariadb.environmentId, environmentIds),
		});
		for (const s of mariadbServices) {
			const dbVolumeBackups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.mariadbId, s.mariadbId),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
				},
			});
			await cancelVolumeBackupJobs(dbVolumeBackups);

			const backupsList = await findBackupsByDbId(s.mariadbId, "mariadb");
			await cancelBackupJobs(
				backupsList.map((b) => ({
					backupId: b.backupId,
					schedule: b.schedule,
					enabled: b.enabled,
				})),
			);
			const volumeNames = deleteDatabaseVolumes
				? (
						await db.query.mounts.findMany({
							where: eq(mounts.mariadbId, s.mariadbId),
							columns: { type: true, volumeName: true },
						})
					)
						.filter((m) => m.type === "volume")
						.map((m) => m.volumeName ?? "")
						.filter((v) => v.length > 0)
				: [];
			try {
				await removeService(s.appName, s.serverId ?? null);
			} catch {}
			try {
				await removeDockerVolumes(volumeNames, s.serverId ?? null);
			} catch {}
		}

		const mongoServices = await db.query.mongo.findMany({
			where: inArray(mongo.environmentId, environmentIds),
		});
		for (const s of mongoServices) {
			const dbVolumeBackups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.mongoId, s.mongoId),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
				},
			});
			await cancelVolumeBackupJobs(dbVolumeBackups);

			const backupsList = await findBackupsByDbId(s.mongoId, "mongo");
			await cancelBackupJobs(
				backupsList.map((b) => ({
					backupId: b.backupId,
					schedule: b.schedule,
					enabled: b.enabled,
				})),
			);
			const volumeNames = deleteDatabaseVolumes
				? (
						await db.query.mounts.findMany({
							where: eq(mounts.mongoId, s.mongoId),
							columns: { type: true, volumeName: true },
						})
					)
						.filter((m) => m.type === "volume")
						.map((m) => m.volumeName ?? "")
						.filter((v) => v.length > 0)
				: [];
			try {
				await removeService(s.appName, s.serverId ?? null);
			} catch {}
			try {
				await removeDockerVolumes(volumeNames, s.serverId ?? null);
			} catch {}
		}

		const redisServices = await db.query.redis.findMany({
			where: inArray(redis.environmentId, environmentIds),
		});
		for (const s of redisServices) {
			const dbVolumeBackups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups.redisId, s.redisId),
				columns: {
					volumeBackupId: true,
					cronExpression: true,
					enabled: true,
				},
			});
			await cancelVolumeBackupJobs(dbVolumeBackups);

			const volumeNames = deleteDatabaseVolumes
				? (
						await db.query.mounts.findMany({
							where: eq(mounts.redisId, s.redisId),
							columns: { type: true, volumeName: true },
						})
					)
						.filter((m) => m.type === "volume")
						.map((m) => m.volumeName ?? "")
						.filter((v) => v.length > 0)
				: [];
			try {
				await removeService(s.appName, s.serverId ?? null);
			} catch {}
			try {
				await removeDockerVolumes(volumeNames, s.serverId ?? null);
			} catch {}
		}
	}

	return deleteProject(params.projectId);
};

export const updateProjectById = async (
	projectId: string,
	projectData: Partial<Project>,
) => {
	const result = await db
		.update(projects)
		.set({
			...projectData,
		})
		.where(eq(projects.projectId, projectId))
		.returning()
		.then((res) => res[0]);

	return result;
};

export const validUniqueServerAppName = async (appName: string) => {
	const query = await db.query.environments.findMany({
		with: {
			applications: {
				where: eq(applications.appName, appName),
			},
			mariadb: {
				where: eq(mariadb.appName, appName),
			},
			mongo: {
				where: eq(mongo.appName, appName),
			},
			mysql: {
				where: eq(mysql.appName, appName),
			},
			postgres: {
				where: eq(postgres.appName, appName),
			},
			redis: {
				where: eq(redis.appName, appName),
			},
		},
	});

	// Filter out items with non-empty fields
	const nonEmptyProjects = query.filter(
		(project) =>
			project.applications.length > 0 ||
			project.mariadb.length > 0 ||
			project.mongo.length > 0 ||
			project.mysql.length > 0 ||
			project.postgres.length > 0 ||
			project.redis.length > 0,
	);

	return nonEmptyProjects.length === 0;
};
