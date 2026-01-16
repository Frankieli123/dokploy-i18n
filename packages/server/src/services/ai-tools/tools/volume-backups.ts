import { existsSync, promises as fsPromises } from "node:fs";
import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	deployments,
	volumeBackups as volumeBackupsTable,
} from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import {
	createDeploymentVolumeBackup,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findDestinationById } from "@dokploy/server/services/destination";
import { findMemberById } from "@dokploy/server/services/user";
import {
	createVolumeBackup,
	findVolumeBackupById,
	removeVolumeBackup,
	updateVolumeBackup,
} from "@dokploy/server/services/volume-backups";
import {
	getS3Credentials,
	normalizeS3Path,
} from "@dokploy/server/utils/backups/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import {
	ALL_MOUNTS_VOLUME_NAME,
	getBackupBaseName,
} from "@dokploy/server/utils/volume-backups/naming";
import { restoreVolume } from "@dokploy/server/utils/volume-backups/restore";
import {
	removeVolumeBackupJob,
	runVolumeBackup,
	scheduleVolumeBackup,
} from "@dokploy/server/utils/volume-backups/utils";
import { desc, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext } from "../types";

const createJob = async (input: {
	cronSchedule: string;
	volumeBackupId: string;
	type: "volume-backup";
}) => {
	const url = process.env.JOBS_URL;
	if (!url) throw new Error("JOBS_URL is not configured");
	const res = await fetch(`${url}/create-backup`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.API_KEY || "NO-DEFINED",
		},
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		throw new Error(`Failed to schedule cloud job (${res.status})`);
	}
};

const updateJob = async (input: {
	cronSchedule: string;
	volumeBackupId: string;
	type: "volume-backup";
}) => {
	const url = process.env.JOBS_URL;
	if (!url) throw new Error("JOBS_URL is not configured");
	const res = await fetch(`${url}/update-backup`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.API_KEY || "NO-DEFINED",
		},
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		throw new Error(`Failed to update cloud job (${res.status})`);
	}
};

const removeJob = async (input: {
	cronSchedule: string;
	volumeBackupId: string;
	type: "volume-backup";
}) => {
	const url = process.env.JOBS_URL;
	if (!url) throw new Error("JOBS_URL is not configured");
	const res = await fetch(`${url}/remove-job`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-API-Key": process.env.API_KEY || "NO-DEFINED",
		},
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		throw new Error(`Failed to remove cloud job (${res.status})`);
	}
};

const loadServiceForOrg = async (
	serviceType: "application" | "compose",
	serviceId: string,
	ctx: ToolContext,
) => {
	if (serviceType === "application") {
		const a = await findApplicationById(serviceId);
		if (a.environment.project.organizationId !== ctx.organizationId) {
			throw new Error("Application access denied");
		}
		return { serviceType, serverId: a.serverId ?? null };
	}
	const c = await findComposeById(serviceId);
	if (c.environment.project.organizationId !== ctx.organizationId) {
		throw new Error("Compose access denied");
	}
	return { serviceType, serverId: c.serverId ?? null };
};

const loadVolumeBackupForOrg = async (
	volumeBackupId: string,
	ctx: ToolContext,
) => {
	await findMemberById(ctx.userId, ctx.organizationId);
	const vb = await findVolumeBackupById(volumeBackupId);

	const destination = vb.destination
		? vb.destination
		: await findDestinationById(vb.destinationId);
	if (destination.organizationId !== ctx.organizationId) {
		throw new Error("Volume backup access denied");
	}

	if (vb.serviceType === "application") {
		if (!vb.applicationId)
			throw new Error("Volume backup missing applicationId");
		const svc = await loadServiceForOrg("application", vb.applicationId, ctx);
		return {
			volumeBackup: vb,
			destination,
			serviceType: "application" as const,
			serviceId: vb.applicationId,
			serverId: svc.serverId,
		};
	}

	if (vb.serviceType === "compose") {
		if (!vb.composeId) throw new Error("Volume backup missing composeId");
		const svc = await loadServiceForOrg("compose", vb.composeId, ctx);
		return {
			volumeBackup: vb,
			destination,
			serviceType: "compose" as const,
			serviceId: vb.composeId,
			serverId: svc.serverId,
		};
	}

	throw new Error("Unsupported volume backup serviceType");
};

