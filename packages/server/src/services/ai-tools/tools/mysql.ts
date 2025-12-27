import { db } from "@dokploy/server/db";
import {
	createMysql,
	deployMySql,
	findMySqlById,
	removeMySqlById,
} from "@dokploy/server/services/mysql";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { generatePassword } from "@dokploy/server/templates";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const ensureMysqlAccess = async (
	mysqlId: string,
	ctx: { organizationId: string },
) => {
	const mysql = await findMySqlById(mysqlId);
	if (mysql.environment?.project?.organizationId !== ctx.organizationId) {
		return null;
	}
	return mysql;
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

const listMysqlDatabases: Tool<
	{ projectId?: string },
	Array<{ mysqlId: string; name: string; status: string; databaseName: string }>
> = {
	name: "mysql_list",
	description:
		"List all MySQL databases in the organization. Optionally filter by project.",
	category: "database",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const databases = await db.query.mysql.findMany({
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
			message: `Found ${filtered.length} MySQL database(s)`,
			data: filtered.map((d) => ({
				mysqlId: d.mysqlId,
				name: d.name,
				status: d.applicationStatus || "idle",
				databaseName: d.databaseName,
			})),
		};
	},
};

const getMysqlDetails: Tool<
	{ mysqlId: string },
	{
		mysqlId: string;
		name: string;
		status: string;
		databaseName: string;
		databaseUser: string;
		dockerImage: string;
	}
> = {
	name: "mysql_get",
	description: "Get details of a specific MySQL database by ID",
	category: "database",
	parameters: z.object({
		mysqlId: z.string().describe("The MySQL database ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const mysql = await ensureMysqlAccess(params.mysqlId, ctx);
		if (!mysql) {
			return {
				success: false,
				message: "MySQL access denied",
			};
		}
		return {
			success: true,
			message: `MySQL "${mysql.name}" details retrieved`,
			data: {
				mysqlId: mysql.mysqlId,
				name: mysql.name,
				status: mysql.applicationStatus || "idle",
				databaseName: mysql.databaseName,
				databaseUser: mysql.databaseUser,
				dockerImage: mysql.dockerImage,
			},
		};
	},
};

const createMysqlDatabase: Tool<
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
	{ mysqlId: string; name: string }
> = {
	name: "mysql_create",
	description: "Create a new MySQL database. Requires environment ID.",
	category: "database",
	parameters: z.object({
		name: z.string().describe("Display name for the database"),
		appName: z.string().describe("Unique app name (used in container naming)"),
		databaseName: z.string().describe("MySQL database name"),
		databaseUser: z.string().describe("MySQL username"),
		environmentId: z.string().describe("Environment ID to create database in"),
		databasePassword: z
			.string()
			.optional()
			.describe("MySQL user password (auto-generated if omitted)"),
		databaseRootPassword: z
			.string()
			.optional()
			.describe("MySQL root password (auto-generated if omitted)"),
		dockerImage: z
			.string()
			.optional()
			.default("mysql:8")
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

		const newDb = await createMysql({
			name: params.name,
			appName: params.appName,
			databaseName: params.databaseName,
			databaseUser: params.databaseUser,
			environmentId: params.environmentId,
			databasePassword: params.databasePassword ?? generatePassword(),
			databaseRootPassword: params.databaseRootPassword ?? generatePassword(),
			dockerImage: params.dockerImage || "mysql:8",
			description: params.description ?? null,
			serverId: params.serverId ?? ctx.serverId ?? null,
		});

		return {
			success: true,
			message: `MySQL database "${newDb.name}" created successfully`,
			data: {
				mysqlId: newDb.mysqlId,
				name: newDb.name,
			},
		};
	},
};

const deployMysqlDatabase: Tool<
	{ mysqlId: string },
	{ mysqlId: string; status: string }
> = {
	name: "mysql_deploy",
	description: "Deploy/start a MySQL database",
	category: "database",
	parameters: z.object({
		mysqlId: z.string().describe("The MySQL database ID to deploy"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const mysqlAccess = await ensureMysqlAccess(params.mysqlId, ctx);
		if (!mysqlAccess) {
			return {
				success: false,
				message: "MySQL access denied",
			};
		}
		const mysql = await deployMySql(params.mysqlId);
		return {
			success: true,
			message: `MySQL "${mysql.name}" deployed successfully`,
			data: {
				mysqlId: mysql.mysqlId,
				status: "done",
			},
		};
	},
};

const deleteMysqlDatabase: Tool<{ mysqlId: string }, { deleted: boolean }> = {
	name: "mysql_delete",
	description: "Delete a MySQL database. This action is irreversible!",
	category: "database",
	parameters: z.object({
		mysqlId: z.string().describe("The MySQL database ID to delete"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const mysql = await ensureMysqlAccess(params.mysqlId, ctx);
		if (!mysql) {
			return {
				success: false,
				message: "MySQL access denied",
			};
		}
		await removeMySqlById(params.mysqlId);
		return {
			success: true,
			message: "MySQL database deleted successfully",
			data: { deleted: true },
		};
	},
};

export function registerMysqlTools() {
	toolRegistry.register(listMysqlDatabases);
	toolRegistry.register(getMysqlDetails);
	toolRegistry.register(createMysqlDatabase);
	toolRegistry.register(deployMysqlDatabase);
	toolRegistry.register(deleteMysqlDatabase);
}
