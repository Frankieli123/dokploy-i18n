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
import { scheduledJobs, scheduleJob } from "node-schedule";
import { getS3Credentials, normalizeS3Path } from "../backups/utils";
import { backupVolume } from "./backup";
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
		const normalizedPrefix = normalizeS3Path(prefix);
		const backupFilesPath = `:s3:${destination.bucket}/${normalizedPrefix}`;
		const normalizedVolumeName = normalizeAllMountsVolumeName(volumeName);
		const backupBaseName = getBackupBaseName(normalizedVolumeName);
		const includePatterns =
			normalizedVolumeName === ALL_MOUNTS_VOLUME_NAME
				? `--include "${backupBaseName}-*.tar" --include "${ALL_MOUNTS_VOLUME_NAME}-*.tar"`
				: `--include "${backupBaseName}-*.tar"`;
		const listCommand = `rclone lsf ${rcloneFlags.join(" ")} ${includePatterns} :s3:${destination.bucket}/${normalizedPrefix}`;
		const sortAndPick = `sort -r | tail -n +$((${keepLatestCount}+1)) | xargs -I{}`;
		const deleteCommand = `rclone delete ${rcloneFlags.join(" ")} ${backupFilesPath}{}`;
		const fullCommand = `${listCommand} | ${sortAndPick} ${deleteCommand}`;

		if (serverId) {
			await execAsyncRemote(serverId, fullCommand);
		} else {
			await execAsync(fullCommand);
		}
	} catch (error) {
		console.error("Volume backup retention error", error);
	}
};

const shEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export const runVolumeBackup = async (volumeBackupId: string) => {
	const volumeBackup = await findVolumeBackupById(volumeBackupId);
	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
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
	} catch (error) {
		try {
			const details =
				error instanceof ExecError
					? error.getDetailedMessage()
					: error instanceof Error
						? error.message
						: String(error);

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

		console.error(error);
	}
};
