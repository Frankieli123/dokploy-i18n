import { z } from "zod";
import { getContainersByAppLabel } from "@dokploy/server/services/docker";
import { findMariadbById } from "@dokploy/server/services/mariadb";
import { findMySqlById } from "@dokploy/server/services/mysql";
import { findPostgresById } from "@dokploy/server/services/postgres";
import { checkServiceAccess } from "@dokploy/server/services/user";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

function shQuote(value: string): string {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function clampMaxChars(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1000, Math.min(200_000, Math.floor(n)));
}

function truncateText(text: string, maxChars: number): {
	text: string;
	truncated: boolean;
} {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

async function execOnServer(
	serverId: string | null | undefined,
	command: string,
): Promise<{ stdout: string; stderr: string }> {
	return serverId ? await execAsyncRemote(serverId, command) : await execAsync(command);
}

async function resolveContainerId(params: {
	appName: string;
	serverId?: string | null;
}): Promise<string> {
	const serverId = params.serverId ?? undefined;
	const swarm =
		(await getContainersByAppLabel(params.appName, "swarm", serverId)) ?? [];
	const runningSwarm = swarm.find((c) => String(c.state ?? "").toLowerCase() === "running");
	if (runningSwarm?.containerId) return runningSwarm.containerId;
	if (swarm[0]?.containerId) return swarm[0].containerId;

	const standalone =
		(await getContainersByAppLabel(params.appName, "standalone", serverId)) ?? [];
	const runningStandalone = standalone.find(
		(c) => String(c.state ?? "").toLowerCase() === "running",
	);
	if (runningStandalone?.containerId) return runningStandalone.containerId;
	if (standalone[0]?.containerId) return standalone[0].containerId;

	throw new Error(`No running container found for app "${params.appName}"`);
}

const databaseSqlExecute: Tool<
	{
		dbType: "postgres" | "mysql" | "mariadb";
		dbId: string;
		sql: string;
		database?: string;
		useRoot?: boolean;
		maxOutputChars?: number;
	},
	{
		dbType: string;
		dbId: string;
		appName: string;
		serverId: string | null;
		containerId: string;
		stdout: string;
		stderr: string;
		truncated: boolean;
	}
> = {
	name: "database_sql_execute",
	aliases: ["sql_execute", "execute_sql", "run_sql", "db_sql_execute"],
	description:
		"Execute raw SQL inside a managed database container (Postgres/MySQL/MariaDB). Extremely dangerous: can modify or destroy data.",
	category: "database",
	tags: [
		"sql",
		"query",
		"ddl",
		"dml",
		"postgres",
		"mysql",
		"mariadb",
		"execute",
		"database",
		"table",
		"schema",
		"数据库",
		"表",
		"改表",
	],
	parameters: z
		.object({
			dbType: z.enum(["postgres", "mysql", "mariadb"]),
			dbId: z.string().min(1).describe("Database service ID (e.g. postgresId/mysqlId/mariadbId)"),
			sql: z.string().min(1).max(200_000).describe("SQL to execute"),
			database: z.string().min(1).optional().describe("Override target database name"),
			useRoot: z
				.boolean()
				.optional()
				.default(false)
				.describe("MySQL/MariaDB only: connect as root"),
			maxOutputChars: z.number().min(1000).max(200_000).optional().default(20_000),
		})
		.refine((v) => (v.dbType === "postgres" ? v.useRoot === false : true), {
			message: "useRoot is only supported for MySQL/MariaDB",
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const dbId = params.dbId.trim();
		try {
			await checkServiceAccess(ctx.userId, dbId, ctx.organizationId, "access");
		} catch (error) {
			return {
				success: false,
				message: "Permission denied",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const maxOutputChars = clampMaxChars(params.maxOutputChars, 20_000);

		type Resolved = {
			dbType: "postgres" | "mysql" | "mariadb";
			appName: string;
			serverId: string | null;
			script: string;
		};

		let resolved: Resolved;
		try {
			resolved = await (async () => {
				if (params.dbType === "postgres") {
					const svc = await findPostgresById(dbId);
					if (svc.environment.project.organizationId !== ctx.organizationId) {
						throw new Error("Permission denied");
					}
					return {
						dbType: "postgres" as const,
						appName: svc.appName,
						serverId: svc.serverId ?? null,
						script:
							`set -e; ` +
							`SQL=${shQuote(params.sql)}; ` +
							`DB=${params.database ? shQuote(params.database.trim()) : '"$POSTGRES_DB"'}; ` +
							`PGPASSWORD=\"$POSTGRES_PASSWORD\" ` +
							`psql -h localhost -U \"$POSTGRES_USER\" -d \"$DB\" ` +
							`-v ON_ERROR_STOP=1 -X -P pager=off -c \"$SQL\"`,
					};
				}

				if (params.dbType === "mysql") {
					const svc = await findMySqlById(dbId);
					if (svc.environment.project.organizationId !== ctx.organizationId) {
						throw new Error("Permission denied");
					}
					const useRoot = params.useRoot === true || svc.databaseUser === "root";
					const dbExpr = params.database
						? shQuote(params.database.trim())
						: '"$MYSQL_DATABASE"';
					const userExpr = useRoot ? '"root"' : '"$MYSQL_USER"';
					const passExpr = useRoot
						? '"$MYSQL_ROOT_PASSWORD"'
						: '"$MYSQL_PASSWORD"';
					const script =
						`set -e; ` +
						`SQL=${shQuote(params.sql)}; ` +
						`DB=${dbExpr}; ` +
						`USER=${userExpr}; ` +
						`PASS=${passExpr}; ` +
						`MYSQL_PWD=\"$PASS\" mysql -u \"$USER\" --database=\"$DB\" -e \"$SQL\"`;
					return {
						dbType: "mysql" as const,
						appName: svc.appName,
						serverId: svc.serverId ?? null,
						script,
					};
				}

				const svc = await findMariadbById(dbId);
				if (svc.environment.project.organizationId !== ctx.organizationId) {
					throw new Error("Permission denied");
				}
				const useRoot = params.useRoot === true || svc.databaseUser === "root";
				const dbExpr = params.database
					? shQuote(params.database.trim())
					: '"$MARIADB_DATABASE"';
				const userExpr = useRoot ? '"root"' : '"$MARIADB_USER"';
				const passExpr = useRoot
					? '"$MARIADB_ROOT_PASSWORD"'
					: '"$MARIADB_PASSWORD"';
				const script =
					`set -e; ` +
					`SQL=${shQuote(params.sql)}; ` +
					`DB=${dbExpr}; ` +
					`USER=${userExpr}; ` +
					`PASS=${passExpr}; ` +
					`MYSQL_PWD=\"$PASS\" mysql -u \"$USER\" --database=\"$DB\" -e \"$SQL\"`;
				return {
					dbType: "mariadb" as const,
					appName: svc.appName,
					serverId: svc.serverId ?? null,
					script,
				};
			})();
		} catch (error) {
			return {
				success: false,
				message: "Database service not found or type mismatch",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		let containerId = "";
		try {
			containerId = await resolveContainerId({
				appName: resolved.appName,
				serverId: resolved.serverId,
			});
		} catch (error) {
			return {
				success: false,
				message: "Database container not found (is the service running?)",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const cmd = `docker exec -i ${shQuote(containerId)} sh -lc ${shQuote(resolved.script)}`;

		try {
			const { stdout, stderr } = await execOnServer(resolved.serverId, cmd);
			const out = truncateText(stdout ?? "", maxOutputChars);
			const err = truncateText(stderr ?? "", maxOutputChars);
			return {
				success: true,
				message: `SQL executed on ${resolved.dbType} service "${dbId}"`,
				data: {
					dbType: resolved.dbType,
					dbId,
					appName: resolved.appName,
					serverId: resolved.serverId,
					containerId,
					stdout: out.text,
					stderr: err.text,
					truncated: out.truncated || err.truncated,
				},
			};
		} catch (error) {
			if (error instanceof ExecError) {
				const out = truncateText(error.stdout ?? "", maxOutputChars);
				const err = truncateText(error.stderr ?? "", maxOutputChars);
				return {
					success: false,
					message: "SQL execution failed",
					error: error.message,
					data: {
						dbType: resolved.dbType,
						dbId,
						appName: resolved.appName,
						serverId: resolved.serverId,
						containerId,
						stdout: out.text,
						stderr: err.text,
						truncated: out.truncated || err.truncated,
					},
				};
			}
			return {
				success: false,
				message: "SQL execution failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

export function registerSqlTools() {
	toolRegistry.register(databaseSqlExecute);
}
