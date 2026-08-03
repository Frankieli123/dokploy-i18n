import {
	buildMariadbExternalMigrationCommand,
	buildMongoExternalMigrationCommand,
	buildMysqlExternalMigrationCommand,
	buildPostgresExternalMigrationCommand,
	buildRedisExternalMigrationCommand,
	checkServiceAccess,
	createBackup,
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
	removeBackupById,
	removeScheduleBackup,
	runMariadbBackup,
	runMongoBackup,
	runMySqlBackup,
	runPostgresBackup,
	runWebServerBackup,
	scheduleBackup,
	updateBackupById,
} from "@dokploy/server";
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
import { quote } from "shell-quote";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import {
	apiCreateBackup,
	apiFindOneBackup,
	apiRemoveBackup,
	apiRestoreBackup,
	apiUpdateBackup,
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

interface RcloneSizeResult {
	bytes?: number;
}

const runRcloneCommand = async (command: string, serverId?: string) => {
	if (serverId) {
		const result = await execAsyncRemote(serverId, command);
		return result.stdout;
	}

	const result = await execAsync(command);
	return result.stdout;
};

const getDirectorySize = async (
	bucketPath: string,
	filePath: string,
	rcloneFlags: string[],
	serverId?: string,
) => {
	const sizeCommand = `rclone size ${rcloneFlags.join(" ")} ${quote([`${bucketPath}/${normalizeS3Path(filePath)}`])} --json 2>/dev/null`;

	try {
		const stdout = await runRcloneCommand(sizeCommand, serverId);
		if (!stdout.trim()) return 0;

		const sizeResult = JSON.parse(stdout) as RcloneSizeResult;
		return sizeResult.bytes ?? 0;
	} catch (error) {
		console.error(`Error getting directory size for ${filePath}:`, error);
		return 0;
	}
};

const enrichDirectorySizes = async (
	files: RcloneFile[],
	bucketPath: string,
	rcloneFlags: string[],
	serverId?: string,
) => {
	const nextFiles = [...files];
	const directoryIndexes = nextFiles.reduce<number[]>((acc, file, index) => {
		if (file.IsDir) {
			acc.push(index);
		}
		return acc;
	}, []);

	if (directoryIndexes.length === 0) return nextFiles;

	const chunkSize = 5;
	for (let index = 0; index < directoryIndexes.length; index += chunkSize) {
		const chunk = directoryIndexes.slice(index, index + chunkSize);
		const sizes = await Promise.all(
			chunk.map((fileIndex) =>
				getDirectorySize(
					bucketPath,
					nextFiles[fileIndex]?.Path || "",
					rcloneFlags,
					serverId,
				),
			),
		);

		chunk.forEach((fileIndex, sizeIndex) => {
			const file = nextFiles[fileIndex];
			if (!file) return;

			nextFiles[fileIndex] = {
				...file,
				Size: sizes[sizeIndex] ?? file.Size,
			};
		});
	}

	return nextFiles;
};

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
				const listCommand = `rclone lsjson ${rcloneFlags.join(" ")} ${quote([searchPath])} --no-mimetype --no-modtime 2>/dev/null`;
				const stdout = await runRcloneCommand(
					listCommand,
					input.serverId || undefined,
				);

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
				const filteredResults = searchTerm
					? results
							.filter((file) =>
								file.Path.toLowerCase().includes(searchTerm.toLowerCase()),
							)
							.slice(0, 100)
					: results.slice(0, 100);

				return await enrichDirectorySizes(
					filteredResults,
					bucketPath,
					rcloneFlags,
					input.serverId || undefined,
				);
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
				databaseType: z.enum([
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
				]),
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
