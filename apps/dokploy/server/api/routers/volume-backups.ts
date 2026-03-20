import path from "node:path";
import {
	checkServiceAccess,
	createVolumeBackup,
	findApplicationById,
	findComposeById,
	findDestinationById,
	findVolumeBackupById,
	IS_CLOUD,
	paths,
	removeVolumeBackup,
	removeVolumeBackupJob,
	restoreVolume,
	runVolumeBackup,
	scheduleVolumeBackup,
	updateVolumeBackup,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	createVolumeBackupSchema,
	updateVolumeBackupSchema,
	volumeBackups,
} from "@dokploy/server/db/schema";
import {
	execAsyncRemote,
	execAsyncStream,
} from "@dokploy/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { removeJob, schedule, updateJob } from "@/server/utils/backup";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const getFileMountDisplayValue = (
	volumeName: string,
	mounts: Array<{ type: string; filePath?: string | null }>,
	baseFilesPath: string,
) => {
	const normalizedVolumeName = path.normalize(volumeName);
	const matchedFileMount = mounts.find((mount) => {
		if (mount.type !== "file" || !mount.filePath) return false;

		const expectedSourcePath = path.normalize(
			path.join(baseFilesPath, mount.filePath),
		);

		return expectedSourcePath === normalizedVolumeName;
	});

	return matchedFileMount?.filePath || volumeName;
};

