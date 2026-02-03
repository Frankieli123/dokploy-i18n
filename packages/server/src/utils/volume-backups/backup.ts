import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { findComposeById } from "@dokploy/server/services/compose";
import type { findVolumeBackupById } from "@dokploy/server/services/volume-backups";
import { getS3Credentials, normalizeS3Path } from "../backups/utils";
import { ALL_MOUNTS_VOLUME_NAME, getBackupBaseName, isBindPath } from "./naming";

const shEscape = (value: string | undefined): string => {
	if (!value) return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
};

export const backupVolume = async (
	volumeBackup: Awaited<ReturnType<typeof findVolumeBackupById>>,
) => {
	const { serviceType, volumeName, turnOff, prefix } = volumeBackup;
	const isAllMounts = volumeName.trim() === ALL_MOUNTS_VOLUME_NAME;
	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
	const { VOLUME_BACKUPS_PATH } = paths(!!serverId);
	const destination = volumeBackup.destination;
	const isBind = !isAllMounts && isBindPath(volumeName);
	const backupBaseName = getBackupBaseName(volumeName);
	const backupFileName = `${backupBaseName}-${new Date().toISOString()}.tar`;
	const bucketDestination = `${normalizeS3Path(prefix)}${backupFileName}`;
	const rcloneFlags = getS3Credentials(volumeBackup.destination);
	const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
	const volumeBackupPath = path.join(VOLUME_BACKUPS_PATH, volumeBackup.appName);

	const rcloneCommand = `rclone copyto ${rcloneFlags.join(" ")} "${volumeBackupPath}/${backupFileName}" "${rcloneDestination}"`;

		if (isAllMounts) {
			const buildDockerArgsFromMounts = `
			BACKUP_DIR=${shEscape(volumeBackupPath)}
			mkdir -p "$BACKUP_DIR"
			MOUNTS_FILE="$BACKUP_DIR/.dokploy_all_mounts_mounts.txt"
			: > "$MOUNTS_FILE"
			MOUNT_COUNT=0
			set -- docker run --rm -v "$BACKUP_DIR:/backup" --mount "type=bind,source=$MOUNTS_FILE,target=/sources/.dokploy_all_mounts_mounts.txt,readonly" ubuntu bash -c "cd /sources; tar cvf \"/backup/${backupFileName}\" .; TAR_STATUS=$?; if [ $TAR_STATUS -gt 1 ]; then exit $TAR_STATUS; fi; exit 0"
			MOUNTS_RAW_FILE="$BACKUP_DIR/.dokploy_all_mounts_raw.txt"
			printf '%s\n' "$MOUNTS_RAW" > "$MOUNTS_RAW_FILE"
			while IFS='|' read -r TYPE SOURCE NAME DEST RW; do
				[ -n "$DEST" ] || continue
				case "$DEST" in
					/etc/hosts|/etc/hostname|/etc/resolv.conf|/var/run/docker.sock|/run/docker.sock)
					continue
					;;
			esac

			LABEL=$(basename "$DEST" | sed 's/[^a-zA-Z0-9_.-]/_/g')
			TARGET="/sources/${"$"}{MOUNT_COUNT}-${"$"}{LABEL}"

				if [ "$TYPE" = "volume" ]; then
					[ -n "$NAME" ] || continue
					set -- "$@" -v "$NAME:$TARGET:ro"
					printf '%s|%s|%s|%s|%s\n' "$TYPE" "" "$NAME" "$DEST" "$RW" >> "$MOUNTS_FILE"
					MOUNT_COUNT=$((MOUNT_COUNT+1))
					continue
				fi

				if [ "$TYPE" = "bind" ]; then
					[ -n "$SOURCE" ] || continue
					case "$SOURCE" in
						/var/lib/docker/containers/*)
							continue
							;;
					esac
					case "$SOURCE" in
						/var/lib/docker/swarm/*|/var/lib/docker/volumes/*|/proc/*|/sys/*|/dev/*)
							continue
							;;
					esac
					if [ ! -e "$SOURCE" ]; then
						echo "Skipping missing bind mount source: $SOURCE"
						continue
					fi
					if [ ! -f "$SOURCE" ] && [ ! -d "$SOURCE" ]; then
						echo "Skipping unsupported bind mount source type: $SOURCE"
						continue
					fi
					set -- "$@" --mount "type=bind,source=$SOURCE,target=$TARGET,readonly"
					printf '%s|%s|%s|%s|%s\n' "$TYPE" "$SOURCE" "" "$DEST" "$RW" >> "$MOUNTS_FILE"
					MOUNT_COUNT=$((MOUNT_COUNT+1))
				fi
			done < "$MOUNTS_RAW_FILE"
			rm -f "$MOUNTS_RAW_FILE"

			if [ "$MOUNT_COUNT" -le 0 ]; then
				echo "No eligible mounts found to backup."
				exit 1
			fi

			"$@"
			`;

		const baseCommand = `
		set -e
		echo "Source: ALL_MOUNTS (${serviceType})"
		echo "Backup file name: ${backupFileName}"
		echo "Turning off volume backup: ${turnOff ? "Yes" : "No"}"
		echo "Starting volume backup"
		echo "Dir: ${volumeBackupPath}"

		${buildDockerArgsFromMounts}

		echo "Volume backup done ✅"
		echo "Starting upload to S3..."
		${rcloneCommand}
		echo "Upload to S3 done ✅"
		echo "Cleaning up local backup file..."
		rm "${volumeBackupPath}/${backupFileName}"
		echo "Local backup file cleaned up ✅"
		`;

		if (!turnOff) {
			if (serviceType === "application") {
				const appName = volumeBackup.application?.appName;
				if (!appName) throw new Error("Application not found for ALL_MOUNTS");
				return `
				SERVICE_NAME=${shEscape(appName)}
				CONTAINER_ID=$(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE_NAME" | head -n 1)
				if [ -z "$CONTAINER_ID" ]; then
					echo "No running container found for service: $SERVICE_NAME"
					exit 1
				fi
				MOUNTS_RAW=$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}}{{\"\\n\"}}{{end}}' "$CONTAINER_ID")
				${baseCommand}
				`;
			}

			if (serviceType === "compose") {
				const compose = await findComposeById(
					volumeBackup.compose?.composeId || "",
				);
				const serviceName = volumeBackup.serviceName;
				if (!serviceName) throw new Error("serviceName is required for ALL_MOUNTS");

				const containerIdCommand =
					compose.composeType === "stack"
						? `SERVICE_NAME=${shEscape(`${compose.appName}_${serviceName}`)}
				CONTAINER_ID=$(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE_NAME" | head -n 1)`
						: `CONTAINER_ID=$(docker ps -q --filter "label=com.docker.compose.project=${compose.appName}" --filter "label=com.docker.compose.service=${serviceName}" | head -n 1)`;

				return `
				${containerIdCommand}
				if [ -z "$CONTAINER_ID" ]; then
					echo "No running container found for compose service: ${compose.appName}/${serviceName}"
					exit 1
				fi
				MOUNTS_RAW=$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}}{{\"\\n\"}}{{end}}' "$CONTAINER_ID")
				${baseCommand}
				`;
			}
		}

		if (serviceType === "application") {
			const appName = volumeBackup.application?.appName;
			if (!appName) throw new Error("Application not found for ALL_MOUNTS");
			return `
			SERVICE_NAME=${shEscape(appName)}
			CONTAINER_ID=$(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE_NAME" | head -n 1)
			if [ -z "$CONTAINER_ID" ]; then
				echo "No running container found for service: $SERVICE_NAME"
				exit 1
			fi
			MOUNTS_RAW=$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}}{{\"\\n\"}}{{end}}' "$CONTAINER_ID")

			echo "Stopping application to 0 replicas"
			ACTUAL_REPLICAS=$(docker service inspect $SERVICE_NAME --format "{{.Spec.Mode.Replicated.Replicas}}")
			echo "Actual replicas: $ACTUAL_REPLICAS"
			docker service scale $SERVICE_NAME=0
			${baseCommand}
			echo "Starting application to $ACTUAL_REPLICAS replicas"
			docker service scale $SERVICE_NAME=$ACTUAL_REPLICAS
			`;
		}

		if (serviceType === "compose") {
			const compose = await findComposeById(volumeBackup.compose?.composeId || "");
			const serviceName = volumeBackup.serviceName;
			if (!serviceName) throw new Error("serviceName is required for ALL_MOUNTS");

			if (compose.composeType === "stack") {
				return `
				SERVICE_NAME=${shEscape(`${compose.appName}_${serviceName}`)}
				CONTAINER_ID=$(docker ps -q --filter "label=com.docker.swarm.service.name=$SERVICE_NAME" | head -n 1)
				if [ -z "$CONTAINER_ID" ]; then
					echo "No running container found for compose service: ${compose.appName}/${serviceName}"
					exit 1
				fi
				MOUNTS_RAW=$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}}{{\"\\n\"}}{{end}}' "$CONTAINER_ID")

				echo "Stopping compose to 0 replicas"
				ACTUAL_REPLICAS=$(docker service inspect $SERVICE_NAME --format "{{.Spec.Mode.Replicated.Replicas}}")
				echo "Actual replicas: $ACTUAL_REPLICAS"
				docker service scale $SERVICE_NAME=0
				${baseCommand}
				echo "Starting compose to $ACTUAL_REPLICAS replicas"
				docker service scale $SERVICE_NAME=$ACTUAL_REPLICAS
				`;
			}

			return `
			CONTAINER_ID=$(docker ps -q --filter "label=com.docker.compose.project=${compose.appName}" --filter "label=com.docker.compose.service=${serviceName}" | head -n 1)
			if [ -z "$CONTAINER_ID" ]; then
				echo "No running container found for compose service: ${compose.appName}/${serviceName}"
				exit 1
			fi
			MOUNTS_RAW=$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Name}}|{{.Destination}}|{{.RW}}{{\"\\n\"}}{{end}}' "$CONTAINER_ID")

			echo "Stopping compose container"
			docker stop $CONTAINER_ID
			${baseCommand}
			echo "Starting compose container"
			docker start $CONTAINER_ID
			echo "Compose container started"
			`;
		}

		return `
		echo "ALL_MOUNTS is only supported for application and compose volume backups."
		exit 1
		`;
	}

	const dockerBackupCommand = isBind
		? `SOURCE_PATH=${shEscape(volumeName)}
		  echo "Bind source: $SOURCE_PATH"
		  echo "Checking bind path on Docker host (via --mount)..."
	  if ! docker run --rm \
	    --mount type=bind,source="$SOURCE_PATH",target=/source_data,readonly \
	    -e SOURCE_PATH="$SOURCE_PATH" \
	    -v ${shEscape(volumeBackupPath)}:/backup \
	    ubuntu \
	    bash -c 'set -e
	      if [ -d /source_data ]; then
	        cd /source_data && tar cvf /backup/${backupFileName} .
	      elif [ -f /source_data ]; then
	        SOURCE_FILE=$(basename "$SOURCE_PATH")
	        cp /source_data "/tmp/$SOURCE_FILE"
	        tar cvf /backup/${backupFileName} -C /tmp "$SOURCE_FILE"
	      else
	        echo "Source is not a regular file or directory: $SOURCE_PATH"
	        exit 1
	      fi'; then
	    echo "Source path does not exist on the Docker host or cannot be mounted: $SOURCE_PATH"
	    echo "Tip: if this is a Docker named volume, set Source to the volume name (e.g. cli-proxy-api) instead of a host path."
	    exit 1
	  fi
	  `
		: `docker run --rm \
	  -v ${shEscape(volumeName)}:/volume_data \
	  -v ${shEscape(volumeBackupPath)}:/backup \
	  ubuntu \
  bash -c "cd /volume_data && tar cvf /backup/${backupFileName} ."
  `;

	const baseCommand = `
	set -e
	echo "Source: ${volumeName}"
	echo "Backup file name: ${backupFileName}"
	echo "Turning off volume backup: ${turnOff ? "Yes" : "No"}"
	echo "Starting volume backup" 
	echo "Dir: ${volumeBackupPath}"
	${dockerBackupCommand}
  echo "Volume backup done ✅"
  echo "Starting upload to S3..."
  ${rcloneCommand}
  echo "Upload to S3 done ✅"
  echo "Cleaning up local backup file..."
  rm "${volumeBackupPath}/${backupFileName}"
  echo "Local backup file cleaned up ✅"
  `;

	if (!turnOff) {
		return baseCommand;
	}

	if (serviceType === "application") {
		return `
		echo "Stopping application to 0 replicas"
		ACTUAL_REPLICAS=$(docker service inspect ${volumeBackup.application?.appName} --format "{{.Spec.Mode.Replicated.Replicas}}")
		echo "Actual replicas: $ACTUAL_REPLICAS"
		docker service scale ${volumeBackup.application?.appName}=0
        ${baseCommand}
		echo "Starting application to $ACTUAL_REPLICAS replicas"
        docker service scale ${volumeBackup.application?.appName}=$ACTUAL_REPLICAS
  `;
	}
	if (serviceType === "compose") {
		const compose = await findComposeById(
			volumeBackup.compose?.composeId || "",
		);
		let stopCommand = "";
		let startCommand = "";

		if (compose.composeType === "stack") {
			stopCommand = `
			echo "Stopping compose to 0 replicas"
			echo "Service name: ${compose.appName}_${volumeBackup.serviceName}"
            ACTUAL_REPLICAS=$(docker service inspect ${compose.appName}_${volumeBackup.serviceName} --format "{{.Spec.Mode.Replicated.Replicas}}")
            echo "Actual replicas: $ACTUAL_REPLICAS"
            docker service scale ${compose.appName}_${volumeBackup.serviceName}=0`;
			startCommand = `
			echo "Starting compose to $ACTUAL_REPLICAS replicas"
			docker service scale ${compose.appName}_${volumeBackup.serviceName}=$ACTUAL_REPLICAS`;
		} else {
			stopCommand = `
			echo "Stopping compose container"
            ID=$(docker ps -q --filter "label=com.docker.compose.project=${compose.appName}" --filter "label=com.docker.compose.service=${volumeBackup.serviceName}")
            docker stop $ID`;
			startCommand = `
            echo "Starting compose container"
            docker start $ID
			echo "Compose container started"
			`;
		}
		return `
        ${stopCommand}
        ${baseCommand}
        ${startCommand}
  `;
	}
};
