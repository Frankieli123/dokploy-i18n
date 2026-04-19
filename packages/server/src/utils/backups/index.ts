import { CLEANUP_CRON_JOB } from "@dokploy/server/constants";
import { member } from "@dokploy/server/db/schema";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import { getAllServers } from "@dokploy/server/services/server";
import { eq } from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { db } from "../../db/index";
import { startLogCleanup } from "../access-log/handler";
import {
	cleanUpDockerBuilder,
	cleanUpSystemPrune,
	cleanUpUnusedImages,
} from "../docker/utils";
import { sendDockerCleanupNotifications } from "../notifications/docker-cleanup";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import {
	buildS3RemotePath,
	getBackupServiceAppName,
	getS3Credentials,
	joinS3Path,
	normalizeS3Path,
	scheduleBackup,
} from "./utils";

export const initCronJobs = async () => {
	console.log("Setting up cron jobs....");

	const admin = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
		with: {
			user: true,
		},
	});

	if (!admin) {
		return;
	}

	if (admin.user.enableDockerCleanup) {
		scheduleJob("docker-cleanup", CLEANUP_CRON_JOB, async () => {
			console.log(
				`Docker Cleanup ${new Date().toLocaleString()}]  Running docker cleanup`,
			);
			await cleanUpUnusedImages();
			await cleanUpDockerBuilder();
			await cleanUpSystemPrune();
			await sendDockerCleanupNotifications(admin.user.id);
		});
	}

	const servers = await getAllServers();

	for (const server of servers) {
		const { serverId, enableDockerCleanup, name } = server;
		if (enableDockerCleanup) {
			scheduleJob(serverId, CLEANUP_CRON_JOB, async () => {
				console.log(
					`SERVER-BACKUP[${new Date().toLocaleString()}] Running Cleanup ${name}`,
				);
				await cleanUpUnusedImages(serverId);
				await cleanUpDockerBuilder(serverId);
				await cleanUpSystemPrune(serverId);
				await sendDockerCleanupNotifications(
					admin.user.id,
					`Docker cleanup for Server ${name} (${serverId})`,
				);
			});
		}
	}

	const backups = await db.query.backups.findMany({
		with: {
			destination: true,
			postgres: true,
			mariadb: true,
			mysql: true,
			mongo: true,
			user: true,
			compose: true,
		},
	});

	for (const backup of backups) {
		try {
			if (backup.enabled) {
				scheduleBackup(backup);
				console.log(
					`[Backup] ${backup.databaseType} Enabled with cron: [${backup.schedule}]`,
				);
			}
		} catch (error) {
			console.error(`[Backup] ${backup.databaseType} Error`, error);
		}
	}

	if (admin?.user.logCleanupCron) {
		console.log("Starting log requests cleanup", admin.user.logCleanupCron);
		await startLogCleanup(admin.user.logCleanupCron);
	}
};

export const keepLatestNBackups = async (
	backup: BackupSchedule,
	serverId?: string | null,
) => {
	// 0 also immediately returns which is good as the empty "keep latest" field in the UI
	// is saved as 0 in the database
	if (!backup.keepLatestCount) return;

	try {
		const rcloneFlags = getS3Credentials(backup.destination);
		const bucket = backup.destination.bucket;
		const currentAppName = getBackupServiceAppName(backup);
		const legacyPrefix = normalizeS3Path(backup.prefix);
		const currentPrefix = currentAppName
			? normalizeS3Path(joinS3Path(currentAppName, backup.prefix))
			: legacyPrefix;
		const backupExtension =
			backup.databaseType === "web-server" ? ".zip" : ".sql.gz";
		const pathCandidates = Array.from(
			new Set(
				[currentPrefix, legacyPrefix].map((prefix) =>
					buildS3RemotePath(bucket, prefix),
				),
			),
		);

		const runCommand = async (command: string) => {
			if (serverId) {
				return await execAsyncRemote(serverId, command);
			}

			return await execAsync(command);
		};

		const backupFiles = (
			await Promise.all(
				pathCandidates.map(async (backupFilesPath) => {
					const rcloneList = `rclone lsf ${rcloneFlags.join(" ")} --files-only --include "*${backupExtension}" "${backupFilesPath}" 2>/dev/null`;
					const result = await runCommand(rcloneList).catch(() => ({
						stdout: "",
						stderr: "",
					}));
					const items = result.stdout
						.split("\n")
						.map((line) => line.trim())
						.filter(Boolean);

					return items.map((fileName) => ({
						fileName,
						fullPath: `${backupFilesPath}/${fileName}`,
					}));
				}),
			)
		)
			.flat()
			.sort((left, right) => right.fileName.localeCompare(left.fileName));

		const filesToDelete = backupFiles.slice(backup.keepLatestCount);

		for (const file of filesToDelete) {
			const deleteCommand = `rclone deletefile ${rcloneFlags.join(" ")} "${file.fullPath}"`;
			await runCommand(deleteCommand);
		}
	} catch (error) {
		console.error(error);
	}
};
