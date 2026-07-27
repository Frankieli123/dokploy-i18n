import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import { findDestinationById } from "@dokploy/server/services/destination";
import { getS3Credentials } from "../backups/utils";
import { resolveVolumeBackupDockerPath } from "./host-path";
import {
	ALL_MOUNTS_VOLUME_NAME,
	getBackupBaseName,
	isBindPath,
	normalizeAllMountsVolumeName,
} from "./naming";

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
	const normalizedVolumeName = normalizeAllMountsVolumeName(volumeName);
	const destination = await findDestinationById(destinationId);
	const { VOLUME_BACKUPS_PATH } = paths(!!serverId);
	const isBind = isBindPath(normalizedVolumeName);
	const backupBaseName = getBackupBaseName(normalizedVolumeName);
	const volumeBackupPath = path.posix.join(VOLUME_BACKUPS_PATH, backupBaseName);
	const volumeBackupDockerPath = resolveVolumeBackupDockerPath(
		volumeBackupPath,
		serverId,
	);
	const rcloneFlags = getS3Credentials(destination);
	const bucketPath = `:s3:${destination.bucket}`;
	const backupPath = `${bucketPath}/${backupFileName}`;

	// Command to download backup file from S3
	const downloadCommand = `rclone copyto ${rcloneFlags.join(" ")} "${backupPath}" "${volumeBackupPath}/${backupFileName}"`;

	if (normalizedVolumeName === ALL_MOUNTS_VOLUME_NAME) {
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
			-v ${shEscape(volumeBackupDockerPath)}:/backup \
			ubuntu \
			bash -c "set -e; (tar -xOf /backup/${backupFileName} .dokploy_all_mounts_mounts.txt > /backup/.dokploy_all_mounts_mounts.txt 2>/dev/null || tar -xOf /backup/${backupFileName} ./.dokploy_all_mounts_mounts.txt > /backup/.dokploy_all_mounts_mounts.txt)"

		if [ ! -s "$MANIFEST_FILE" ]; then
			echo "Mounts manifest not found in archive: .dokploy_all_mounts_mounts.txt"
			exit 1
		fi

		echo "Indexing archive..."
		docker run --rm \
			-v ${shEscape(volumeBackupDockerPath)}:/backup \
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
				echo "Restoring docker volume: ${"$"}VOLUME_NAME (${"$"}DEST)"
				if [ -z "$ENTRY_DIR" ]; then
					echo "Unexpected file entry for volume mount: ${"$"}PREFIX"
					exit 1
				fi
				docker run --rm \
					-v "${"$"}VOLUME_NAME":/target \
					-v ${shEscape(volumeBackupDockerPath)}:/backup \
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
					echo "Restoring bind directory: ${"$"}HOST_PATH (${"$"}DEST)"
					mkdir -p "${"$"}HOST_PATH"
					docker run --rm \
						--mount "type=bind,source=${"$"}HOST_PATH,target=/target" \
						-v ${shEscape(volumeBackupDockerPath)}:/backup \
						ubuntu \
						bash -c "set -e; tar xvf /backup/${backupFileName} -C /target --overwrite --strip-components=${"$"}STRIP_COMPONENTS \\"${"$"}ENTRY_DIR\\""
				else
					echo "Restoring bind file: ${"$"}HOST_PATH (${"$"}DEST)"
					HOST_DIR=$(dirname "${"$"}HOST_PATH")
					HOST_FILE=$(basename "${"$"}HOST_PATH")
					mkdir -p "${"$"}HOST_DIR"
					docker run --rm \
						--mount "type=bind,source=${"$"}HOST_DIR,target=/target" \
						-v ${shEscape(volumeBackupDockerPath)}:/backup \
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
			STOPPED_APPLICATION=0
			restart_application() {
				if [ "$STOPPED_APPLICATION" != "1" ]; then
					return 0
				fi
				echo "Starting application to $ACTUAL_REPLICAS replicas"
				docker service scale "$SERVICE_NAME"=$ACTUAL_REPLICAS
			}
			cleanup() {
				STATUS=$?
				if [ "$STATUS" -ne 0 ]; then
					restart_application || echo "Failed to restart application: $SERVICE_NAME"
				fi
				exit $STATUS
			}
			trap cleanup EXIT
			echo "Actual replicas: $ACTUAL_REPLICAS"
			echo "Stopping application to 0 replicas"
			docker service scale "$SERVICE_NAME"=0
			STOPPED_APPLICATION=1
			${restoreAllMountsCommand}
			restart_application
			STOPPED_APPLICATION=0
			trap - EXIT
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
				restore_stack_services() {
					if [ ! -s "$REPLICAS_FILE" ]; then
						return 0
					fi
					echo "Starting stack services..."
					while IFS='|' read -r svc replicas; do
						[ -n "$svc" ] || continue
						docker service scale "${"$"}svc"="${"$"}replicas"
					done < "$REPLICAS_FILE"
				}
				cleanup() {
					STATUS=$?
					if [ "$STATUS" -ne 0 ]; then
						restore_stack_services || echo "Failed to restart stack services for: $STACK_NAME"
					fi
					exit $STATUS
				}
				trap cleanup EXIT
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
				restore_stack_services
				trap - EXIT
				`;
			}

			return `
			echo "=== ALL MOUNTS RESTORE FOR DOCKER-COMPOSE ==="
			PROJECT_NAME=${shEscape(compose.appName)}
			echo "Compose project: $PROJECT_NAME"
			CONTAINERS=$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJECT_NAME")
			STOPPED_COMPOSE_CONTAINERS=0
			restart_compose_containers() {
				if [ "$STOPPED_COMPOSE_CONTAINERS" != "1" ] || [ -z "$CONTAINERS" ]; then
					return 0
				fi
				echo "Starting compose containers..."
				docker start $CONTAINERS
			}
			cleanup() {
				STATUS=$?
				if [ "$STATUS" -ne 0 ]; then
					restart_compose_containers || echo "Failed to restart compose containers for: $PROJECT_NAME"
				fi
				exit $STATUS
			}
			trap cleanup EXIT
			if [ -n "$CONTAINERS" ]; then
				echo "Stopping compose containers..."
				docker stop $CONTAINERS
				STOPPED_COMPOSE_CONTAINERS=1
			else
				echo "No compose containers found for project: $PROJECT_NAME"
			fi
			${restoreAllMountsCommand}
			restart_compose_containers
			STOPPED_COMPOSE_CONTAINERS=0
			trap - EXIT
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
	echo "Download completed ✅"
	TARGET_PATH=${shEscape(normalizedVolumeName)}
	if docker run --rm \
		--mount "type=bind,source=$TARGET_PATH,target=/target,readonly" \
		ubuntu test -d /target; then
		echo "Restoring to directory: $TARGET_PATH"
		docker run --rm \
			--mount "type=bind,source=$TARGET_PATH,target=/target" \
			-v ${shEscape(volumeBackupDockerPath)}:/backup \
			ubuntu \
			tar xvf ${shEscape(`/backup/${backupFileName}`)} -C /target --overwrite
	elif docker run --rm \
		--mount "type=bind,source=$TARGET_PATH,target=/target,readonly" \
		ubuntu test -f /target; then
		TARGET_DIR=$(dirname "$TARGET_PATH")
		TARGET_FILE=$(basename "$TARGET_PATH")
		echo "Restoring to file directory: $TARGET_DIR"
		docker run --rm \
			--mount "type=bind,source=$TARGET_DIR,target=/target" \
			-v ${shEscape(volumeBackupDockerPath)}:/backup \
			ubuntu \
			bash -c 'set -e; TMP=$(mktemp -d); cleanup_tmp() { rm -rf "$TMP"; }; trap cleanup_tmp EXIT; tar xvf "$1" -C "$TMP" --overwrite; SOURCE_FILE=$(find "$TMP" -type f | head -n 1); [ -n "$SOURCE_FILE" ]; cp -pf "$SOURCE_FILE" "/target/$2"' bash ${shEscape(`/backup/${backupFileName}`)} "$TARGET_FILE"
	else
		echo "Bind restore target does not exist on the Docker host: $TARGET_PATH"
		exit 1
	fi
	echo "Bind restore completed ✅"
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

	const archiveValidationScript = shEscape(`set -e
	ARCHIVE="$1"
	test -f "$ARCHIVE"
	tar -tf "$ARCHIVE" > /tmp/archive-list
	awk 'BEGIN { invalid=0 } substr($0, 1, 1) == "/" { invalid=1 } { count=split($0, parts, "/"); for (index=1; index<=count; index++) if (parts[index] == "..") invalid=1 } END { exit invalid }' /tmp/archive-list`);

	const namedVolumeRestoreCommand = `
	set -e
	VOLUME_NAME=${shEscape(normalizedVolumeName)}
	BACKUP_DIR=${shEscape(volumeBackupPath)}
	BACKUP_DOCKER_DIR=${shEscape(volumeBackupDockerPath)}
	ARCHIVE_PATH=${shEscape(`/backup/${backupFileName}`)}
	STATE_DIR=$(mktemp -d)
	CONTAINERS_FILE="$STATE_DIR/containers"
	SERVICES_FILE="$STATE_DIR/services"
	SERVICE_CANDIDATES_FILE="$STATE_DIR/service-candidates"
	LIFECYCLE_STARTED=0
	: > "$CONTAINERS_FILE"
	: > "$SERVICES_FILE"
	: > "$SERVICE_CANDIDATES_FILE"

	restart_consumers() {
		RESTART_STATUS=0
		while IFS='|' read -r service replicas; do
			[ -n "$service" ] || continue
			echo "Restoring Swarm service $service to $replicas replicas..."
			docker service scale "$service=$replicas" || RESTART_STATUS=1
		done < "$SERVICES_FILE"
		while IFS= read -r container_id; do
			[ -n "$container_id" ] || continue
			echo "Restarting container $container_id..."
			docker start "$container_id" || RESTART_STATUS=1
		done < "$CONTAINERS_FILE"
		return "$RESTART_STATUS"
	}

	cleanup_restore() {
		STATUS=$?
		trap - EXIT
		if [ "$LIFECYCLE_STARTED" = "1" ]; then
			echo "Restore did not complete; restoring previously running consumers..."
			restart_consumers || echo "One or more consumers could not be restarted automatically."
		fi
		rm -rf "$STATE_DIR"
		exit "$STATUS"
	}
	trap cleanup_restore EXIT

	echo "Volume name: $VOLUME_NAME"
	echo "Backup file name: ${backupFileName}"
	echo "Volume backup path: $BACKUP_DIR"
	echo "Downloading backup from S3..."
	mkdir -p "$BACKUP_DIR"
	${downloadCommand}
	echo "Download completed"

	echo "Validating backup archive..."
	docker run --rm \
		-v "$BACKUP_DOCKER_DIR:/backup" \
		ubuntu \
		bash -c ${archiveValidationScript} bash "$ARCHIVE_PATH"
	echo "Backup archive is valid"

	CONSUMERS=$(docker ps -a --filter "volume=$VOLUME_NAME" --format "{{.ID}}")
	for container_id in $CONSUMERS; do
		service=$(docker inspect --format '{{if .Config.Labels}}{{index .Config.Labels "com.docker.swarm.service.name"}}{{end}}' "$container_id")
		if [ -n "$service" ] && [ "$service" != "<no value>" ]; then
			echo "$service" >> "$SERVICE_CANDIDATES_FILE"
			continue
		fi

		state=$(docker inspect --format '{{.State.Status}}' "$container_id")
		if [ "$state" = "running" ]; then
			echo "$container_id" >> "$CONTAINERS_FILE"
		fi
	done
	sort -u "$SERVICE_CANDIDATES_FILE" -o "$SERVICE_CANDIDATES_FILE"

	while IFS= read -r service; do
		[ -n "$service" ] || continue
		if ! service_state=$(docker service inspect "$service" --format '{{if .Spec.Mode.Replicated}}replicated|{{.Spec.Mode.Replicated.Replicas}}{{else}}global|0{{end}}' 2>/dev/null); then
			echo "Ignoring stale task for missing Swarm service: $service"
			continue
		fi
		mode=$(printf '%s' "$service_state" | cut -d'|' -f1)
		replicas=$(printf '%s' "$service_state" | cut -d'|' -f2)
		if [ "$mode" != "replicated" ]; then
			echo "Cannot safely restore a volume used by global Swarm service: $service"
			exit 1
		fi
		if [ "$replicas" -gt 0 ]; then
			echo "$service|$replicas" >> "$SERVICES_FILE"
		fi
	done < "$SERVICE_CANDIDATES_FILE"

	LIFECYCLE_STARTED=1
	while IFS= read -r container_id; do
		[ -n "$container_id" ] || continue
		echo "Stopping container $container_id..."
		docker stop "$container_id"
	done < "$CONTAINERS_FILE"
	while IFS='|' read -r service replicas; do
		[ -n "$service" ] || continue
		echo "Scaling Swarm service $service from $replicas replicas to 0..."
		docker service scale "$service=0"
	done < "$SERVICES_FILE"

	WAIT_COUNT=0
	while docker ps -q --filter "volume=$VOLUME_NAME" | grep -q .; do
		WAIT_COUNT=$((WAIT_COUNT+1))
		if [ "$WAIT_COUNT" -ge 60 ]; then
			echo "Timed out waiting for running consumers to release volume: $VOLUME_NAME"
			exit 1
		fi
		sleep 1
	done

	echo "Restoring data in place..."
	docker run --rm \
		-v "$VOLUME_NAME:/volume_data" \
		-v "$BACKUP_DOCKER_DIR:/backup" \
		ubuntu \
		bash -c 'set -e; find /volume_data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar xf "$1" -C /volume_data' bash "$ARCHIVE_PATH"
	echo "Volume data restored"

	if ! restart_consumers; then
		echo "Volume data was restored, but one or more consumers could not be restarted."
		exit 1
	fi
	LIFECYCLE_STARTED=0
	trap - EXIT
	rm -rf "$STATE_DIR"
	echo "Volume restore completed"
	`;

	if (serviceType === "application") {
		const application = await findApplicationById(id);
		return `
		echo "=== VOLUME RESTORE FOR APPLICATION ==="
		echo "Application: ${application.appName}"
		${namedVolumeRestoreCommand}
		`;
	}

	if (serviceType === "compose") {
		const compose = await findComposeById(id);

		return `
		echo "=== VOLUME RESTORE FOR COMPOSE ==="
		echo "Compose: ${compose.appName}"
		echo "Compose Type: ${compose.composeType}"
		${namedVolumeRestoreCommand}
		`;
	}

	// Fallback for unknown service types
	return namedVolumeRestoreCommand;
};
