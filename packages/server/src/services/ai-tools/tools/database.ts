import { db } from "@dokploy/server/db";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type DatabaseKind = "postgres" | "mysql" | "mariadb" | "mongo" | "redis";

const listDatabases: Tool<
	{ projectId?: string },
	Array<{
		type: DatabaseKind;
		databaseId: string;
		name: string;
		status: string;
		databaseName?: string;
		databaseUser?: string;
	}>
> = {
	name: "database_list",
	description:
		"List all database services (PostgreSQL/MySQL/MariaDB/MongoDB/Redis) in the organization. Optionally filter by project.",
	category: "database",
	aliases: [
		"database list",
		"list databases",
		"databases",
		"db list",
		"数据库列表",
		"查看数据库",
		"数据库",
	],
	tags: ["database", "db", "list", "数据库", "列表"],
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const shouldInclude = (row: {
			environment?: { project?: { organizationId?: string; projectId?: string } | null } | null;
		}) => {
			if (row.environment?.project?.organizationId !== ctx.organizationId) return false;
			if (params.projectId && row.environment?.project?.projectId !== params.projectId)
				return false;
			return true;
		};

		const [postgres, mysql, mariadb, mongo, redis] = await Promise.all([
			db.query.postgres.findMany({
				with: { environment: { with: { project: true } } },
			}),
			db.query.mysql.findMany({
				with: { environment: { with: { project: true } } },
			}),
			db.query.mariadb.findMany({
				with: { environment: { with: { project: true } } },
			}),
			db.query.mongo.findMany({
				with: { environment: { with: { project: true } } },
			}),
			db.query.redis.findMany({
				with: { environment: { with: { project: true } } },
			}),
		]);

		const out: Array<{
			type: DatabaseKind;
			databaseId: string;
			name: string;
			status: string;
			databaseName?: string;
			databaseUser?: string;
		}> = [];

		for (const d of postgres.filter(shouldInclude)) {
			out.push({
				type: "postgres",
				databaseId: d.postgresId,
				name: d.name,
				status: d.applicationStatus || "idle",
				databaseName: d.databaseName,
				databaseUser: d.databaseUser,
			});
		}
		for (const d of mysql.filter(shouldInclude)) {
			out.push({
				type: "mysql",
				databaseId: d.mysqlId,
				name: d.name,
				status: d.applicationStatus || "idle",
				databaseName: d.databaseName,
				databaseUser: d.databaseUser,
			});
		}
		for (const d of mariadb.filter(shouldInclude)) {
			out.push({
				type: "mariadb",
				databaseId: d.mariadbId,
				name: d.name,
				status: d.applicationStatus || "idle",
				databaseName: d.databaseName,
				databaseUser: d.databaseUser,
			});
		}
		for (const d of mongo.filter(shouldInclude)) {
			out.push({
				type: "mongo",
				databaseId: d.mongoId,
				name: d.name,
				status: d.applicationStatus || "idle",
				databaseUser: d.databaseUser,
			});
		}
		for (const d of redis.filter(shouldInclude)) {
			out.push({
				type: "redis",
				databaseId: d.redisId,
				name: d.name,
				status: d.applicationStatus || "idle",
			});
		}

		return {
			success: true,
			message: `Found ${out.length} database(s)`,
			data: out,
		};
	},
};

export function registerDatabaseTools() {
	toolRegistry.register(listDatabases);
}
