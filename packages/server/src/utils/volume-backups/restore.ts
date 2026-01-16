import path from "node:path";
import {
	findApplicationById,
	findComposeById,
	findDestinationById,
	getS3Credentials,
	paths,
} from "../..";
import { ALL_MOUNTS_VOLUME_NAME, getBackupBaseName, isBindPath } from "./naming";

const shEscape = (value: string | undefined): string => {
	if (!value) return "''";
	return `'${value.replace(/'/g, `'\\''`)}'`;
};

export const restoreVolume = async (
	id: string,
	destinationId: string,
	volumeName: string,
	backupFileName: string,
	serverId: string,
	serviceType: "application" | "compose",
) => {
	const destination = await findDestinationById(destinationId);
	const { VOLUME_BACKUPS_PATH } = paths(!!serverId);
	const isBind = isBindPath(volumeName);
	const backupBaseName = getBackupBaseName(volumeName);
	const volumeBackupPath = path.join(VOLUME_BACKUPS_PATH, backupBaseName);
	const rcloneFlags = getS3Credentials(destination);
	const bucketPath = `:s3:${destination.bucket}`;
	const backupPath = `${bucketPath}/${backupFileName}`;

	// Command to download backup file from S3
	const downloadCommand = `rclone copyto ${rcloneFlags.join(" ")} "${backupPath}" "${volumeBackupPath}/${backupFileName}"`;

	if (volumeName.trim() === ALL_MOUNTS_VOLUME_NAME) {
		const restoreAllMountsCommand = `
		set -e
		echo "=== ALL MOUNTS RESTORE ==="
		echo "Backup file name: ${backupFileName}"
		echo "Volume backup path: ${volumeBackupPath}"
		echo "Downloading backup from S3..."
		mkdir -p ${shEscape(volumeBackupPath)}
		${downloadCommand}
		echo "Download completed ✅"

		MANIFEST_FILE=${shEscape(path.join(volumeBackupPath, ".dokploy_all_mounts_mounts.txt"))}
		TAR_LIST_FILE=${shEscape(path.join(volumeBackupPath, ".dokploy_all_mounts_tar_list.txt"))}

		echo "Extracting mounts manifest..."
		docker run --rm \
			-v ${shEscape(volumeBackupPath)}:/backup \
			ubuntu \
			bash -c "set -e; (tar -xOf /backup/${backupFileName} .dokploy_all_mounts_mounts.txt > /backup/.dokploy_all_mounts_mounts.txt 2>/dev/null || tar -xOf /backup/${backupFileName} ./.dokploy_all_mounts_mounts.txt > /backup/.dokploy_all_mounts_mounts.txt)"

		if [ ! -s "$MANIFEST_FILE" ]; then
			echo "Mounts manifest not found in archive: .dokploy_all_mounts_mounts.txt"
			exit 1
		fi

		echo "Indexing archive..."
		docker run --rm \
			-v ${shEscape(volumeBackupPath)}:/backup \
			ubuntu \
			bash -c "set -e; tar -tf /backup/${backupFileName} > /backup/.dokploy_all_mounts_tar_list.txt"

		if [ ! -s "$TAR_LIST_FILE" ]; then
			echo "Failed to index archive contents."
			exit 1
		fi

		INDEX=0
		while IFS='|' read -r TYPE SOURCE NAME DEST RW; do
			[ -n "$DEST" ] || continue
			LABEL=$(basename "$DEST" | sed 's/[^a-zA-Z0-9_.-]/_/g')
			PREFIX="${"$"}{INDEX}-${"$"}{LABEL}"

			ENTRY_DIR=""
			ENTRY_FILE=""
			if grep -q "^${"$"}{PREFIX}/" "$TAR_LIST_FILE"; then
				ENTRY_DIR="${"$"}PREFIX/"
			elif grep -q "^\\./${"$"}{PREFIX}/" "$TAR_LIST_FILE"; then
				ENTRY_DIR="./${"$"}PREFIX/"
			elif grep -q "^${"$"}{PREFIX}$" "$TAR_LIST_FILE"; then
				ENTRY_FILE="${"$"}PREFIX"
			elif grep -q "^\\./${"$"}{PREFIX}$" "$TAR_LIST_FILE"; then
				ENTRY_FILE="./${"$"}PREFIX"
			else
				echo "Skipping missing entry in archive: ${"$"}PREFIX"
				INDEX=$((INDEX+1))
				continue
			fi
			STRIP_COMPONENTS=1
			if [ -n "$ENTRY_DIR" ]; then
				case "$ENTRY_DIR" in
					./*)
						STRIP_COMPONENTS=2
						;;
					*)
						STRIP_COMPONENTS=1
						;;
				esac
			fi

			if [ "$TYPE" = "volume" ]; then
				VOLUME_NAME="$NAME"
				if [ -z "$VOLUME_NAME" ]; then
					echo "Skipping volume mount with empty name (dest: ${"$"}DEST)"
					INDEX=$((INDEX+1))
					continue
				fi
				echo "Restoring docker volume: ${"$"}VOLUME_NAME (${ "$"}DEST)"
				if [ -z "$ENTRY_DIR" ]; then
					echo "Unexpected file entry for volume mount: ${"$"}PREFIX"
					exit 1
				fi
				docker run --rm \
					-v "${"$"}VOLUME_NAME":/target \
					-v ${shEscape(volumeBackupPath)}:/backup \
					ubuntu \
					bash -c "set -e; tar xvf /backup/${backupFileName} -C /target --overwrite --strip-components=${"$"}STRIP_COMPONENTS \\"${"$"}ENTRY_DIR\\""
			elif [ "$TYPE" = "bind" ]; then
				HOST_PATH="$SOURCE"
				if [ -z "$HOST_PATH" ]; then
					echo "Skipping bind mount with empty source (dest: ${"$"}DEST)"
					INDEX=$((INDEX+1))
					continue
				fi

				if [ -n "$ENTRY_DIR" ]; then
					echo "Restoring bind directory: ${"$"}HOST_PATH (${ "$"}DEST)"
					mkdir -p "${"$"}HOST_PATH"
					docker run --rm \
						--mount "type=bind,source=${"$"}HOST_PATH,target=/target" \
						-v ${shEscape(volumeBackupPath)}:/backup \
						ubuntu \
						bash -c "set -e; tar xvf /backup/${backupFileName} -C /target --overwrite --strip-components=${"$"}STRIP_COMPONENTS \\"${"$"}ENTRY_DIR\\""
				else
					echo "Restoring bind file: ${"$"}HOST_PATH (${ "$"}DEST)"
					HOST_DIR=$(dirname "${"$"}HOST_PATH")
					HOST_FILE=$(basename "${"$"}HOST_PATH")
					mkdir -p "${"$"}HOST_DIR"
					docker run --rm \
						--mount "type=bind,source=${"$"}HOST_DIR,target=/target" \
						-v ${shEscape(volumeBackupPath)}:/backup \
						ubuntu \
						bash -c "set -e; tar xvf /backup/${backupFileName} -C /tmp --overwrite \\"${"$"}ENTRY_FILE\\"; cp -f \\"/tmp/${"$"}ENTRY_FILE\\" \\"/target/${"$"}HOST_FILE\\""
				fi
			else
				echo "Skipping unknown mount type: ${"$"}TYPE"
			fi

			INDEX=$((INDEX+1))
		done < "$MANIFEST_FILE"

		echo "All mounts restore completed ✅"
		`;

		if (serviceType === "application") {
			const application = await findApplicationById(id);
			return `
			echo "=== ALL MOUNTS RESTORE FOR APPLICATION ==="
			SERVICE_NAME=${shEscape(application.appName)}
			ACTUAL_REPLICAS=$(docker service inspect "$SERVICE_NAME" --format "{{.Spec.Mode.Replicated.Replicas}}")
			echo "Actual replicas: $ACTUAL_REPLICAS"
			echo "Stopping application to 0 replicas"
			docker service scale "$SERVICE_NAME"=0
			${restoreAllMountsCommand}
			echo "Starting application to $ACTUAL_REPLICAS replicas"
			docker service scale "$SERVICE_NAME"=$ACTUAL_REPLICAS
			`;
		}

		if (serviceType === "compose") {
			const compose = await findComposeById(id);
			if (compose.composeType === "stack") {
				return `
				echo "=== ALL MOUNTS RESTORE FOR COMPOSE STACK ==="
				STACK_NAME=${shEscape(compose.appName)}
				echo "Stack: $STACK_NAME"
				REPLICAS_FILE=${shEscape(
					path.join(volumeBackupPath, ".dokploy_all_mounts_stack_replicas.txt"),
				)}
				: > "$REPLICAS_FILE"
				SERVICES=$(docker service ls --filter "label=com.docker.stack.namespace=$STACK_NAME" --format "{{.Name}}")
				if [ -z "$SERVICES" ]; then
					echo "No services found for stack: $STACK_NAME"
				else
					echo "Stopping stack services..."
					for svc in $SERVICES; do
						REPLICAS=$(docker service inspect "$svc" --format "{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{end}}")
						if [ -z "$REPLICAS" ]; then
							echo "Service is not replicated and cannot be auto-stopped: $svc"
							exit 1
						fi
						echo "${"$"}svc|${"$"}REPLICAS" >> "$REPLICAS_FILE"
						docker service scale "${"$"}svc"=0
					done
				fi
				${restoreAllMountsCommand}
				if [ -s "$REPLICAS_FILE" ]; then
					echo "Starting stack services..."
					while IFS='|' read -r svc replicas; do
						[ -n "$svc" ] || continue
						docker service scale "${"$"}svc"="${"$"}replicas"
					done < "$REPLICAS_FILE"
				fi
				`;
			}

			return `
			echo "=== ALL MOUNTS RESTORE FOR DOCKER-COMPOSE ==="
			PROJECT_NAME=${shEscape(compose.appName)}
			echo "Compose project: $PROJECT_NAME"
			CONTAINERS=$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJECT_NAME")
			if [ -n "$CONTAINERS" ]; then
				echo "Stopping compose containers..."
				docker stop $CONTAINERS
			else
				echo "No compose containers found for project: $PROJECT_NAME"
			fi
			${restoreAllMountsCommand}
			if [ -n "$CONTAINERS" ]; then
				echo "Starting compose containers..."
				docker start $CONTAINERS
			fi
			`;
		}

		return `
		echo "ALL_MOUNTS restore is only supported for application and compose."
		exit 1
		`;
	}

	const bindRestoreCommand = `
	set -e
	echo "Target path: ${volumeName}"
	echo "Backup file name: ${backupFileName}"
	echo "Volume backup path: ${volumeBackupPath}"
	echo "Downloading backup from S3..."
	mkdir -p ${shEscape(volumeBackupPath)}
	${downloadCommand}
	echo "Download completed 鉁?
	TARGET_PATH=${shEscape(volumeName)}
	if [ -d "$TARGET_PATH" ] || [ "\${TARGET_PATH%/}" != "$TARGET_PATH" ]; then
		echo "Restoring to directory: $TARGET_PATH"
		mkdir -p "$TARGET_PATH"
		docker run --rm \
			-v "$TARGET_PATH":/target \
			-v ${shEscape(volumeBackupPath)}:/backup \
			ubuntu \
			bash -c "tar xvf /backup/${backupFileName} -C /target --overwrite"
	else
		TARGET_DIR=$(dirname "$TARGET_PATH")
		echo "Restoring to file directory: $TARGET_DIR"
		mkdir -p "$TARGET_DIR"
		docker run --rm \
			-v "$TARGET_DIR":/target \
			-v ${shEscape(volumeBackupPath)}:/backup \
			ubuntu \
			bash -c "tar xvf /backup/${backupFileName} -C /target --overwrite"
	fi
	echo "Bind restore completed 鉁?
	`;

	if (isBind) {
		if (serviceType === "application") {
			const application = await findApplicationById(id);
			return `
			echo "=== BIND RESTORE FOR APPLICATION ==="
			echo "Application: ${application.appName}"
			${bindRestoreCommand}
			`;
		}

		if (serviceType === "compose") {
			const compose = await findComposeById(id);
			return `
			echo "=== BIND RESTORE FOR COMPOSE ==="
			echo "Compose: ${compose.appName}"
			echo "Compose Type: ${compose.composeType}"
			${bindRestoreCommand}
			`;
		}

		return bindRestoreCommand;
	}

	// Base restore command that creates the volume and restores data
	const baseRestoreCommand = `
	set -e
	echo "Volume name: ${volumeName}"
	echo "Backup file name: ${backupFileName}"
	echo "Volume backup path: ${volumeBackupPath}"
	echo "Downloading backup from S3..."
	mkdir -p ${shEscape(volumeBackupPath)}
	${downloadCommand}
	echo "Download completed ✅"
	echo "Creating new volume and restoring data..."
	docker run --rm \
		-v ${shEscape(volumeName)}:/volume_data \
		-v ${shEscape(volumeBackupPath)}:/backup \
		ubuntu \
		bash -c "cd /volume_data && tar xvf /backup/${backupFileName} ."
	echo "Volume restore completed ✅"
	`;

	// Function to check if volume exists and get containers using it
	const checkVolumeCommand = `
	# Check if volume exists
	VOLUME_EXISTS=$(docker volume ls -q --filter name="^${volumeName}$" | wc -l)
	echo "Volume exists: $VOLUME_EXISTS"
	
	if [ "$VOLUME_EXISTS" = "0" ]; then
		echo "Volume doesn't exist, proceeding with direct restore"
		${baseRestoreCommand}
	else
		echo "Volume exists, checking for containers using it (including stopped ones)..."
		
		# Get ALL containers (running and stopped) using this volume - much simpler with native filter!
		CONTAINERS_USING_VOLUME=$(docker ps -a --filter "volume=${volumeName}" --format "{{.ID}}|{{.Names}}|{{.State}}|{{.Labels}}")
		
		if [ -z "$CONTAINERS_USING_VOLUME" ]; then
			echo "Volume exists but no containers are using it"
			echo "Removing existing volume and proceeding with restore"
			docker volume rm ${volumeName} --force
			${baseRestoreCommand}
		else
			echo ""
			echo "⚠️  WARNING: Cannot restore volume as it is currently in use!"
			echo ""
			echo "📋 The following containers are using volume '${volumeName}':"
			echo ""
			
			echo "$CONTAINERS_USING_VOLUME" | while IFS='|' read container_id container_name container_state labels; do
				echo "   🐳 Container: $container_name ($container_id)"
				echo "      Status: $container_state"
				
				# Determine container type
				if echo "$labels" | grep -q "com.docker.swarm.service.name="; then
					SERVICE_NAME=$(echo "$labels" | grep -o "com.docker.swarm.service.name=[^,]*" | cut -d'=' -f2)
					echo "      Type: Docker Swarm Service ($SERVICE_NAME)"
				elif echo "$labels" | grep -q "com.docker.compose.project="; then
					PROJECT_NAME=$(echo "$labels" | grep -o "com.docker.compose.project=[^,]*" | cut -d'=' -f2)
					echo "      Type: Docker Compose ($PROJECT_NAME)"
				else
					echo "      Type: Regular Container"
				fi
				echo ""
			done
			
			echo ""
			echo "🔧 To restore this volume, please:"
			echo "   1. Stop all containers/services using this volume"
			echo "   2. Remove the existing volume: docker volume rm ${volumeName}"
			echo "   3. Run the restore operation again"
			echo ""
			echo "❌ Volume restore aborted - volume is in use"
			
			exit 1
		fi
	fi
	`;

	if (serviceType === "application") {
		const application = await findApplicationById(id);
		return `
		echo "=== VOLUME RESTORE FOR APPLICATION ==="
		echo "Application: ${application.appName}"
		${checkVolumeCommand}
		`;
	}

	if (serviceType === "compose") {
		const compose = await findComposeById(id);

		return `
		echo "=== VOLUME RESTORE FOR COMPOSE ==="
		echo "Compose: ${compose.appName}"
		echo "Compose Type: ${compose.composeType}"
		${checkVolumeCommand}
		`;
	}

	// Fallback for unknown service types
	return checkVolumeCommand;
};