export const volumeBackupsRouter = createTRPCRouter({
	list: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				volumeBackupType: z.enum([
					"application",
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"compose",
				]),
			}),
		)
		.query(async ({ input, ctx }) => {
			const backups = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups[`${input.volumeBackupType}Id`], input.id),
				with: {
					application: true,
					postgres: true,
					mysql: true,
					mariadb: true,
					mongo: true,
					redis: true,
					compose: true,
				},
				orderBy: [desc(volumeBackups.createdAt)],
			});

			if (input.volumeBackupType === "application") {
				if (ctx.user.role === "member") {
					await checkServiceAccess(
						ctx.user.id,
						input.id,
						ctx.session.activeOrganizationId,
						"access",
					);
				}

				const application = await findApplicationById(input.id);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access these volume backups",
					});
				}

				const { APPLICATIONS_PATH } = paths(!!application.serverId);
				const baseFilesPath = path.join(
					path.resolve(APPLICATIONS_PATH),
					application.appName,
					"files",
				);

				return backups.map((backup) => ({
					...backup,
					DisplayVolumeName: getFileMountDisplayValue(
						backup.volumeName,
						application.mounts,
						baseFilesPath,
					),
					SubmitVolumeName: backup.volumeName,
				}));
			}

			if (input.volumeBackupType === "compose") {
				if (ctx.user.role === "member") {
					await checkServiceAccess(
						ctx.user.id,
						input.id,
						ctx.session.activeOrganizationId,
						"access",
					);
				}

				const compose = await findComposeById(input.id);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access these volume backups",
					});
				}

				const { COMPOSE_PATH } = paths(!!compose.serverId);
				const baseFilesPath = path.join(
					path.resolve(COMPOSE_PATH),
					compose.appName,
					"files",
				);

				return backups.map((backup) => ({
					...backup,
					DisplayVolumeName: getFileMountDisplayValue(
						backup.volumeName,
						compose.mounts,
						baseFilesPath,
					),
					SubmitVolumeName: backup.volumeName,
				}));
			}

			return backups.map((backup) => ({
				...backup,
				DisplayVolumeName: backup.volumeName,
				SubmitVolumeName: backup.volumeName,
			}));
		}),
	create: protectedProcedure
		.input(createVolumeBackupSchema)
		.mutation(async ({ input }) => {
			const newVolumeBackup = await createVolumeBackup(input);

			if (newVolumeBackup?.enabled) {
				if (IS_CLOUD) {
					await schedule({
						cronSchedule: newVolumeBackup.cronExpression,
						volumeBackupId: newVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await scheduleVolumeBackup(newVolumeBackup.volumeBackupId);
				}
			}
			return newVolumeBackup;
		}),
	one: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.query(async ({ input }) => {
			return await findVolumeBackupById(input.volumeBackupId);
		}),
	delete: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.mutation(async ({ input }) => {
			return await removeVolumeBackup(input.volumeBackupId);
		}),
	update: protectedProcedure
		.input(updateVolumeBackupSchema)
		.mutation(async ({ input }) => {
			const updatedVolumeBackup = await updateVolumeBackup(
				input.volumeBackupId,
				input,
			);

			if (!updatedVolumeBackup) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Volume backup not found",
				});
			}

			if (IS_CLOUD) {
				if (updatedVolumeBackup.enabled) {
					await updateJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await removeJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				}
			} else {
				if (updatedVolumeBackup?.enabled) {
					removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
					scheduleVolumeBackup(updatedVolumeBackup.volumeBackupId);
				} else {
					removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
				}
			}
			return updatedVolumeBackup;
		}),

	runManually: protectedProcedure
		.input(z.object({ volumeBackupId: z.string().min(1) }))
		.mutation(async ({ input }) => {
			try {
				return await runVolumeBackup(input.volumeBackupId);
			} catch (error) {
				console.error(error);
				return false;
			}
		}),
	restoreVolumeBackupWithLogs: protectedProcedure
		.meta({
			openapi: {
				enabled: false,
				path: "/restore-volume-backup-with-logs",
				method: "POST",
				override: true,
			},
		})
		.input(
			z.object({
				backupFileName: z.string().min(1),
				destinationId: z.string().min(1),
				volumeName: z.string().min(1),
				id: z.string().min(1),
				serviceType: z.enum(["application", "compose"]),
				serverId: z.string().optional(),
			}),
		)
		.subscription(async ({ input, ctx }) => {
			if (ctx.user.role === "member") {
				await checkServiceAccess(
					ctx.user.id,
					input.id,
					ctx.session.activeOrganizationId,
					"access",
				);
			}

			if (input.serviceType === "application") {
				const application = await findApplicationById(input.id);
				if (
					application.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to restore this application",
					});
				}
			}

			if (input.serviceType === "compose") {
				const compose = await findComposeById(input.id);
				if (
					compose.environment.project.organizationId !==
					ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to restore this compose service",
					});
				}
			}

			const destination = await findDestinationById(input.destinationId);
			if (destination.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this destination",
				});
			}

			return observable<string>((emit) => {
				const runRestore = async () => {
					try {
						emit.next("🚀 Starting volume restore process...");
						emit.next(`📂 Backup File: ${input.backupFileName}`);
						emit.next(`🔧 Volume Name: ${input.volumeName}`);
						emit.next(`🏷️ Service Type: ${input.serviceType}`);
						emit.next(""); // Empty line for better readability

						// Generate the restore command
						const restoreCommand = await restoreVolume(
							input.id,
							input.destinationId,
							input.volumeName,
							input.backupFileName,
							input.serverId || "",
							input.serviceType,
						);

						emit.next("📋 Generated restore command:");
						emit.next("▶️ Executing restore...");
						emit.next(""); // Empty line

						// Execute the restore command with real-time output
						if (input.serverId) {
							emit.next(`🌐 Executing on remote server: ${input.serverId}`);
							await execAsyncRemote(input.serverId, restoreCommand, (data) => {
								emit.next(data);
							});
						} else {
							emit.next("🖥️ Executing on local server");
							await execAsyncStream(restoreCommand, (data) => {
								emit.next(data);
							});
						}

						emit.next("");
						emit.next("✅ Volume restore completed successfully!");
						emit.next(
							"🎉 All containers/services have been restarted with the restored volume.",
						);
					} catch {
						emit.next("");
						emit.next("❌ Volume restore failed!");
					} finally {
						emit.complete();
					}
				};

				// Start the restore process
				runRestore();
			});
		}),
});
