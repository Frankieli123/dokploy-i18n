import { logger } from "@dokploy/server/lib/logger";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import type { Destination } from "@dokploy/server/services/destination";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { quote } from "shell-quote";
import { keepLatestNBackups } from ".";
import { runComposeBackup } from "./compose";
import { runMariadbBackup } from "./mariadb";
import { runMongoBackup } from "./mongo";
import { runMySqlBackup } from "./mysql";
import { runPostgresBackup } from "./postgres";
import { runWebServerBackup } from "./web-server";

export const scheduleBackup = (backup: BackupSchedule) => {
	const {
		schedule,
		backupId,
		databaseType,
		postgres,
		mysql,
		mongo,
		mariadb,
		compose,
	} = backup;
	scheduleJob(backupId, schedule, async () => {
		if (backup.backupType === "database") {
			if (databaseType === "postgres" && postgres) {
				await runPostgresBackup(postgres, backup);
				await keepLatestNBackups(backup, postgres.serverId);
			} else if (databaseType === "mysql" && mysql) {
				await runMySqlBackup(mysql, backup);
				await keepLatestNBackups(backup, mysql.serverId);
			} else if (databaseType === "mongo" && mongo) {
				await runMongoBackup(mongo, backup);
				await keepLatestNBackups(backup, mongo.serverId);
			} else if (databaseType === "mariadb" && mariadb) {
				await runMariadbBackup(mariadb, backup);
				await keepLatestNBackups(backup, mariadb.serverId);
			} else if (databaseType === "web-server") {
				await runWebServerBackup(backup);
				await keepLatestNBackups(backup);
			}
		} else if (backup.backupType === "compose" && compose) {
			await runComposeBackup(compose, backup);
			await keepLatestNBackups(backup, compose.serverId);
		}
	});
};

export const removeScheduleBackup = (backupId: string) => {
	const currentJob = scheduledJobs[backupId];
	currentJob?.cancel();
};

export const normalizeS3Path = (prefix: string) => {
	// Trim whitespace and remove leading/trailing slashes
	const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
	// Return empty string if prefix is empty, otherwise append trailing slash
	return normalizedPrefix ? `${normalizedPrefix}/` : "";
};

const normalizeS3Segment = (value?: string | null) => {
	const normalizedValue = (value || "").trim().replace(/\\/g, "/");
	return normalizedValue.replace(/^\/+|\/+$/g, "");
};

export const joinS3Path = (...segments: Array<string | null | undefined>) =>
	segments
		.map((segment) => normalizeS3Segment(segment))
		.filter(Boolean)
		.join("/");

export const buildS3RemotePath = (
	bucket: string,
	...segments: Array<string | null | undefined>
) => {
	const joinedPath = joinS3Path(...segments);
	return joinedPath ? `:s3:${bucket}/${joinedPath}` : `:s3:${bucket}`;
};

export const buildS3ObjectPath = (
	fileName: string,
	...segments: Array<string | null | undefined>
) => {
	const basePath = joinS3Path(...segments);
	return basePath ? `${basePath}/${fileName}` : fileName;
};

export const getBackupServiceAppName = (backup: BackupSchedule) => {
	if (backup.databaseType === "web-server") {
		return "";
	}

	if (backup.compose?.appName) {
		return backup.serviceName
			? `${backup.compose.appName}_${backup.serviceName}`
			: backup.compose.appName;
	}

	return (
		backup.postgres?.appName ||
		backup.mysql?.appName ||
		backup.mariadb?.appName ||
		backup.mongo?.appName ||
		""
	);
};

export const getS3Credentials = (destination: Destination) => {
	const { accessKey, secretAccessKey, region, endpoint, provider } =
		destination;
	const rcloneFlags = [
		`--s3-access-key-id=${quote([accessKey])}`,
		`--s3-secret-access-key=${quote([secretAccessKey])}`,
		`--s3-region=${quote([region])}`,
		`--s3-endpoint=${quote([endpoint])}`,
		"--s3-no-check-bucket",
		"--s3-force-path-style",
	];

	if (provider) {
		rcloneFlags.unshift(`--s3-provider=${quote([provider])}`);
	}

	return rcloneFlags;
};

export const getPostgresBackupCommand = (
	database: string,
	databaseUser: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -i $CONTAINER_ID bash -c 'set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U "$DB_USER" --no-password "$DB_NAME" | gzip'`;
};

export const getMariadbBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; mariadb-dump --user="$DB_USER" --password="$DB_PASS" --single-transaction --quick --databases "$DB_NAME" | gzip'`;
};

export const getMysqlBackupCommand = (
	database: string,
	databasePassword: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; mysqldump --default-character-set=utf8mb4 -u root --password="$DB_PASS" --single-transaction --no-tablespaces --quick "$DB_NAME" | gzip'`;
};

export const getMongoBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	const databaseEnv = database === "*" ? "" : ` -e DB_NAME=${quote([database])}`;
	const databaseFlag = database === "*" ? "" : ' -d "$DB_NAME"';
	return `docker exec${databaseEnv} -e DB_USER=${quote([databaseUser])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; mongodump${databaseFlag} -u "$DB_USER" -p "$DB_PASS" --archive --authenticationDatabase admin --gzip'`;
};

