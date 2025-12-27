import { db } from "@dokploy/server/db";
import {
	createMariadb,
	deployMariadb,
	findMariadbById,
	removeMariadbById,
} from "@dokploy/server/services/mariadb";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { generatePassword } from "@dokploy/server/templates";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const ensureMariadbAccess = async (
	mariadbId: string,
	ctx: { organizationId: string },
) => {
	const mdb = await findMariadbById(mariadbId);
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

const listMariadbDatabases: Tool<
	{ projectId?: string },
	Array<{
		mariadbId: string;
		name: string;
		status: string;
		databaseName: string;
	}>
> = {
	name: "mariadb_list",
	description:
		"List all MariaDB databases in the organization. Optionally filter by project.",
	category: "database",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const databases = await db.query.mariadb.findMany({
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
			message: `Found ${filtered.length} MariaDB database(s)`,
			data: filtered.map((d) => ({
				mariadbId: d.mariadbId,
				name: d.name,
				status: d.applicationStatus || "idle",
				databaseName: d.databaseName,
			})),
		};
	},
};

const getMariadbDetails: Tool<
	{ mariadbId: string },
	{
		mariadbId: string;
		name: string;
		status: string;
		databaseName: string;
		databaseUser: string;
		dockerImage: string;
	}
> = {
	name: "mariadb_get",
	description: "Get details of a specific MariaDB database by ID",
	category: "database",
	parameters: z.object({
		mariadbId: z.string().describe("The MariaDB database ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const mdb = await ensureMariadbAccess(params.mariadbId, ctx);
		if (!mdb) {
			return {
				success: false,
				message: "MariaDB access denied",
			};
		}
		return {
			success: true,
			message: `MariaDB "${mdb.name}" details retrieved`,
			data: {
				mariadbId: mdb.mariadbId,
				name: mdb.name,
				status: mdb.applicationStatus || "idle",
				databaseName: mdb.databaseName,
				databaseUser: mdb.databaseUser,
				dockerImage: mdb.dockerImage,
			},
		};
	},
};

const createMariadbDatabase: Tool<
	{
		name: string;
		appName: string;
		databaseName: string;
		databaseUser: string;
		environmentId: string;
		databasePassword?: string;
		databaseRootPassword?: string;
		dockerImage?: string;
		description?: string;
		serverId?: string;
	},
	{ mariadbId: string; name: string }
> = {
	name: "mariadb_create",
	description: "Create a new MariaDB database. Requires environment ID.",
	category: "database",
	parameters: z.object({
		name: z.string().describe("Display name for the database"),
		appName: z.string().describe("Unique app name (used in container naming)"),
		databaseName: z.string().describe("MariaDB database name"),
		databaseUser: z.string().describe("MariaDB username"),
		environmentId: z.string().describe("Environment ID to create database in"),
		databasePassword: z
			.string()
			.optional()
			.describe("MariaDB user password (auto-generated if omitted)"),
		databaseRootPassword: z
			.string()
			.optional()
			.describe("MariaDB root password (auto-generated if omitted)"),
		dockerImage: z
			.string()
			.optional()
			.default("mariadb:11")
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

		const newDb = await createMariadb({
			name: params.name,
			appName: params.appName,
			databaseName: params.databaseName,
			databaseUser: params.databaseUser,
			environmentId: params.environmentId,
			databasePassword: params.databasePassword ?? generatePassword(),
			databaseRootPassword: params.databaseRootPassword ?? generatePassword(),
			dockerImage: params.dockerImage || "mariadb:11",
			description: params.description ?? null,
			serverId: params.serverId ?? ctx.serverId ?? null,
		});

		return {
			success: true,
			message: `MariaDB database "${newDb.name}" created successfully`,
			data: {
				mariadbId: newDb.mariadbId,
				name: newDb.name,
			},
		};
	},
};

const deployMariadbDatabase: Tool<
	{ mariadbId: string },
	{ mariadbId: string; status: string }
> = {
	name: "mariadb_deploy",
	description: "Deploy/start a MariaDB database",
	category: "database",
	parameters: z.object({
		mariadbId: z.string().describe("The MariaDB database ID to deploy"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const mdbAccess = await ensureMariadbAccess(params.mariadbId, ctx);
		if (!mdbAccess) {
			return {
				success: false,
				message: "MariaDB access denied",
			};
		}
		const mdb = await deployMariadb(params.mariadbId);
		return {
			success: true,
			message: `MariaDB "${mdb.name}" deployed successfully`,
			data: {
				mariadbId: mdb.mariadbId,
				status: "done",
			},
		};
	},
};

const deleteMariadbDatabase: Tool<{ mariadbId: string }, { deleted: boolean }> =
	{
		name: "mariadb_delete",
		description: "Delete a MariaDB database. This action is irreversible!",
		category: "database",
		parameters: z.object({
			mariadbId: z.string().describe("The MariaDB database ID to delete"),
		}),
		riskLevel: "high",
		requiresApproval: true,
		execute: async (params, ctx) => {
			const mdb = await ensureMariadbAccess(params.mariadbId, ctx);
			if (!mdb) {
				return {
					success: false,
					message: "MariaDB access denied",
				};
			}
			await removeMariadbById(params.mariadbId);
			return {
				success: true,
				message: "MariaDB database deleted successfully",
				data: { deleted: true },
			};
		},
	};

export function registerMariadbTools() {
	toolRegistry.register(listMariadbDatabases);
	toolRegistry.register(getMariadbDetails);
	toolRegistry.register(createMariadbDatabase);
	toolRegistry.register(deployMariadbDatabase);
	toolRegistry.register(deleteMariadbDatabase);
}
