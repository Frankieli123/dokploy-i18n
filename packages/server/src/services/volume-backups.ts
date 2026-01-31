import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { db } from "../db";
import {
	type createVolumeBackupSchema,
	type updateVolumeBackupSchema,
	volumeBackups,
} from "../db/schema";
import {
	ALL_MOUNTS_VOLUME_NAME,
	normalizeAllMountsVolumeName,
} from "../utils/volume-backups/naming";

const requireNonEmpty = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

export const findVolumeBackupById = async (volumeBackupId: string) => {
	const volumeBackup = await db.query.volumeBackups.findFirst({
		where: eq(volumeBackups.volumeBackupId, volumeBackupId),
		with: {
			application: true,
			postgres: true,
			mysql: true,
			mariadb: true,
			mongo: true,
			redis: true,
			compose: true,
			destination: true,
		},
	});

	if (!volumeBackup) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Volume backup not found",
		});
	}

	return volumeBackup;
};

export const createVolumeBackup = async (
	volumeBackup: z.infer<typeof createVolumeBackupSchema>,
) => {
	const normalized = {
		...volumeBackup,
		serviceType: volumeBackup.serviceType ?? "application",
		volumeName: normalizeAllMountsVolumeName(volumeBackup.volumeName),
		serviceName:
			typeof volumeBackup.serviceName === "string"
				? volumeBackup.serviceName.trim()
				: volumeBackup.serviceName,
	};

	if (normalized.volumeName === ALL_MOUNTS_VOLUME_NAME) {
		if (
			normalized.serviceType !== "application" &&
			normalized.serviceType !== "compose"
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"ALL mounts volume backups are only supported for application and compose",
			});
		}
		if (
			normalized.serviceType === "application" &&
			!requireNonEmpty(normalized.applicationId)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "applicationId is required for ALL mounts application backups",
			});
		}
		if (
			normalized.serviceType === "compose" &&
			(!requireNonEmpty(normalized.composeId) ||
				!requireNonEmpty(normalized.serviceName))
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "composeId and serviceName are required for ALL mounts compose backups",
			});
		}
	}

	const newVolumeBackup = await db
		.insert(volumeBackups)
		.values(normalized)
		.returning()
		.then((e) => e[0]);

	return newVolumeBackup;
};

export const removeVolumeBackup = async (volumeBackupId: string) => {
	await db
		.delete(volumeBackups)
		.where(eq(volumeBackups.volumeBackupId, volumeBackupId));
};

export const updateVolumeBackup = async (
	volumeBackupId: string,
	volumeBackup: z.infer<typeof updateVolumeBackupSchema>,
) => {
	const normalized = {
		...volumeBackup,
		serviceType: volumeBackup.serviceType ?? "application",
		volumeName: normalizeAllMountsVolumeName(volumeBackup.volumeName),
		serviceName:
			typeof volumeBackup.serviceName === "string"
				? volumeBackup.serviceName.trim()
				: volumeBackup.serviceName,
	};

	if (normalized.volumeName === ALL_MOUNTS_VOLUME_NAME) {
		if (
			normalized.serviceType !== "application" &&
			normalized.serviceType !== "compose"
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"ALL mounts volume backups are only supported for application and compose",
			});
		}
		if (
			normalized.serviceType === "application" &&
			!requireNonEmpty(normalized.applicationId)
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "applicationId is required for ALL mounts application backups",
			});
		}
		if (
			normalized.serviceType === "compose" &&
			(!requireNonEmpty(normalized.composeId) ||
				!requireNonEmpty(normalized.serviceName))
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "composeId and serviceName are required for ALL mounts compose backups",
			});
		}
	}

	return await db
		.update(volumeBackups)
		.set(normalized)
		.where(eq(volumeBackups.volumeBackupId, volumeBackupId))
		.returning()
		.then((e) => e[0]);
};