export const getServiceContainerCommand = (appName: string) => {
	return `docker ps -q --filter status=running --filter ${quote([`label=com.docker.swarm.service.name=${appName}`])} | head -n 1`;
};

export const getComposeContainerCommand = (
	appName: string,
	serviceName: string,
	composeType: "stack" | "docker-compose" | undefined,
) => {
	if (composeType === "stack") {
		return `docker ps -q --filter status=running --filter ${quote([`label=com.docker.stack.namespace=${appName}`])} --filter ${quote([`label=com.docker.swarm.service.name=${appName}_${serviceName}`])} | head -n 1`;
	}
	return `docker ps -q --filter status=running --filter ${quote([`label=com.docker.compose.project=${appName}`])} --filter ${quote([`label=com.docker.compose.service=${serviceName}`])} | head -n 1`;
};

const getContainerSearchCommand = (backup: BackupSchedule) => {
	const { backupType, postgres, mysql, mariadb, mongo, compose, serviceName } =
		backup;

	if (backupType === "database") {
		const appName =
			postgres?.appName || mysql?.appName || mariadb?.appName || mongo?.appName;
		return getServiceContainerCommand(appName || "");
	}
	if (backupType === "compose") {
		const { appName, composeType } = compose || {};
		return getComposeContainerCommand(
			appName || "",
			serviceName || "",
			composeType,
		);
	}
};

export const generateBackupCommand = (backup: BackupSchedule) => {
	const { backupType, databaseType } = backup;
	switch (databaseType) {
		case "postgres": {
			const postgres = backup.postgres;
			if (backupType === "database" && postgres) {
				return getPostgresBackupCommand(backup.database, postgres.databaseUser);
			}
			if (backupType === "compose" && backup.metadata?.postgres) {
				return getPostgresBackupCommand(
					backup.database,
					backup.metadata.postgres.databaseUser,
				);
			}
			break;
		}
		case "mysql": {
			const mysql = backup.mysql;
			if (backupType === "database" && mysql) {
				return getMysqlBackupCommand(
					backup.database,
					mysql.databaseRootPassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mysql) {
				return getMysqlBackupCommand(
					backup.database,
					backup.metadata?.mysql?.databaseRootPassword || "",
				);
			}
			break;
		}
		case "mariadb": {
			const mariadb = backup.mariadb;
			if (backupType === "database" && mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					mariadb.databaseUser,
					mariadb.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					backup.metadata.mariadb.databaseUser,
					backup.metadata.mariadb.databasePassword,
				);
			}
			break;
		}
		case "mongo": {
			const mongo = backup.mongo;
			if (backupType === "database" && mongo) {
				return getMongoBackupCommand(
					backup.database,
					mongo.databaseUser,
					mongo.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mongo) {
				return getMongoBackupCommand(
					backup.database,
					backup.metadata.mongo.databaseUser,
					backup.metadata.mongo.databasePassword,
				);
			}
			break;
		}
		default:
			throw new Error(`Database type not supported: ${databaseType}`);
	}

	return null;
};

export const getBackupCommand = (
	backup: BackupSchedule,
	rcloneCommand: string,
	logPath: string,
) => {
	const containerSearch = getContainerSearchCommand(backup);
	const backupCommand = generateBackupCommand(backup);
	const safeLogPath = quote([logPath]);

	logger.info(
		{
			logPath,
		},
		`Executing backup command: ${backup.databaseType} ${backup.backupType}`,
	);

	return `
	set -eo pipefail;
	echo "[$(date)] Starting backup process..." >> ${safeLogPath};
	echo "[$(date)] Executing backup command..." >> ${safeLogPath};
	CONTAINER_ID=$(${containerSearch})

	if [ -z "$CONTAINER_ID" ]; then
		echo "[$(date)] ❌ Error: Container not found" >> ${safeLogPath};
		exit 1;
	fi

	echo "[$(date)] Container Up: $CONTAINER_ID" >> ${safeLogPath};

	# Run the backup command and capture the exit status
	BACKUP_OUTPUT=$(${backupCommand} 2>&1 >/dev/null) || {
		echo "[$(date)] ❌ Error: Backup failed" >> ${safeLogPath};
		echo "Error: $BACKUP_OUTPUT" >> ${safeLogPath};
		exit 1;
	}

	echo "[$(date)] ✅ backup completed successfully" >> ${safeLogPath};
	echo "[$(date)] Starting upload to S3..." >> ${safeLogPath};

	# Run the upload command and capture the exit status
	UPLOAD_OUTPUT=$(${backupCommand} | ${rcloneCommand} 2>&1 >/dev/null) || {
		echo "[$(date)] ❌ Error: Upload to S3 failed" >> ${safeLogPath};
		echo "Error: $UPLOAD_OUTPUT" >> ${safeLogPath};
		exit 1;
	}

	echo "[$(date)] ✅ Upload to S3 completed successfully" >> ${safeLogPath};
	echo "Backup done ✅" >> ${safeLogPath};
	`;
};
