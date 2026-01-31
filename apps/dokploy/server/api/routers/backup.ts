import {
	buildMariadbExternalMigrationCommand,
	buildMongoExternalMigrationCommand,
	buildMysqlExternalMigrationCommand,
	buildPostgresExternalMigrationCommand,
	buildRedisExternalMigrationCommand,
	checkServiceAccess,
	createBackup,
	createVolumeBackup,
	findBackupById,
	findComposeByBackupId,
	findComposeById,
	findMariadbByBackupId,
	findMariadbById,
	findMongoByBackupId,
	findMongoById,
	findMySqlByBackupId,
	findMySqlById,
	findPostgresByBackupId,
	findPostgresById,
	findRedisById,
	findServerById,
	IS_CLOUD,
	keepLatestNBackups,
	loadServices,
	removeBackupById,
	removeScheduleBackup,
	restoreVolume,
	runMariadbBackup,
	runMongoBackup,
	runMySqlBackup,
	runPostgresBackup,
	runVolumeBackup,
	runWebServerBackup,
	scheduleBackup,
	updateBackupById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { findDestinationById } from "@dokploy/server/services/destination";
import { runComposeBackup } from "@dokploy/server/utils/backups/compose";
import {
	getS3Credentials,
	normalizeS3Path,
} from "@dokploy/server/utils/backups/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import {
	restoreComposeBackup,
	restoreMariadbBackup,
	restoreMongoBackup,
	restoreMySqlBackup,
	restorePostgresBackup,
	restoreWebServerBackup,
} from "@dokploy/server/utils/restore";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import {
	apiCreateBackup,
	apiFindOneBackup,
	apiRemoveBackup,
	apiRestoreBackup,
	apiUpdateBackup,
	backups,
	destinations,
	volumeBackups,
} from "@/server/db/schema";
import { removeJob, schedule, updateJob } from "@/server/utils/backup";

interface RcloneFile {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	Tier?: string;
	Hashes?: {
		MD5?: string;
		SHA1?: string;
	};
}