const readLogLimited = async (input: {
	serverId: string | null;
	logPath: string;
	direction: "start" | "end";
	maxBytes: number;
}) => {
	const bytes = input.maxBytes;
	if (!input.logPath) return "";
	if (input.serverId) {
		const base = input.direction === "start" ? "head" : "tail";
		const cmd = `${base} -c ${bytes} ${quote([input.logPath])}`;
		const out = await execAsyncRemote(input.serverId, cmd);
		return (out.stdout || out.stderr || "").trim();
	}
	if (!existsSync(input.logPath)) return "";
	const content = await fsPromises.readFile(input.logPath, "utf8");
	if (content.length <= bytes) return content.trim();
	const sliced =
		input.direction === "start"
			? content.slice(0, bytes).trim()
			: content.slice(-bytes).trim();
	return `${sliced}\n...[TRUNCATED]`;
};

type VolumeBackupSummary = {
	volumeBackupId: string;
	name: string;
	serviceType: string;
	serviceId: string;
	destinationId: string;
	volumeName: string;
	prefix: string;
	cronExpression: string;
	keepLatestCount: number | null;
	turnOff: boolean;
	enabled: boolean;
	createdAt: string;
	serviceName: string | null;
};

const toSummary = (vb: {
	volumeBackupId: string;
	name: string;
	serviceType: string;
	applicationId: string | null;
	composeId: string | null;
	destinationId: string;
	volumeName: string;
	prefix: string;
	cronExpression: string;
	keepLatestCount: number | null;
	turnOff: boolean;
	enabled: boolean | null;
	createdAt: string;
	serviceName: string | null;
}): VolumeBackupSummary => {
	const serviceId = vb.applicationId || vb.composeId || "";
	return {
		volumeBackupId: vb.volumeBackupId,
		name: vb.name,
		serviceType: vb.serviceType,
		serviceId,
		destinationId: vb.destinationId,
		volumeName: vb.volumeName,
		prefix: vb.prefix,
		cronExpression: vb.cronExpression,
		keepLatestCount: vb.keepLatestCount ?? null,
		turnOff: vb.turnOff,
		enabled: Boolean(vb.enabled),
		createdAt: vb.createdAt,
		serviceName: vb.serviceName ?? null,
	};
};

const listVolumeBackups: Tool<
	{ serviceType: "application" | "compose"; serviceId: string },
	VolumeBackupSummary[]
