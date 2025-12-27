import { db } from "@dokploy/server/db";
import {
	createRedis,
	deployRedis,
	findRedisById,
	removeRedisById,
} from "@dokploy/server/services/redis";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { generatePassword } from "@dokploy/server/templates";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const ensureRedisAccess = async (
	redisId: string,
	ctx: { organizationId: string },
) => {
	const redis = await findRedisById(redisId);
	if (redis.environment?.project?.organizationId !== ctx.organizationId) {
		return null;
	}
	return redis;
};

const ensureEnvironmentAccess = async (
	environmentId: string,
	ctx: { organizationId: string },
) => {
	const env = await findEnvironmentById(environmentId);
	if (env.project?.organizationId !== ctx.organizationId) {
		return null;
	}
	return env;
};

const listRedisDatabases: Tool<
	{ projectId?: string },
	Array<{ redisId: string; name: string; status: string }>
> = {
	name: "redis_list",
	description:
		"List all Redis databases in the organization. Optionally filter by project.",
	category: "database",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const databases = await db.query.redis.findMany({
			with: {
				environment: {
					with: { project: true },
				},
			},
		});

		const filtered = (params.projectId
			? databases.filter(
					(d) => d.environment?.project?.projectId === params.projectId,
				)
			: databases
		).filter((d) => d.environment?.project?.organizationId === ctx.organizationId);

		return {
			success: true,
			message: `Found ${filtered.length} Redis database(s)`,
			data: filtered.map((d) => ({
				redisId: d.redisId,
				name: d.name,
				status: d.applicationStatus || "idle",
			})),
		};
	},
};

const getRedisDetails: Tool<
	{ redisId: string },
	{ redisId: string; name: string; status: string; dockerImage: string }
> = {
	name: "redis_get",
	description: "Get details of a specific Redis database by ID",
	category: "database",
	parameters: z.object({
		redisId: z.string().describe("The Redis database ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const redis = await ensureRedisAccess(params.redisId, ctx);
		if (!redis) {
			return {
				success: false,
				message: "Redis access denied",
			};
		}
		return {
			success: true,
			message: `Redis "${redis.name}" details retrieved`,
			data: {
				redisId: redis.redisId,
				name: redis.name,
				status: redis.applicationStatus || "idle",
				dockerImage: redis.dockerImage,
			},
		};
	},
};

const createRedisDatabase: Tool<
	{
		name: string;
		appName: string;
		environmentId: string;
		databasePassword?: string;
		dockerImage?: string;
		description?: string;
		serverId?: string;
	},
	{ redisId: string; name: string }
> = {
	name: "redis_create",
	description: "Create a new Redis database. Requires environment ID.",
	category: "database",
	parameters: z.object({
		name: z.string().describe("Display name for the database"),
		appName: z.string().describe("Unique app name (used in container naming)"),
		environmentId: z.string().describe("Environment ID to create database in"),
		databasePassword: z
			.string()
			.optional()
			.describe("Redis password (auto-generated if omitted)"),
		dockerImage: z
			.string()
			.optional()
			.default("redis:7")
			.describe("Docker image"),
		description: z.string().optional().describe("Description"),
		serverId: z.string().optional().describe("Server ID for remote deployment"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const env = await ensureEnvironmentAccess(params.environmentId, ctx);
		if (!env) {
			return {
				success: false,
				message: "Environment access denied",
			};
		}

		const newDb = await createRedis({
			name: params.name,
			appName: params.appName,
			environmentId: params.environmentId,
			databasePassword: params.databasePassword ?? generatePassword(),
			dockerImage: params.dockerImage || "redis:7",
			description: params.description ?? null,
			serverId: params.serverId ?? ctx.serverId ?? null,
		});

		return {
			success: true,
			message: `Redis database "${newDb.name}" created successfully`,
			data: {
				redisId: newDb.redisId,
				name: newDb.name,
			},
		};
	},
};

const deployRedisDatabase: Tool<
	{ redisId: string },
	{ redisId: string; status: string }
> = {
	name: "redis_deploy",
	description: "Deploy/start a Redis database",
	category: "database",
	parameters: z.object({
		redisId: z.string().describe("The Redis database ID to deploy"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const redisAccess = await ensureRedisAccess(params.redisId, ctx);
		if (!redisAccess) {
			return {
				success: false,
				message: "Redis access denied",
			};
		}
		const redis = await deployRedis(params.redisId);
		return {
			success: true,
			message: `Redis "${redis.name}" deployed successfully`,
			data: {
				redisId: redis.redisId,
				status: "done",
			},
		};
	},
};

const deleteRedisDatabase: Tool<{ redisId: string }, { deleted: boolean }> = {
	name: "redis_delete",
	description: "Delete a Redis database. This action is irreversible!",
	category: "database",
	parameters: z.object({
		redisId: z.string().describe("The Redis database ID to delete"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const redis = await ensureRedisAccess(params.redisId, ctx);
		if (!redis) {
			return {
				success: false,
				message: "Redis access denied",
			};
		}
		await removeRedisById(params.redisId);
		return {
			success: true,
			message: "Redis database deleted successfully",
			data: { deleted: true },
		};
	},
};

export function registerRedisTools() {
	toolRegistry.register(listRedisDatabases);
	toolRegistry.register(getRedisDetails);
	toolRegistry.register(createRedisDatabase);
	toolRegistry.register(deployRedisDatabase);
	toolRegistry.register(deleteRedisDatabase);
}