export const backupRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateBackup)
		.mutation(async ({ input }) => {
			try {
				const newBackup = await createBackup(input);

				const backup = await findBackupById(newBackup.backupId);

				if (IS_CLOUD && backup.enabled) {
					const databaseType = backup.databaseType;
					let serverId = "";
					if (databaseType === "postgres" && backup.postgres?.serverId) {
						serverId = backup.postgres.serverId;
					} else if (databaseType === "mysql" && backup.mysql?.serverId) {
						serverId = backup.mysql.serverId;
					} else if (databaseType === "mongo" && backup.mongo?.serverId) {
						serverId = backup.mongo.serverId;
					} else if (databaseType === "mariadb" && backup.mariadb?.serverId) {
						serverId = backup.mariadb.serverId;
					} else if (
						backup.backupType === "compose" &&
						backup.compose?.serverId
					) {
						serverId = backup.compose.serverId;
					}
					const server = await findServerById(serverId);

					if (server.serverStatus === "inactive") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Server is inactive",
						});
					}
					await schedule({
						cronSchedule: backup.schedule,
						backupId: backup.backupId,
						type: "backup",
					});
				} else {
					if (backup.enabled) {
						scheduleBackup(backup);
					}
				}
			} catch (error) {
				console.error(error);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error creating the Backup",
					cause: error,
				});
			}
		}),
	one: protectedProcedure.input(apiFindOneBackup).query(async ({ input }) => {
		const backup = await findBackupById(input.backupId);

		return backup;
	}),
	update: protectedProcedure
		.input(apiUpdateBackup)
		.mutation(async ({ input }) => {
			try {
				await updateBackupById(input.backupId, input);
				const backup = await findBackupById(input.backupId);

				if (IS_CLOUD) {
					if (backup.enabled) {
						await updateJob({
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
							type: "backup",
						});
					} else {
						await removeJob({
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
							type: "backup",
						});
					}
				} else {
					if (backup.enabled) {
						removeScheduleBackup(input.backupId);
						scheduleBackup(backup);
					} else {
						removeScheduleBackup(input.backupId);
					}
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Error updating this Backup";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	remove: protectedProcedure
		.input(apiRemoveBackup)
		.mutation(async ({ input }) => {
			try {
				const value = await removeBackupById(input.backupId);
				if (IS_CLOUD && value) {
					removeJob({
						backupId: input.backupId,
						cronSchedule: value.schedule,
						type: "backup",
					});
				} else if (!IS_CLOUD) {
					removeScheduleBackup(input.backupId);
				}
				return value;
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Error deleting this Backup";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	fullBackup: protectedProcedure.mutation(async ({ ctx }) => {
		if (ctx.user.role === "member") {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to run a full backup",
			});
		}

		const organizationId = ctx.session.activeOrganizationId;
		if (!organizationId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "No active organization found",
			});
		}

		const userId = ctx.user.id;

		const destinationId =
			(
				await db.query.destinations.findFirst({
					where: eq(destinations.organizationId, organizationId),
					orderBy: (t, { desc }) => [desc(t.createdAt)],
				})
			)?.destinationId ?? null;

		if (!destinationId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "No backup destination found for this organization",
			});
		}

		const runBackupById = async (backupId: string) => {
			const backup = await findBackupById(backupId);

			if (backup.databaseType === "web-server") {
				await runWebServerBackup(backup);
				await keepLatestNBackups(backup);
				return;
			}

			if (backup.backupType === "compose") {
				const compose = backup.compose ?? (await findComposeByBackupId(backup.backupId));
				if (!compose) throw new Error("Compose service not found");
				await runComposeBackup(compose, backup);
				await keepLatestNBackups(backup, compose.serverId);
				return;
			}

			if (backup.databaseType === "postgres") {
				const postgres = backup.postgres ?? (await findPostgresByBackupId(backup.backupId));
				if (!postgres) throw new Error("Postgres service not found");
				await runPostgresBackup(postgres, backup);
				await keepLatestNBackups(backup, postgres.serverId);
				return;
			}
			if (backup.databaseType === "mysql") {
				const mysql = backup.mysql ?? (await findMySqlByBackupId(backup.backupId));
				if (!mysql) throw new Error("MySQL service not found");
				await runMySqlBackup(mysql, backup);
				await keepLatestNBackups(backup, mysql.serverId);
				return;
			}
			if (backup.databaseType === "mariadb") {
				const mariadb = backup.mariadb ?? (await findMariadbByBackupId(backup.backupId));
				if (!mariadb) throw new Error("MariaDB service not found");
				await runMariadbBackup(mariadb, backup);
				await keepLatestNBackups(backup, mariadb.serverId);
				return;
			}
			if (backup.databaseType === "mongo") {
				const mongo = backup.mongo ?? (await findMongoByBackupId(backup.backupId));
				if (!mongo) throw new Error("MongoDB service not found");
				await runMongoBackup(mongo, backup);
				await keepLatestNBackups(backup, mongo.serverId);
				return;
			}
		};

		const allMountsVolumeName = "dokploy_all_mounts";
		const defaultCron = "0 0 * * *";
		const basePrefix = `dokploy/full-backups/${organizationId}`;

		setImmediate(() => {
			void (async () => {
				try {
					const plannedBackupIds: string[] = [];
					const plannedVolumeBackupIds: string[] = [];

					const webServerBackup =
						(await db.query.backups.findFirst({
							where: and(
								eq(backups.databaseType, "web-server"),
								eq(backups.userId, userId),
								eq(backups.destinationId, destinationId),
							),
						})) ??
						(await createBackup({
							databaseType: "web-server",
							backupType: "database",
							destinationId,
							prefix: `${basePrefix}/web-server`,
							schedule: defaultCron,
							enabled: false,
							database: "dokploy",
							userId,
						}));

					plannedBackupIds.push(webServerBackup.backupId);

					const postgresServices = (
						await db.query.postgres.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter(
						(s) => s.environment.project.organizationId === organizationId,
					);

					for (const postgres of postgresServices) {
						const backup =
							(await db.query.backups.findFirst({
								where: and(
									eq(backups.databaseType, "postgres"),
									eq(backups.postgresId, postgres.postgresId),
									eq(backups.destinationId, destinationId),
								),
							})) ??
							(await createBackup({
								databaseType: "postgres",
								backupType: "database",
								destinationId,
								prefix: `${basePrefix}/databases/postgres/${postgres.appName}`,
								schedule: defaultCron,
								enabled: false,
								database: postgres.databaseName,
								postgresId: postgres.postgresId,
							}));
						plannedBackupIds.push(backup.backupId);
					}

					const mysqlServices = (
						await db.query.mysql.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((s) => s.environment.project.organizationId === organizationId);

					for (const mysql of mysqlServices) {
						const backup =
							(await db.query.backups.findFirst({
								where: and(
									eq(backups.databaseType, "mysql"),
									eq(backups.mysqlId, mysql.mysqlId),
									eq(backups.destinationId, destinationId),
								),
							})) ??
							(await createBackup({
								databaseType: "mysql",
								backupType: "database",
								destinationId,
								prefix: `${basePrefix}/databases/mysql/${mysql.appName}`,
								schedule: defaultCron,
								enabled: false,
								database: mysql.databaseName,
								mysqlId: mysql.mysqlId,
							}));
						plannedBackupIds.push(backup.backupId);
					}

					const mariadbServices = (
						await db.query.mariadb.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter(
						(s) => s.environment.project.organizationId === organizationId,
					);

					for (const mariadb of mariadbServices) {
						const backup =
							(await db.query.backups.findFirst({
								where: and(
									eq(backups.databaseType, "mariadb"),
									eq(backups.mariadbId, mariadb.mariadbId),
									eq(backups.destinationId, destinationId),
								),
							})) ??
							(await createBackup({
								databaseType: "mariadb",
								backupType: "database",
								destinationId,
								prefix: `${basePrefix}/databases/mariadb/${mariadb.appName}`,
								schedule: defaultCron,
								enabled: false,
								database: mariadb.databaseName,
								mariadbId: mariadb.mariadbId,
							}));
						plannedBackupIds.push(backup.backupId);
					}

					const mongoServices = (
						await db.query.mongo.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((s) => s.environment.project.organizationId === organizationId);

					for (const mongo of mongoServices) {
						const backup =
							(await db.query.backups.findFirst({
								where: and(
									eq(backups.databaseType, "mongo"),
									eq(backups.mongoId, mongo.mongoId),
									eq(backups.destinationId, destinationId),
								),
							})) ??
							(await createBackup({
								databaseType: "mongo",
								backupType: "database",
								destinationId,
								prefix: `${basePrefix}/databases/mongo/${mongo.appName}`,
								schedule: defaultCron,
								enabled: false,
								database: "*",
								mongoId: mongo.mongoId,
							}));
						plannedBackupIds.push(backup.backupId);
					}

					const applications = (
						await db.query.applications.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((a) => a.environment.project.organizationId === organizationId);

					for (const app of applications) {
						const volumeBackup =
							(await db.query.volumeBackups.findFirst({
								where: and(
									eq(volumeBackups.applicationId, app.applicationId),
									eq(volumeBackups.volumeName, allMountsVolumeName),
									eq(volumeBackups.destinationId, destinationId),
								),
							})) ??
							(await createVolumeBackup({
								name: "ALL",
								volumeName: "ALL",
								prefix: `${basePrefix}/volumes/application/${app.appName}`,
								serviceType: "application",
								turnOff: false,
								cronExpression: defaultCron,
								enabled: false,
								applicationId: app.applicationId,
								destinationId,
							}));

						if (!volumeBackup) continue;
						plannedVolumeBackupIds.push(volumeBackup.volumeBackupId);
					}

					const composeServices = (
						await db.query.compose.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((c) => c.environment.project.organizationId === organizationId);

					for (const compose of composeServices) {
						let services: string[] = [];
						try {
							services = await loadServices(compose.composeId, "cache");
						} catch {
							try {
								services = await loadServices(compose.composeId, "fetch");
							} catch (error) {
								console.error(
									`FullBackup: failed to load compose services for ${compose.composeId}`,
									error,
								);
								continue;
							}
						}

							for (const serviceName of services) {
								const volumeBackup =
									(await db.query.volumeBackups.findFirst({
										where: and(
											eq(volumeBackups.composeId, compose.composeId),
											eq(volumeBackups.serviceName, serviceName),
											eq(volumeBackups.volumeName, allMountsVolumeName),
											eq(volumeBackups.destinationId, destinationId),
										),
									})) ??
									(await createVolumeBackup({
										name: `ALL - ${serviceName}`,
										volumeName: "ALL",
										prefix: `${basePrefix}/volumes/compose/${compose.appName}/${serviceName}`,
										serviceType: "compose",
										turnOff: false,
										cronExpression: defaultCron,
										enabled: false,
										composeId: compose.composeId,
										serviceName,
										destinationId,
									}));

								if (!volumeBackup) continue;
								plannedVolumeBackupIds.push(volumeBackup.volumeBackupId);
							}
						}

					for (const backupId of plannedBackupIds) {
						try {
							await runBackupById(backupId);
						} catch (error) {
							console.error(`FullBackup: error running backup ${backupId}`, error);
						}
					}

					for (const volumeBackupId of plannedVolumeBackupIds) {
						try {
							await runVolumeBackup(volumeBackupId);
						} catch (error) {
							console.error(
								`FullBackup: error running volume backup ${volumeBackupId}`,
								error,
							);
						}
					}
				} catch (error) {
					console.error("FullBackup: Critical error in background job", error);
				}
			})();
		});

		return { started: true };
	}),
	fullRestore: protectedProcedure.mutation(async ({ ctx }) => {
		if (ctx.user.role === "member") {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to run a full restore",
			});
		}

		const organizationId = ctx.session.activeOrganizationId;
		if (!organizationId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "No active organization found",
			});
		}

		const destinationId =
			(
				await db.query.destinations.findFirst({
					where: eq(destinations.organizationId, organizationId),
					orderBy: (t, { desc }) => [desc(t.createdAt)],
				})
			)?.destinationId ?? null;

		if (!destinationId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "No backup destination found for this organization",
			});
		}

		const destination = await findDestinationById(destinationId);
		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;

		const getLatestBackupObjectKey = async (
			prefix: string,
			include: string,
		): Promise<string | null> => {
			const normalizedPrefix = normalizeS3Path(prefix);
			const listPath = normalizedPrefix
				? `${bucketPath}/${normalizedPrefix}`
				: bucketPath;

			try {
				const { stdout } = await execAsync(
					`rclone lsf ${rcloneFlags.join(" ")} --include "${include}" "${listPath}" 2>/dev/null | sort -r | head -n 1`,
				);
				const latestFileName = stdout.trim();
				if (!latestFileName) return null;
				return `${normalizedPrefix}${latestFileName}`;
			} catch (error) {
				console.error(
					`FullRestore: failed to list latest backup under ${listPath} (${include})`,
					error,
				);
				return null;
			}
		};

		setImmediate(() => {
			void (async () => {
				try {
					const plannedBackupIds: string[] = [];
					const plannedVolumeBackupIds: string[] = [];

					const postgresServices = (
						await db.query.postgres.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter(
						(s) => s.environment.project.organizationId === organizationId,
					);

					for (const postgres of postgresServices) {
						const backup = await db.query.backups.findFirst({
							where: and(
								eq(backups.databaseType, "postgres"),
								eq(backups.postgresId, postgres.postgresId),
								eq(backups.destinationId, destinationId),
							),
						});
						if (backup) plannedBackupIds.push(backup.backupId);
					}

					const mysqlServices = (
						await db.query.mysql.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((s) => s.environment.project.organizationId === organizationId);

					for (const mysql of mysqlServices) {
						const backup = await db.query.backups.findFirst({
							where: and(
								eq(backups.databaseType, "mysql"),
								eq(backups.mysqlId, mysql.mysqlId),
								eq(backups.destinationId, destinationId),
							),
						});
						if (backup) plannedBackupIds.push(backup.backupId);
					}

					const mariadbServices = (
						await db.query.mariadb.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter(
						(s) => s.environment.project.organizationId === organizationId,
					);

					for (const mariadb of mariadbServices) {
						const backup = await db.query.backups.findFirst({
							where: and(
								eq(backups.databaseType, "mariadb"),
								eq(backups.mariadbId, mariadb.mariadbId),
								eq(backups.destinationId, destinationId),
							),
						});
						if (backup) plannedBackupIds.push(backup.backupId);
					}

					const mongoServices = (
						await db.query.mongo.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((s) => s.environment.project.organizationId === organizationId);

					for (const mongo of mongoServices) {
						const backup = await db.query.backups.findFirst({
							where: and(
								eq(backups.databaseType, "mongo"),
								eq(backups.mongoId, mongo.mongoId),
								eq(backups.destinationId, destinationId),
							),
						});
						if (backup) plannedBackupIds.push(backup.backupId);
					}

					const allMountsVolumeName = "dokploy_all_mounts";

					const applications = (
						await db.query.applications.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((a) => a.environment.project.organizationId === organizationId);

					for (const app of applications) {
						const volumeBackup = await db.query.volumeBackups.findFirst({
							where: and(
								eq(volumeBackups.applicationId, app.applicationId),
								eq(volumeBackups.volumeName, allMountsVolumeName),
								eq(volumeBackups.destinationId, destinationId),
							),
						});
						if (volumeBackup) plannedVolumeBackupIds.push(volumeBackup.volumeBackupId);
					}

					const composeServices = (
						await db.query.compose.findMany({
							with: { environment: { with: { project: true } } },
						})
					).filter((c) => c.environment.project.organizationId === organizationId);

					for (const compose of composeServices) {
						const volumeBackupsForCompose = await db.query.volumeBackups.findMany({
							where: and(
								eq(volumeBackups.composeId, compose.composeId),
								eq(volumeBackups.volumeName, allMountsVolumeName),
								eq(volumeBackups.destinationId, destinationId),
							),
						});
						for (const vb of volumeBackupsForCompose) {
							plannedVolumeBackupIds.push(vb.volumeBackupId);
						}
					}

					for (const backupId of plannedBackupIds) {
						try {
							const backup = await findBackupById(backupId);
							const backupFile = await getLatestBackupObjectKey(
								backup.prefix,
								"*.sql.gz",
							);
							if (!backupFile) {
								console.error(
									`FullRestore: no backup files found for ${backup.databaseType} ${backup.backupId}`,
								);
								continue;
							}

							if (backup.databaseType === "postgres") {
								const postgres =
									backup.postgres ??
									(await findPostgresByBackupId(backup.backupId));
								if (!postgres) throw new Error("Postgres service not found");
								await restorePostgresBackup(
									postgres,
									destination,
									{
										databaseId: postgres.postgresId,
										databaseType: "postgres",
										backupType: "database",
										databaseName: backup.database,
										backupFile,
										destinationId,
										metadata: backup.metadata ?? undefined,
									},
									(log) =>
										console.log(`FullRestore[postgres:${postgres.appName}] ${log}`),
								);
							} else if (backup.databaseType === "mysql") {
								const mysql =
									backup.mysql ?? (await findMySqlByBackupId(backup.backupId));
								if (!mysql) throw new Error("MySQL service not found");
								await restoreMySqlBackup(
									mysql,
									destination,
									{
										databaseId: mysql.mysqlId,
										databaseType: "mysql",
										backupType: "database",
										databaseName: backup.database,
										backupFile,
										destinationId,
										metadata: backup.metadata ?? undefined,
									},
									(log) =>
										console.log(`FullRestore[mysql:${mysql.appName}] ${log}`),
								);
							} else if (backup.databaseType === "mariadb") {
								const mariadb =
									backup.mariadb ??
									(await findMariadbByBackupId(backup.backupId));
								if (!mariadb) throw new Error("MariaDB service not found");
								await restoreMariadbBackup(
									mariadb,
									destination,
									{
										databaseId: mariadb.mariadbId,
										databaseType: "mariadb",
										backupType: "database",
										databaseName: backup.database,
										backupFile,
										destinationId,
										metadata: backup.metadata ?? undefined,
									},
									(log) =>
										console.log(`FullRestore[mariadb:${mariadb.appName}] ${log}`),
								);
							} else if (backup.databaseType === "mongo") {
								const mongo =
									backup.mongo ?? (await findMongoByBackupId(backup.backupId));
								if (!mongo) throw new Error("MongoDB service not found");
								await restoreMongoBackup(
									mongo,
									destination,
									{
										databaseId: mongo.mongoId,
										databaseType: "mongo",
										backupType: "database",
										databaseName: backup.database,
										backupFile,
										destinationId,
										metadata: backup.metadata ?? undefined,
									},
									(log) =>
										console.log(`FullRestore[mongo:${mongo.appName}] ${log}`),
								);
							}
						} catch (error) {
							console.error(`FullRestore: error restoring backup ${backupId}`, error);
						}
					}

					for (const volumeBackupId of plannedVolumeBackupIds) {
						try {
							const volumeBackup = await db.query.volumeBackups.findFirst({
								where: eq(volumeBackups.volumeBackupId, volumeBackupId),
								with: { application: true, compose: true },
							});
							if (!volumeBackup) continue;

							if (
								volumeBackup.serviceType !== "application" &&
								volumeBackup.serviceType !== "compose"
							) {
								continue;
							}

							const serverId =
								volumeBackup.application?.serverId || volumeBackup.compose?.serverId;

							const backupFileName = await getLatestBackupObjectKey(
								volumeBackup.prefix,
								`${allMountsVolumeName}-*.tar`,
							);
							if (!backupFileName) {
								console.error(
									`FullRestore: no volume backup files found for ${volumeBackup.volumeBackupId}`,
								);
								continue;
							}

							const targetId =
								volumeBackup.serviceType === "application"
									? volumeBackup.applicationId
									: volumeBackup.composeId;

							if (!targetId) continue;

							const restoreCommand = await restoreVolume(
								targetId,
								destinationId,
								"ALL",
								backupFileName,
								serverId || "",
								volumeBackup.serviceType,
							);

							if (serverId) {
								await execAsyncRemote(serverId, restoreCommand);
							} else {
								await execAsync(restoreCommand);
							}
						} catch (error) {
							console.error(
								`FullRestore: error restoring volume backup ${volumeBackupId}`,
								error,
							);
						}
					}
				} catch (error) {
					console.error("FullRestore: Critical error in background job", error);
				}
			})();
		});

		return { started: true };
	}),
	manualBackupPostgres: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input }) => {
			try {
				const backup = await findBackupById(input.backupId);
				const postgres = await findPostgresByBackupId(backup.backupId);
				await runPostgresBackup(postgres, backup);

				await keepLatestNBackups(backup, postgres?.serverId);
				return true;
			} catch (error) {
				const message =
					error instanceof Error
						? error.message
						: "Error running manual Postgres backup ";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),

	manualBackupMySql: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input }) => {
			try {
				const backup = await findBackupById(input.backupId);
				const mysql = await findMySqlByBackupId(backup.backupId);
				await runMySqlBackup(mysql, backup);
				await keepLatestNBackups(backup, mysql?.serverId);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual MySQL backup ",
					cause: error,
				});
			}
		}),
	manualBackupMariadb: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input }) => {
			try {
				const backup = await findBackupById(input.backupId);
				const mariadb = await findMariadbByBackupId(backup.backupId);
				await runMariadbBackup(mariadb, backup);
				await keepLatestNBackups(backup, mariadb?.serverId);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Mariadb backup ",
					cause: error,
				});
			}
		}),
	manualBackupCompose: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input }) => {
			try {
				const backup = await findBackupById(input.backupId);
				const compose = await findComposeByBackupId(backup.backupId);
				await runComposeBackup(compose, backup);
				await keepLatestNBackups(backup, compose?.serverId);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Compose backup ",
					cause: error,
				});
			}
		}),
	manualBackupMongo: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input }) => {
			try {
				const backup = await findBackupById(input.backupId);
				const mongo = await findMongoByBackupId(backup.backupId);
				await runMongoBackup(mongo, backup);
				await keepLatestNBackups(backup, mongo?.serverId);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Mongo backup ",
					cause: error,
				});
			}
		}),
	manualBackupWebServer: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input }) => {
			const backup = await findBackupById(input.backupId);
			await runWebServerBackup(backup);
			return true;
		}),
	listBackupFiles: protectedProcedure
		.input(
			z.object({
				destinationId: z.string(),
				search: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				const rcloneFlags = getS3Credentials(destination);
				const bucketPath = `:s3:${destination.bucket}`;

				const lastSlashIndex = input.search.lastIndexOf("/");
				const baseDir =
					lastSlashIndex !== -1
						? normalizeS3Path(input.search.slice(0, lastSlashIndex + 1))
						: "";
				const searchTerm =
					lastSlashIndex !== -1
						? input.search.slice(lastSlashIndex + 1)
						: input.search;

				const searchPath = baseDir ? `${bucketPath}/${baseDir}` : bucketPath;
				const listCommand = `rclone lsjson ${rcloneFlags.join(" ")} "${searchPath}" --no-mimetype --no-modtime 2>/dev/null`;

				let stdout = "";

				if (input.serverId) {
					const result = await execAsyncRemote(input.serverId, listCommand);
					stdout = result.stdout;
				} else {
					const result = await execAsync(listCommand);
					stdout = result.stdout;
				}

				let files: RcloneFile[] = [];
				try {
					files = JSON.parse(stdout) as RcloneFile[];
				} catch (error) {
					console.error("Error parsing JSON response:", error);
					console.error("Raw stdout:", stdout);
					throw new Error("Failed to parse backup files list");
				}

				// Limit to first 100 files

				const results = baseDir
					? files.map((file) => ({
							...file,
							Path: `${baseDir}${file.Path}`,
						}))
					: files;

				if (searchTerm) {
					return results
						.filter((file) =>
							file.Path.toLowerCase().includes(searchTerm.toLowerCase()),
						)
						.slice(0, 100);
				}

				return results.slice(0, 100);
			} catch (error) {
				console.error("Error in listBackupFiles:", error);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error listing backup files",
					cause: error,
				});
			}
		}),
	migrateExternalDatabase: protectedProcedure
		.input(
			z.object({
				databaseType: z.enum(["postgres", "mysql", "mariadb", "mongo", "redis"]),
				databaseId: z.string().min(1),
				sourceUrl: z.string().min(1),
				mode: z.enum(["overwrite", "import"]).optional().default("overwrite"),
				sourceDatabase: z
					.string()
					.optional()
					.describe("Optional: DB name override when not present in URL"),
				targetDatabase: z
					.string()
					.optional()
					.describe("Optional: target DB name override (mongo)"),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const mode = input.mode ?? "overwrite";

			const run = async (command: string, serverId?: string | null) => {
				if (serverId) {
					await execAsyncRemote(serverId, command);
				} else {
					await execAsync(command, { shell: "/bin/bash" });
				}
			};

			if (ctx.user.role === "member") {
				await checkServiceAccess(
					ctx.user.id,
					input.databaseId,
					ctx.session.activeOrganizationId,
					"access",
				);
			}

			switch (input.databaseType) {
				case "postgres": {
					const postgres = await findPostgresById(input.databaseId);
					if (
						postgres.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this Postgres",
						});
					}
					const command = buildPostgresExternalMigrationCommand({
						appName: postgres.appName,
						targetDatabase:
							input.targetDatabase?.trim() || postgres.databaseName,
						targetUser: postgres.databaseUser,
						targetPassword: postgres.databasePassword,
						sourceUrl: input.sourceUrl,
						mode,
					});
					await run(command, postgres.serverId);
					return true;
				}
				case "mysql": {
					const mysql = await findMySqlById(input.databaseId);
					if (
						mysql.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this MySQL",
						});
					}
					const command = buildMysqlExternalMigrationCommand({
						appName: mysql.appName,
						targetDatabase: input.targetDatabase?.trim() || mysql.databaseName,
						targetRootPassword: mysql.databaseRootPassword,
						sourceUrl: input.sourceUrl,
						sourceDatabase: input.sourceDatabase,
						mode,
					});
					await run(command, mysql.serverId);
					return true;
				}
				case "mariadb": {
					const mariadb = await findMariadbById(input.databaseId);
					if (
						mariadb.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this MariaDB",
						});
					}
					const command = buildMariadbExternalMigrationCommand({
						appName: mariadb.appName,
						targetDatabase:
							input.targetDatabase?.trim() || mariadb.databaseName,
						targetUser: mariadb.databaseUser,
						targetPassword: mariadb.databasePassword,
						sourceUrl: input.sourceUrl,
						sourceDatabase: input.sourceDatabase,
						mode,
					});
					await run(command, mariadb.serverId);
					return true;
				}
				case "mongo": {
					const mongo = await findMongoById(input.databaseId);
					if (
						mongo.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this MongoDB",
						});
					}
					const command = buildMongoExternalMigrationCommand({
						appName: mongo.appName,
						targetUser: mongo.databaseUser,
						targetPassword: mongo.databasePassword,
						sourceUrl: input.sourceUrl,
						sourceDatabase: input.sourceDatabase,
						targetDatabase: input.targetDatabase,
						mode,
					});
					await run(command, mongo.serverId);
					return true;
				}
				case "redis": {
					const redis = await findRedisById(input.databaseId);
					if (
						redis.environment.project.organizationId !==
						ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this Redis",
						});
					}
					const command = buildRedisExternalMigrationCommand({
						appName: redis.appName,
						dockerImage: redis.dockerImage,
						replicas: redis.replicas,
						mounts: redis.mounts,
						sourceUrl: input.sourceUrl,
						mode,
					});
					await run(command, redis.serverId);
					return true;
				}
			}
		}),

	restoreBackupWithLogs: protectedProcedure
		.meta({
			openapi: {
				enabled: false,
				path: "/restore-backup-with-logs",
				method: "POST",
				override: true,
			},
		})
		.input(apiRestoreBackup)
		.subscription(async ({ input }) => {
			const destination = await findDestinationById(input.destinationId);
			if (input.backupType === "database") {
				if (input.databaseType === "postgres") {
					const postgres = await findPostgresById(input.databaseId);

					return observable<string>((emit) => {
						let cancelled = false;
						const safeNext = (log: string) => {
							if (!cancelled) emit.next(log);
						};
						void restorePostgresBackup(postgres, destination, input, safeNext)
							.then(() => {
								if (!cancelled) emit.complete();
							})
							.catch((error) => {
								if (!cancelled) emit.error(error);
							});
						return () => {
							cancelled = true;
						};
					});
				}
				if (input.databaseType === "mysql") {
					const mysql = await findMySqlById(input.databaseId);
					return observable<string>((emit) => {
						let cancelled = false;
						const safeNext = (log: string) => {
							if (!cancelled) emit.next(log);
						};
						void restoreMySqlBackup(mysql, destination, input, safeNext)
							.then(() => {
								if (!cancelled) emit.complete();
							})
							.catch((error) => {
								if (!cancelled) emit.error(error);
							});
						return () => {
							cancelled = true;
						};
					});
				}
				if (input.databaseType === "mariadb") {
					const mariadb = await findMariadbById(input.databaseId);
					return observable<string>((emit) => {
						let cancelled = false;
						const safeNext = (log: string) => {
							if (!cancelled) emit.next(log);
						};
						void restoreMariadbBackup(mariadb, destination, input, safeNext)
							.then(() => {
								if (!cancelled) emit.complete();
							})
							.catch((error) => {
								if (!cancelled) emit.error(error);
							});
						return () => {
							cancelled = true;
						};
					});
				}
				if (input.databaseType === "mongo") {
					const mongo = await findMongoById(input.databaseId);
					return observable<string>((emit) => {
						let cancelled = false;
						const safeNext = (log: string) => {
							if (!cancelled) emit.next(log);
						};
						void restoreMongoBackup(mongo, destination, input, safeNext)
							.then(() => {
								if (!cancelled) emit.complete();
							})
							.catch((error) => {
								if (!cancelled) emit.error(error);
							});
						return () => {
							cancelled = true;
						};
					});
				}
				if (input.databaseType === "web-server") {
					return observable<string>((emit) => {
						let cancelled = false;
						const safeNext = (log: string) => {
							if (!cancelled) emit.next(log);
						};
						void restoreWebServerBackup(destination, input.backupFile, safeNext)
							.then(() => {
								if (!cancelled) emit.complete();
							})
							.catch((error) => {
								if (!cancelled) emit.error(error);
							});
						return () => {
							cancelled = true;
						};
					});
				}
			}
			if (input.backupType === "compose") {
				const compose = await findComposeById(input.databaseId);
				return observable<string>((emit) => {
					let cancelled = false;
					const safeNext = (log: string) => {
						if (!cancelled) emit.next(log);
					};
					void restoreComposeBackup(compose, destination, input, safeNext)
						.then(() => {
							if (!cancelled) emit.complete();
						})
						.catch((error) => {
							if (!cancelled) emit.error(error);
						});
					return () => {
						cancelled = true;
					};
				});
			}

			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Unsupported restore backup input",
			});
		}),
});