> = {
	name: "volume_backup_list",
	description:
		"List volume backup schedules for an application or compose service",
	category: "backup",
	parameters: z.object({
		serviceType: z.enum(["application", "compose"]),
		serviceId: z.string().min(1),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		await loadServiceForOrg(params.serviceType, params.serviceId, ctx);

		const results = await db.query.volumeBackups.findMany({
			where:
				params.serviceType === "application"
					? eq(volumeBackupsTable.applicationId, params.serviceId)
					: eq(volumeBackupsTable.composeId, params.serviceId),
			with: {
				destination: true,
			},
			orderBy: desc(volumeBackupsTable.createdAt),
		});

		const filtered = results.filter(
			(v) => v.destination?.organizationId === ctx.organizationId,
		);

		return {
			success: true,
			message: `Found ${filtered.length} volume backup(s)`,
			data: filtered.map((vb) =>
				toSummary({
					volumeBackupId: vb.volumeBackupId,
					name: vb.name,
					serviceType: vb.serviceType,
					applicationId: vb.applicationId,
					composeId: vb.composeId,
					destinationId: vb.destinationId,
					volumeName: vb.volumeName,
					prefix: vb.prefix,
					cronExpression: vb.cronExpression,
					keepLatestCount: vb.keepLatestCount ?? null,
					turnOff: vb.turnOff,
					enabled: vb.enabled,
					createdAt: vb.createdAt,
					serviceName: vb.serviceName ?? null,
				}),
			),
		};
	},
};

const getVolumeBackup: Tool<{ volumeBackupId: string }, VolumeBackupSummary> = {
	name: "volume_backup_get",
	description: "Get details of a volume backup schedule",
	category: "backup",
	parameters: z.object({
		volumeBackupId: z.string().min(1),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		try {
			const loaded = await loadVolumeBackupForOrg(params.volumeBackupId, ctx);
			return {
				success: true,
				message: "Volume backup retrieved",
				data: toSummary({
					volumeBackupId: loaded.volumeBackup.volumeBackupId,
					name: loaded.volumeBackup.name,
					serviceType: loaded.volumeBackup.serviceType,
					applicationId: loaded.volumeBackup.applicationId,
					composeId: loaded.volumeBackup.composeId,
					destinationId: loaded.volumeBackup.destinationId,
					volumeName: loaded.volumeBackup.volumeName,
					prefix: loaded.volumeBackup.prefix,
					cronExpression: loaded.volumeBackup.cronExpression,
					keepLatestCount: loaded.volumeBackup.keepLatestCount ?? null,
					turnOff: loaded.volumeBackup.turnOff,
					enabled: loaded.volumeBackup.enabled,
					createdAt: loaded.volumeBackup.createdAt,
					serviceName: loaded.volumeBackup.serviceName ?? null,
				}),
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to get volume backup",
				error: msg,
				data: {
					volumeBackupId: "",
					name: "",
					serviceType: "",
					serviceId: "",
					destinationId: "",
					volumeName: "",
					prefix: "",
					cronExpression: "",
					keepLatestCount: null,
					turnOff: false,
					enabled: false,
					createdAt: "",
					serviceName: null,
				},
			};
		}
	},
};

const createVolumeBackupTool: Tool<
	{
		serviceType: "application" | "compose";
		serviceId: string;
		name: string;
		volumeName: string;
		prefix?: string;
		destinationId: string;
		cronExpression: string;
		keepLatestCount?: number;
		enabled?: boolean;
		turnOff?: boolean;
		serviceName?: string;
		confirm: "CONFIRM_VOLUME_BACKUP_CHANGE";
	},
	{ volumeBackupId: string }
> = {
	name: "volume_backup_create",
	description:
		"Create a volume backup schedule for a named volume, bind path, or all mounts (volumeName=dokploy_all_mounts). Requires approval + confirm.",
	category: "backup",
	parameters: z
		.object({
			serviceType: z.enum(["application", "compose"]),
			serviceId: z.string().min(1),
			name: z.string().min(1),
			volumeName: z
				.string()
				.min(1)
				.describe(
					"Named volume (e.g. my_volume), bind path (e.g. /var/lib/... or /data/...), or dokploy_all_mounts to backup all mounts of the service",
				),
			prefix: z.string().optional().default("volume-backup"),
			destinationId: z.string().min(1),
			cronExpression: z.string().min(1),
			keepLatestCount: z.number().int().min(1).optional(),
			enabled: z.boolean().optional().default(true),
			turnOff: z.boolean().optional().default(false),
			serviceName: z
				.string()
				.min(1)
				.describe("Required when serviceType=compose")
				.optional(),
			confirm: z.literal("CONFIRM_VOLUME_BACKUP_CHANGE"),
		})
		.superRefine((v, ctx2) => {
			if (v.serviceType === "compose" && !v.serviceName) {
				ctx2.addIssue({
					code: "custom",
					message: "serviceName is required for compose volume backups",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		await loadServiceForOrg(params.serviceType, params.serviceId, ctx);
		const destination = await findDestinationById(params.destinationId);
		if (destination.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Destination access denied",
				error: "UNAUTHORIZED",
				data: { volumeBackupId: "" },
			};
		}

		const created = await createVolumeBackup({
			name: params.name,
			volumeName: params.volumeName,
			prefix: params.prefix ?? "volume-backup",
			serviceType: params.serviceType,
			serviceName:
				params.serviceType === "compose" ? (params.serviceName ?? null) : null,
			turnOff: params.turnOff ?? false,
			cronExpression: params.cronExpression,
			keepLatestCount: params.keepLatestCount,
			enabled: params.enabled ?? true,
			destinationId: params.destinationId,
			applicationId:
				params.serviceType === "application" ? params.serviceId : null,
			composeId: params.serviceType === "compose" ? params.serviceId : null,
		});

		if (!created) {
			return {
				success: false,
				message: "Failed to create volume backup",
				error: "INTERNAL_ERROR",
				data: { volumeBackupId: "" },
			};
		}

		if (created.enabled) {
			if (IS_CLOUD) {
				await createJob({
					type: "volume-backup",
					cronSchedule: created.cronExpression,
					volumeBackupId: created.volumeBackupId,
				});
			} else {
				await scheduleVolumeBackup(created.volumeBackupId);
			}
		}

		return {
			success: true,
			message: "Volume backup created",
			data: { volumeBackupId: created.volumeBackupId },
		};
	},
};

const createAndRunVolumeBackupTool: Tool<
	{
		serviceType: "application" | "compose";
		serviceId: string;
		name: string;
		volumeName: string;
		prefix?: string;
		destinationId: string;
		cronExpression: string;
		keepLatestCount?: number;
		enabled?: boolean;
		turnOff?: boolean;
		serviceName?: string;
		runNow?: boolean;
		confirm: "CONFIRM_VOLUME_BACKUP_CHANGE";
	},
	{ volumeBackupId: string; triggered: boolean }
> = {
	name: "volume_backup_create_and_run_now",
	description:
		"Create a volume backup schedule and optionally run it immediately (runNow=true). Requires approval + confirm.",
	category: "backup",
	parameters: z
		.object({
			serviceType: z.enum(["application", "compose"]),
			serviceId: z.string().min(1),
			name: z.string().min(1),
			volumeName: z
				.string()
				.min(1)
				.describe(
					"Named volume, bind path, or dokploy_all_mounts to backup all mounts",
				),
			prefix: z.string().optional().default("volume-backup"),
			destinationId: z.string().min(1),
			cronExpression: z.string().min(1),
			keepLatestCount: z.number().int().min(1).optional(),
			enabled: z.boolean().optional().default(true),
			turnOff: z.boolean().optional().default(false),
			serviceName: z.string().min(1).optional(),
			runNow: z.boolean().optional().default(false),
			confirm: z.literal("CONFIRM_VOLUME_BACKUP_CHANGE"),
		})
		.superRefine((v, ctx2) => {
			if (v.serviceType === "compose" && !v.serviceName) {
				ctx2.addIssue({
					code: "custom",
					message: "serviceName is required for compose volume backups",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const svc = await loadServiceForOrg(params.serviceType, params.serviceId, ctx);
		const destination = await findDestinationById(params.destinationId);
		if (destination.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Destination access denied",
				error: "UNAUTHORIZED",
				data: { volumeBackupId: "", triggered: false },
			};
		}

		const created = await createVolumeBackup({
			name: params.name,
			volumeName: params.volumeName,
			prefix: params.prefix ?? "volume-backup",
			serviceType: params.serviceType,
			serviceName:
				params.serviceType === "compose" ? (params.serviceName ?? null) : null,
			turnOff: params.turnOff ?? false,
			cronExpression: params.cronExpression,
			keepLatestCount: params.keepLatestCount,
			enabled: params.enabled ?? true,
			destinationId: params.destinationId,
			applicationId:
				params.serviceType === "application" ? params.serviceId : null,
			composeId: params.serviceType === "compose" ? params.serviceId : null,
		});

		if (!created) {
			return {
				success: false,
				message: "Failed to create volume backup",
				error: "INTERNAL_ERROR",
				data: { volumeBackupId: "", triggered: false },
			};
		}

		if (created.enabled) {
			if (IS_CLOUD) {
				await createJob({
					type: "volume-backup",
					cronSchedule: created.cronExpression,
					volumeBackupId: created.volumeBackupId,
				});
			} else {
				await scheduleVolumeBackup(created.volumeBackupId);
			}
		}

		if (params.runNow) {
			await runVolumeBackup(created.volumeBackupId);
			return {
				success: true,
				message: "Volume backup created and triggered",
				data: { volumeBackupId: created.volumeBackupId, triggered: true },
			};
		}

		return {
			success: true,
			message: "Volume backup created",
			data: { volumeBackupId: created.volumeBackupId, triggered: false },
		};
	},
};

const runAllMountsBackupNowTool: Tool<
	{
		serviceType: "application" | "compose";
		serviceId: string;
		name?: string;
		prefix?: string;
		destinationId: string;
		cronExpression?: string;
		keepLatestCount?: number;
		enabled?: boolean;
		turnOff?: boolean;
		serviceName?: string;
		confirm: "CONFIRM_VOLUME_BACKUP_CHANGE";
	},
	{
		volumeBackupId: string;
		triggered: boolean;
		deploymentId: string;
		status: string;
		log: string;
	}
> = {
	name: "volume_backup_run_all_mounts_now",
	description:
		"One-click: backup ALL mounts for an application/compose service and run it now (volumeName=dokploy_all_mounts). Creates a (disabled by default) schedule and triggers it immediately. Requires approval + confirm.",
	category: "backup",
	aliases: [
		"backup all mounts now",
		"one-click volume backup",
		"一键备份挂载",
		"全挂载备份",
		"一键卷备份",
	],
	tags: ["backup", "volume", "mount", "all", "一键", "备份", "挂载", "全选"],
	parameters: z
		.object({
			serviceType: z.enum(["application", "compose"]),
			serviceId: z.string().min(1),
			name: z.string().min(1).optional(),
			prefix: z.string().optional().default("volume-backup"),
			destinationId: z.string().min(1),
			cronExpression: z
				.string()
				.min(1)
				.optional()
				.default("0 0 * * *")
				.describe("Cron expression for the created schedule (default daily)"),
			keepLatestCount: z.number().int().min(1).optional(),
			enabled: z
				.boolean()
				.optional()
				.default(false)
				.describe("Whether to keep the schedule enabled after this run"),
			turnOff: z
				.boolean()
				.optional()
				.default(false)
				.describe("Stop service before backup (downtime)"),
			serviceName: z
				.string()
				.min(1)
				.optional()
				.describe("Required when serviceType=compose"),
			confirm: z.literal("CONFIRM_VOLUME_BACKUP_CHANGE"),
		})
		.superRefine((v, ctx2) => {
			if (v.serviceType === "compose" && !v.serviceName) {
				ctx2.addIssue({
					code: "custom",
					message: "serviceName is required for compose volume backups",
					path: ["serviceName"],
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);
		const svc = await loadServiceForOrg(params.serviceType, params.serviceId, ctx);
		const destination = await findDestinationById(params.destinationId);
		if (destination.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Destination access denied",
				error: "UNAUTHORIZED",
				data: {
					volumeBackupId: "",
					triggered: false,
					deploymentId: "",
					status: "error",
					log: "",
				},
			};
		}

		const created = await createVolumeBackup({
			name: params.name ?? "All mounts backup",
			volumeName: ALL_MOUNTS_VOLUME_NAME,
			prefix: params.prefix ?? "volume-backup",
			serviceType: params.serviceType,
			serviceName:
				params.serviceType === "compose" ? (params.serviceName ?? null) : null,
			turnOff: params.turnOff ?? false,
			cronExpression: params.cronExpression ?? "0 0 * * *",
			keepLatestCount: params.keepLatestCount,
			enabled: params.enabled ?? false,
			destinationId: params.destinationId,
			applicationId:
				params.serviceType === "application" ? params.serviceId : null,
			composeId: params.serviceType === "compose" ? params.serviceId : null,
		});

		if (!created) {
			return {
				success: false,
				message: "Failed to create volume backup",
				error: "INTERNAL_ERROR",
				data: {
					volumeBackupId: "",
					triggered: false,
					deploymentId: "",
					status: "error",
					log: "",
				},
			};
		}

		if (created.enabled) {
			if (IS_CLOUD) {
				await createJob({
					type: "volume-backup",
					cronSchedule: created.cronExpression,
					volumeBackupId: created.volumeBackupId,
				});
			} else {
				await scheduleVolumeBackup(created.volumeBackupId);
			}
		}

		await runVolumeBackup(created.volumeBackupId);
		const last = await db.query.deployments.findFirst({
			where: eq(deployments.volumeBackupId, created.volumeBackupId),
			orderBy: desc(deployments.createdAt),
		});

		const log =
			last?.logPath && last.status
				? await readLogLimited({
						serverId: svc.serverId ?? null,
						logPath: last.logPath,
						direction: "end",
						maxBytes: 200000,
					})
				: "";

		return {
			success: true,
			message: "All mounts volume backup triggered",
			data: {
				volumeBackupId: created.volumeBackupId,
				triggered: true,
				deploymentId: last?.deploymentId ?? "",
				status: last?.status ?? "unknown",
				log,
			},
		};
	},
};

const updateVolumeBackupTool: Tool<
	{
		volumeBackupId: string;
		name?: string;
		volumeName?: string;
		prefix?: string;
		destinationId?: string;
		cronExpression?: string;
		keepLatestCount?: number | null;
		enabled?: boolean;
		turnOff?: boolean;
		serviceName?: string | null;
		confirm: "CONFIRM_VOLUME_BACKUP_CHANGE";
	},
	{ updated: boolean }
> = {
	name: "volume_backup_update",
	description:
		"Update a volume backup schedule (supports named volumes, bind paths, and dokploy_all_mounts). Requires approval + confirm.",
	category: "backup",
	parameters: z
		.object({
			volumeBackupId: z.string().min(1),
			name: z.string().min(1).optional(),
			volumeName: z
				.string()
				.min(1)
				.describe(
					"Named volume (e.g. my_volume), bind path (e.g. /var/lib/... or /data/...), or dokploy_all_mounts to backup all mounts of the service",
				)
				.optional(),
			prefix: z.string().min(1).optional(),
			destinationId: z.string().min(1).optional(),
			cronExpression: z.string().min(1).optional(),
			keepLatestCount: z.number().int().min(1).nullable().optional(),
			enabled: z.boolean().optional(),
			turnOff: z.boolean().optional(),
			serviceName: z.string().min(1).nullable().optional(),
			confirm: z.literal("CONFIRM_VOLUME_BACKUP_CHANGE"),
		})
		.superRefine((v, ctx2) => {
			const hasAny =
				v.name !== undefined ||
				v.volumeName !== undefined ||
				v.prefix !== undefined ||
				v.destinationId !== undefined ||
				v.cronExpression !== undefined ||
				v.keepLatestCount !== undefined ||
				v.enabled !== undefined ||
				v.turnOff !== undefined ||
				v.serviceName !== undefined;
			if (!hasAny) {
				ctx2.addIssue({
					code: "custom",
					message: "At least one field must be provided to update",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const loaded = await loadVolumeBackupForOrg(params.volumeBackupId, ctx);

		if (params.destinationId) {
			const destination = await findDestinationById(params.destinationId);
			if (destination.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Destination access denied",
					error: "UNAUTHORIZED",
					data: { updated: false },
				};
			}
		}

		const updateInput = {
			volumeBackupId: params.volumeBackupId,
			name: params.name ?? loaded.volumeBackup.name,
			volumeName: params.volumeName ?? loaded.volumeBackup.volumeName,
			prefix: params.prefix ?? loaded.volumeBackup.prefix,
			destinationId: params.destinationId ?? loaded.volumeBackup.destinationId,
			cronExpression:
				params.cronExpression ?? loaded.volumeBackup.cronExpression,
			serviceType: loaded.volumeBackup.serviceType,
			serviceName:
				loaded.serviceType === "compose"
					? params.serviceName !== undefined
						? params.serviceName
						: loaded.volumeBackup.serviceName
					: loaded.volumeBackup.serviceName,
			keepLatestCount:
				params.keepLatestCount !== undefined
					? params.keepLatestCount
					: loaded.volumeBackup.keepLatestCount,
			enabled:
				params.enabled !== undefined
					? params.enabled
					: loaded.volumeBackup.enabled,
			turnOff:
				params.turnOff !== undefined
					? params.turnOff
					: loaded.volumeBackup.turnOff,
			applicationId: loaded.volumeBackup.applicationId,
			composeId: loaded.volumeBackup.composeId,
			postgresId: loaded.volumeBackup.postgresId,
			mysqlId: loaded.volumeBackup.mysqlId,
			mariadbId: loaded.volumeBackup.mariadbId,
			mongoId: loaded.volumeBackup.mongoId,
			redisId: loaded.volumeBackup.redisId,
		};

		const next = await updateVolumeBackup(params.volumeBackupId, updateInput);
		if (!next) {
			return {
				success: false,
				message: "Volume backup not found",
				error: "NOT_FOUND",
				data: { updated: false },
			};
		}

		if (IS_CLOUD) {
			if (next.enabled) {
				await updateJob({
					type: "volume-backup",
					cronSchedule: next.cronExpression,
					volumeBackupId: next.volumeBackupId,
				});
			} else {
				await removeJob({
					type: "volume-backup",
					cronSchedule: next.cronExpression,
					volumeBackupId: next.volumeBackupId,
				});
			}
		} else {
			await removeVolumeBackupJob(next.volumeBackupId);
			if (next.enabled) {
				await scheduleVolumeBackup(next.volumeBackupId);
			}
		}

		return {
			success: true,
			message: "Volume backup updated",
			data: { updated: Boolean(next) },
		};
	},
};

const deleteVolumeBackupTool: Tool<
	{ volumeBackupId: string; confirm: "CONFIRM_VOLUME_BACKUP_CHANGE" },
	{ deleted: boolean }
> = {
	name: "volume_backup_delete",
	description: "Delete a volume backup schedule (requires approval + confirm)",
	category: "backup",
	parameters: z.object({
		volumeBackupId: z.string().min(1),
		confirm: z.literal("CONFIRM_VOLUME_BACKUP_CHANGE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const loaded = await loadVolumeBackupForOrg(params.volumeBackupId, ctx);

		if (IS_CLOUD) {
			await removeJob({
				type: "volume-backup",
				cronSchedule: loaded.volumeBackup.cronExpression,
				volumeBackupId: loaded.volumeBackup.volumeBackupId,
			});
		} else {
			await removeVolumeBackupJob(loaded.volumeBackup.volumeBackupId);
		}

		await removeVolumeBackup(params.volumeBackupId);

		return {
			success: true,
			message: "Volume backup deleted",
			data: { deleted: true },
		};
	},
};

const runVolumeBackupNowTool: Tool<
	{ volumeBackupId: string },
	{ triggered: boolean }
> = {
	name: "volume_backup_run_now",
	description: "Trigger a volume backup immediately",
	category: "backup",
	parameters: z.object({
		volumeBackupId: z.string().min(1),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		try {
			await loadVolumeBackupForOrg(params.volumeBackupId, ctx);
			await runVolumeBackup(params.volumeBackupId);
			return {
				success: true,
				message: "Volume backup triggered",
				data: { triggered: true },
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to run volume backup",
				error: msg,
				data: { triggered: false },
			};
		}
	},
};

const volumeBackupLastResultTool: Tool<
	{ volumeBackupId: string; direction?: "start" | "end"; maxBytes?: number },
	{
		deploymentId: string;
		status: string;
		createdAt: string;
		startedAt: string | null;
		finishedAt: string | null;
		errorMessage: string | null;
		log: string;
	}
> = {
	name: "volume_backup_last_result",
	description:
		"Get the latest volume backup execution result (deployment) and log",
	category: "backup",
	parameters: z.object({
		volumeBackupId: z.string().min(1),
		direction: z.enum(["start", "end"]).optional().default("end"),
		maxBytes: z.number().int().min(1).max(500000).optional().default(200000),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		try {
			const loaded = await loadVolumeBackupForOrg(params.volumeBackupId, ctx);
			const last = await db.query.deployments.findFirst({
				where: eq(deployments.volumeBackupId, params.volumeBackupId),
				orderBy: desc(deployments.createdAt),
			});
			if (!last) {
				return {
					success: false,
					message: "No volume backup deployments found",
					error: "NOT_FOUND",
					data: {
						deploymentId: "",
						status: "unknown",
						createdAt: "",
						startedAt: null,
						finishedAt: null,
						errorMessage: null,
						log: "",
					},
				};
			}

			const log = await readLogLimited({
				serverId: loaded.serverId,
				logPath: last.logPath,
				direction: params.direction ?? "end",
				maxBytes: params.maxBytes ?? 200000,
			});

			return {
				success: true,
				message: "Volume backup last result retrieved",
				data: {
					deploymentId: last.deploymentId,
					status: last.status ?? "unknown",
					createdAt: last.createdAt,
					startedAt: last.startedAt ?? null,
					finishedAt: last.finishedAt ?? null,
					errorMessage: last.errorMessage ?? null,
					log,
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Failed to get volume backup last result",
				error: msg,
				data: {
					deploymentId: "",
					status: "unknown",
					createdAt: "",
					startedAt: null,
					finishedAt: null,
					errorMessage: null,
					log: "",
				},
			};
		}
	},
};

const restoreLatestVolumeBackupTool: Tool<
	{
		volumeBackupId: string;
		confirm: "RESTORE_LATEST";
	},
	{
		restored: boolean;
		backupFileName: string;
		deploymentId: string;
		logPath: string;
		log: string;
	}
> = {
	name: "volume_backup_restore_latest",
	description:
		"Restore the latest backup file for a volume backup schedule (named volumes, bind paths, or dokploy_all_mounts). Destructive operation. Requires confirm=RESTORE_LATEST.",
	category: "backup",
	aliases: [
		"restore latest volume backup",
		"restore latest backup file",
		"一键恢复最新备份",
		"恢复最新卷备份",
	],
	tags: ["restore", "backup", "latest", "一键", "恢复", "最新"],
	parameters: z.object({
		volumeBackupId: z.string().min(1),
		confirm: z.literal("RESTORE_LATEST"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		let deploymentId = "";
		let logPath = "";
		let pickedKey = "";
		try {
			const loaded = await loadVolumeBackupForOrg(params.volumeBackupId, ctx);
			const destination = loaded.volumeBackup.destination
				? loaded.volumeBackup.destination
				: await findDestinationById(loaded.volumeBackup.destinationId);

			const rcloneFlags = getS3Credentials(destination);
			const normalizedPrefix = normalizeS3Path(loaded.volumeBackup.prefix);
			const backupBaseName = getBackupBaseName(loaded.volumeBackup.volumeName);
			const listPath = `:s3:${destination.bucket}/${normalizedPrefix}`;
			const pickLatestCommand = `rclone lsf ${rcloneFlags.join(" ")} --include "${backupBaseName}-*.tar" "${listPath}" | sort -r | head -n 1`;

			const picked = loaded.serverId
				? await execAsyncRemote(loaded.serverId, pickLatestCommand)
				: await execAsync(pickLatestCommand);

			const fileName = (picked.stdout || "").trim().split(/\r?\n/)[0]?.trim() ?? "";
			if (!fileName) {
				return {
					success: false,
					message: "No backup files found for this volume backup",
					error: "NOT_FOUND",
					data: {
						restored: false,
						backupFileName: "",
						deploymentId: "",
						logPath: "",
						log: "",
					},
				};
			}

			pickedKey = `${normalizedPrefix}${fileName}`;

			const deployment = await createDeploymentVolumeBackup({
				volumeBackupId: params.volumeBackupId,
				title: "Volume Restore (Latest)",
				description: "Volume Restore (Latest)",
			});
			deploymentId = deployment.deploymentId;
			logPath = deployment.logPath;

			const cmd = await restoreVolume(
				loaded.serviceId,
				loaded.volumeBackup.destinationId,
				loaded.volumeBackup.volumeName,
				pickedKey,
				loaded.serverId || "",
				loaded.serviceType,
			);
			const cmdWithLog = `(${cmd}) >> ${logPath} 2>&1`;
			if (loaded.serverId) {
				await execAsyncRemote(loaded.serverId, cmdWithLog);
			} else {
				await execAsync(cmdWithLog);
			}

			await updateDeploymentStatus(deploymentId, "done");

			const log = await readLogLimited({
				serverId: loaded.serverId,
				logPath,
				direction: "end",
				maxBytes: 200000,
			});

			return {
				success: true,
				message: "Restore completed",
				data: {
					restored: true,
					backupFileName: pickedKey,
					deploymentId,
					logPath,
					log,
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (deploymentId) {
				try {
					await updateDeploymentStatus(deploymentId, "error");
				} catch {
					// ignore
				}
			}
			return {
				success: false,
				message: "Restore latest failed",
				error: msg,
				data: {
					restored: false,
					backupFileName: pickedKey,
					deploymentId,
					logPath,
					log: "",
				},
			};
		}
	},
};

const restoreVolumeBackupTool: Tool<
	{
		volumeBackupId: string;
		backupFileName: string;
		confirm: "RESTORE";
	},
	{ restored: boolean; deploymentId: string; logPath: string; log: string }
> = {
	name: "volume_backup_restore",
	description:
		"Restore from a stored backup file (supports named volumes, bind paths, and dokploy_all_mounts). Destructive operation. Requires confirm=RESTORE.",
	category: "backup",
	parameters: z.object({
		volumeBackupId: z.string().min(1),
		backupFileName: z.string().min(1),
		confirm: z.literal("RESTORE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		let deploymentId = "";
		let logPath = "";
		try {
			const loaded = await loadVolumeBackupForOrg(params.volumeBackupId, ctx);
			const deployment = await createDeploymentVolumeBackup({
				volumeBackupId: params.volumeBackupId,
				title: "Volume Restore",
				description: "Volume Restore",
			});
			deploymentId = deployment.deploymentId;
			logPath = deployment.logPath;

			const serverId = loaded.serverId;
			const cmd = await restoreVolume(
				loaded.serviceId,
				loaded.volumeBackup.destinationId,
				loaded.volumeBackup.volumeName,
				params.backupFileName,
				serverId || "",
				loaded.serviceType,
			);
			const cmdWithLog = `(${cmd}) >> ${logPath} 2>&1`;
			if (serverId) {
				await execAsyncRemote(serverId, cmdWithLog);
			} else {
				await execAsync(cmdWithLog);
			}

			await updateDeploymentStatus(deploymentId, "done");

			const log = await readLogLimited({
				serverId,
				logPath,
				direction: "end",
				maxBytes: 200000,
			});

			return {
				success: true,
				message: "Restore completed",
				data: { restored: true, deploymentId, logPath, log },
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (deploymentId) {
				try {
					await updateDeploymentStatus(deploymentId, "error");
				} catch {
					// ignore
				}
			}
			return {
				success: false,
				message: "Restore failed",
				error: msg,
				data: { restored: false, deploymentId, logPath, log: "" },
			};
		}
	},
};

export function registerVolumeBackupTools() {
	toolRegistry.register(listVolumeBackups);
	toolRegistry.register(getVolumeBackup);
	toolRegistry.register(createVolumeBackupTool);
	toolRegistry.register(createAndRunVolumeBackupTool);
	toolRegistry.register(runAllMountsBackupNowTool);
	toolRegistry.register(updateVolumeBackupTool);
	toolRegistry.register(deleteVolumeBackupTool);
	toolRegistry.register(runVolumeBackupNowTool);
	toolRegistry.register(volumeBackupLastResultTool);
	toolRegistry.register(restoreLatestVolumeBackupTool);
	toolRegistry.register(restoreVolumeBackupTool);
}
