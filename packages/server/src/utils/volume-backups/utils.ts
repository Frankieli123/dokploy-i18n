import path from "node:path";
import { paths } from "@dokploy/server/constants";
import {
	createDeploymentVolumeBackup,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findVolumeBackupById } from "@dokploy/server/services/volume-backups";
import {
	execAsync,
	execAsyncRemote,
	ExecError,
} from "@dokploy/server/utils/process/execAsync";
import { sendVolumeBackupNotifications } from "@dokploy/server/utils/notifications/volume-backup";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { buildS3RemotePath, getS3Credentials } from "../backups/utils";
import { backupVolume, getVolumeServiceAppName } from "./backup";
import {
	ALL_MOUNTS_VOLUME_NAME,
	getBackupBaseName,
	normalizeAllMountsVolumeName,
} from "./naming";

export const scheduleVolumeBackup = async (volumeBackupId: string) => {
	const volumeBackup = await findVolumeBackupById(volumeBackupId);
	scheduleJob(volumeBackupId, volumeBackup.cronExpression, async () => {
		await runVolumeBackup(volumeBackupId);
	});
};

export const removeVolumeBackupJob = async (volumeBackupId: string) => {
	const currentJob = scheduledJobs[volumeBackupId];
	currentJob?.cancel();
};

const cleanupOldVolumeBackups = async (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
	serverId?: string | null,
) => {
	const { keepLatestCount, destination, prefix, volumeName } = volumeBackup;

	if (!keepLatestCount) return;

	try {
		const rcloneFlags = getS3Credentials(destination);
		const runCommand = async (command: string) => {
			if (serverId) {
				return await execAsyncRemote(serverId, command);
			}

			return await execAsync(command);
		};

		const s3AppName = getVolumeServiceAppName(volumeBackup);
		const normalizedVolumeName = normalizeAllMountsVolumeName(volumeName);
		const backupBaseName = getBackupBaseName(normalizedVolumeName);
		const includePatterns = Array.from(
			new Set(
				normalizedVolumeName === ALL_MOUNTS_VOLUME_NAME
					? [`${backupBaseName}-*.tar`, `${ALL_MOUNTS_VOLUME_NAME}-*.tar`]
					: [`${backupBaseName}-*.tar`],
			),
		);
		const pathCandidates = Array.from(
			new Set([
				buildS3RemotePath(destination.bucket, s3AppName, prefix || ""),
				buildS3RemotePath(destination.bucket, prefix || ""),
			]),
		);

		const backupFiles = (
			await Promise.all(
				pathCandidates.map(async (backupFilesPath) => {
					const files = (
						await Promise.all(
							includePatterns.map(async (pattern) => {
								const listCommand = `rclone lsf ${rcloneFlags.join(" ")} --files-only --include "${pattern}" "${backupFilesPath}" 2>/dev/null`;
								const result = await runCommand(listCommand).catch(() => ({
									stdout: "",
									stderr: "",
								}));
								return result.stdout
									.split("\n")
									.map((line) => line.trim())
									.filter(Boolean);
							}),
						)
					).flat();

					return Array.from(new Set(files)).map((fileName) => ({
						fileName,
						fullPath: `${backupFilesPath}/${fileName}`,
					}));
				}),
			)
		)
			.flat()
			.sort((left, right) => right.fileName.localeCompare(left.fileName));

		for (const file of backupFiles.slice(keepLatestCount)) {
			const deleteCommand = `rclone deletefile ${rcloneFlags.join(" ")} "${file.fullPath}"`;
			await runCommand(deleteCommand);
		}
	} catch (error) {
		console.error("Volume backup retention error", error);
	}
};

const shEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const getVolumeBackupNotificationContext = (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
) => {
	if (volumeBackup.application) {
		return {
			projectName: volumeBackup.application.environment.project.name,
			applicationName: volumeBackup.application.name,
			organizationId:
				volumeBackup.application.environment.project.organizationId,
			serviceType: volumeBackup.serviceType,
			volumeName: volumeBackup.volumeName,
		};
	}
	if (volumeBackup.compose) {
		return {
			projectName: volumeBackup.compose.environment.project.name,
			applicationName: volumeBackup.compose.name,
			organizationId: volumeBackup.compose.environment.project.organizationId,
			serviceType: volumeBackup.serviceType,
			volumeName: volumeBackup.volumeName,
		};
	}
	if (volumeBackup.postgres) {
		return {
			projectName: volumeBackup.postgres.environment.project.name,
			applicationName: volumeBackup.postgres.name,
			organizationId: volumeBackup.postgres.environment.project.organizationId,
			serviceType: volumeBackup.serviceType,
			volumeName: volumeBackup.volumeName,
		};
	}
	if (volumeBackup.mariadb) {
		return {
			projectName: volumeBackup.mariadb.environment.project.name,
			applicationName: volumeBackup.mariadb.name,
			organizationId: volumeBackup.mariadb.environment.project.organizationId,
			serviceType: volumeBackup.serviceType,
			volumeName: volumeBackup.volumeName,
		};
	}
	if (volumeBackup.mongo) {
		return {
			projectName: volumeBackup.mongo.environment.project.name,
			applicationName: volumeBackup.mongo.name,
			organizationId: volumeBackup.mongo.environment.project.organizationId,
			serviceType: volumeBackup.serviceType,
			volumeName: volumeBackup.volumeName,
		};
	}
	if (volumeBackup.mysql) {
		return {
			projectName: volumeBackup.mysql.environment.project.name,
			applicationName: volumeBackup.mysql.name,
			organizationId: volumeBackup.mysql.environment.project.organizationId,
			serviceType: volumeBackup.serviceType,
			volumeName: volumeBackup.volumeName,
		};
	}
	if (volumeBackup.redis) {
		return {
			projectName: volumeBackup.redis.environment.project.name,
			applicationName: volumeBackup.redis.name,
			organizationId: volumeBackup.redis.environment.project.organizationId,
			serviceType: volumeBackup.serviceType,
			volumeName: volumeBackup.volumeName,
		};
	}
	return null;
};

export const runVolumeBackup = async (volumeBackupId: string) => {
	const volumeBackup = await findVolumeBackupById(volumeBackupId);
	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
	const notificationContext = getVolumeBackupNotificationContext(volumeBackup);
	const deployment = await createDeploymentVolumeBackup({
		volumeBackupId: volumeBackup.volumeBackupId,
		title: "Volume Backup",
		description: "Volume Backup",
	});

	try {
		const command = await backupVolume(volumeBackup);

		const commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (serverId) {
			await execAsyncRemote(serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		if (volumeBackup.keepLatestCount && volumeBackup.keepLatestCount > 0) {
			await cleanupOldVolumeBackups(volumeBackup, serverId);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		if (notificationContext) {
			try {
				await sendVolumeBackupNotifications({
					...notificationContext,
					type: "success",
				});
			} catch (notificationError) {
				console.error(
					"Failed to send volume backup success notification",
					notificationError,
				);
			}
		}
	} catch (error) {
		const details =
			error instanceof ExecError
				? error.getDetailedMessage()
				: error instanceof Error
					? error.message
					: String(error);
		try {

			const command = `printf '%s' ${shEscape(`\n\n❌ Volume backup failed\n${details}\n`)} >> ${shEscape(deployment.logPath)}`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		} catch (appendError) {
			console.error("Failed to append volume backup error logs", appendError);
		}

		const { VOLUME_BACKUPS_PATH } = paths(!!serverId);
		const volumeBackupPath = path.join(
			VOLUME_BACKUPS_PATH,
			volumeBackup.appName,
		);
		// delete all the .tar files
		try {
			const command = `rm -rf ${volumeBackupPath}/*.tar`;
			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		} catch (cleanupError) {
			console.error("Failed to cleanup volume backup tar files", cleanupError);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		if (notificationContext) {
			try {
				await sendVolumeBackupNotifications({
					...notificationContext,
					type: "error",
					errorMessage: details,
				});
			} catch (notificationError) {
				console.error(
					"Failed to send volume backup error notification",
					notificationError,
				);
			}
		}

		console.error(error);
	}
};
