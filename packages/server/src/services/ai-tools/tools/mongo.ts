import { db } from "@dokploy/server/db";
import {
	createMongo,
	deployMongo,
	findMongoById,
	removeMongoById,
} from "@dokploy/server/services/mongo";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { generatePassword } from "@dokploy/server/templates";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const ensureMongoAccess = async (
	mongoId: string,
	ctx: { organizationId: string },
) => {
	const mdb = await findMongoById(mongoId);
	if (mdb.environment?.project?.organizationId !== ctx.organizationId) {
		return null;
	}
	return mdb;
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

const listMongoDatabases: Tool<
	{ projectId?: string },
	Array<{
		mongoId: string;
		name: string;
		status: string;
		databaseUser: string;
		replicaSets: boolean;
	}>
> = {
	name: "mongo_list",
	description:
		"List all MongoDB databases in the organization. Optionally filter by project.",
	category: "database",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const databases = await db.query.mongo.findMany({
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
			message: `Found ${filtered.length} MongoDB database(s)`,
			data: filtered.map((d) => ({
				mongoId: d.mongoId,
				name: d.name,
				status: d.applicationStatus || "idle",
				databaseUser: d.databaseUser,
				replicaSets: d.replicaSets ?? false,
			})),
		};
	},
};

const getMongoDetails: Tool<
	{ mongoId: string },
	{
		mongoId: string;
		name: string;
		status: string;
		databaseUser: string;
		replicaSets: boolean;
		dockerImage: string;
	}
> = {
	name: "mongo_get",
	description: "Get details of a specific MongoDB database by ID",
	category: "database",
	parameters: z.object({
		mongoId: z.string().describe("The MongoDB database ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const mdb = await ensureMongoAccess(params.mongoId, ctx);
		if (!mdb) {
			return {
				success: false,
				message: "MongoDB access denied",
			};
		}
		return {
			success: true,
			message: `MongoDB "${mdb.name}" details retrieved`,
			data: {
				mongoId: mdb.mongoId,
				name: mdb.name,
				status: mdb.applicationStatus || "idle",
				databaseUser: mdb.databaseUser,
				replicaSets: mdb.replicaSets ?? false,
				dockerImage: mdb.dockerImage,
			},
		};
	},
};

const createMongoDatabase: Tool<
	{
		name: string;
		appName: string;
		databaseUser: string;
		environmentId: string;
		databasePassword?: string;
		replicaSets?: boolean;
		dockerImage?: string;
		description?: string;
		serverId?: string;
	},
	{ mongoId: string; name: string }
> = {
	name: "mongo_create",
	description: "Create a new MongoDB database. Requires environment ID.",
	category: "database",
	parameters: z.object({
		name: z.string().describe("Display name for the database"),
		appName: z.string().describe("Unique app name (used in container naming)"),
		databaseUser: z.string().describe("MongoDB root username"),
		environmentId: z.string().describe("Environment ID to create database in"),
		databasePassword: z
			.string()
			.optional()
			.describe("MongoDB root password (auto-generated if omitted)"),
		replicaSets: z
			.boolean()
			.optional()
			.default(false)
			.describe("Enable single-node replica set"),
		dockerImage: z
			.string()
			.optional()
			.default("mongo:7")
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

		const newDb = await createMongo({
			name: params.name,
			appName: params.appName,
			databaseUser: params.databaseUser,
			environmentId: params.environmentId,
			databasePassword: params.databasePassword ?? generatePassword(),
			replicaSets: params.replicaSets ?? false,
			dockerImage: params.dockerImage || "mongo:7",
			description: params.description ?? null,
			serverId: params.serverId ?? ctx.serverId ?? null,
		});

		return {
			success: true,
			message: `MongoDB database "${newDb.name}" created successfully`,
			data: {
				mongoId: newDb.mongoId,
				name: newDb.name,
			},
		};
	},
};

const deployMongoDatabase: Tool<
	{ mongoId: string },
	{ mongoId: string; status: string }
> = {
	name: "mongo_deploy",
	description: "Deploy/start a MongoDB database",
	category: "database",
	parameters: z.object({
		mongoId: z.string().describe("The MongoDB database ID to deploy"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const mdbAccess = await ensureMongoAccess(params.mongoId, ctx);
		if (!mdbAccess) {
			return {
				success: false,
				message: "MongoDB access denied",
			};
		}
		const mdb = await deployMongo(params.mongoId);
		return {
			success: true,
			message: `MongoDB "${mdb.name}" deployed successfully`,
			data: {
				mongoId: mdb.mongoId,
				status: "done",
			},
		};
	},
};

const deleteMongoDatabase: Tool<{ mongoId: string }, { deleted: boolean }> = {
	name: "mongo_delete",
	description: "Delete a MongoDB database. This action is irreversible!",
	category: "database",
	parameters: z.object({
		mongoId: z.string().describe("The MongoDB database ID to delete"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const mdb = await ensureMongoAccess(params.mongoId, ctx);
		if (!mdb) {
			return {
				success: false,
				message: "MongoDB access denied",
			};
		}
		await removeMongoById(params.mongoId);
		return {
			success: true,
			message: "MongoDB database deleted successfully",
			data: { deleted: true },
		};
	},
};

export function registerMongoTools() {
	toolRegistry.register(listMongoDatabases);
	toolRegistry.register(getMongoDetails);
	toolRegistry.register(createMongoDatabase);
	toolRegistry.register(deployMongoDatabase);
	toolRegistry.register(deleteMongoDatabase);
}
