import { db } from "@dokploy/server/db";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { findDestinationById } from "@dokploy/server/services/destination";
import {
	createPostgres,
	deployPostgres,
	findPostgresById,
	removePostgresById,
} from "@dokploy/server/services/postgres";
import { generatePassword } from "@dokploy/server/templates";

import {
	getS3Credentials,
	getServiceContainerCommand,
	normalizeS3Path,
} from "@dokploy/server/utils/backups/utils";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const shSingleQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const containsPsqlMetaCommand = (sql: string) => /^\s*\\/m.test(sql);

const truncateString = (value: string, maxChars: number) => {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n...(truncated to ${maxChars} chars)`;
};

const execOnServer = async (
	serverId: string | null | undefined,
	command: string,
	onData?: (data: string) => void,
) => {
	if (serverId) {
		return execAsyncRemote(serverId, command, onData);
	}
	return execAsync(command, { shell: "/bin/bash" });
};

const ensurePostgresAccess = async (
	postgresId: string,
	ctx: { organizationId: string },
) => {
	const pg = await findPostgresById(postgresId);
	if (
		ctx.organizationId &&
		pg.environment?.project?.organizationId !== ctx.organizationId
	) {
		return null;
	}
	return pg;
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

const buildDockerExecPsqlCommand = (opts: {
	appName: string;
	databaseUser: string;
	databasePassword: string;
	databaseName: string;
	sqlScript: string;
	psqlExtraFlags?: string;
}) => {
	const sqlB64 = Buffer.from(opts.sqlScript, "utf-8").toString("base64");
	const containerSearch = getServiceContainerCommand(opts.appName);
	const psqlExtraFlags = opts.psqlExtraFlags ?? "";

	return `
\tset -eo pipefail;
\tCONTAINER_ID=$(${containerSearch});
	if [ -z "$CONTAINER_ID" ]; then
		echo "Error: Container not found for service ${opts.appName}" 1>&2;
		exit 1;
	fi

	SQL_B64=${shSingleQuote(sqlB64)};
	printf %s "$SQL_B64" | base64 -d | docker exec -i \\
		-e PGPASSWORD=${shSingleQuote(opts.databasePassword)} \\
		"$CONTAINER_ID" psql -X -v ON_ERROR_STOP=1 -P pager=off -P footer=off ${psqlExtraFlags} \\
		-U ${shSingleQuote(opts.databaseUser)} -d ${shSingleQuote(opts.databaseName)} -f -
`;
};

const normalizeSql = (sql: string) => sql.trim();

const isReadOnlySql = (sql: string) => {
	const s = sql.trim().toLowerCase();
	if (
		s.startsWith("select") ||
		s.startsWith("with") ||
		s.startsWith("explain") ||
		s.startsWith("show")
	)
		return true;
	return false;
};

const isDmlSql = (sql: string) => {
	const s = sql.trim().toLowerCase();
	if (
		s.startsWith("insert") ||
		s.startsWith("update") ||
		s.startsWith("delete")
	) {
		return true;
	}
	if (s.startsWith("with")) {
		return /\b(insert|update|delete)\b/i.test(s);
	}
	return false;
};

const looksLikeSingleStatement = (sql: string) => {
	const trimmed = sql.trim();
	const semicolons = (trimmed.match(/;/g) || []).length;
	if (semicolons === 0) return true;
	if (semicolons === 1 && trimmed.endsWith(";")) return true;
	return false;
};

const listPostgresDatabases: Tool<
	{ projectId?: string },
	Array<{
		postgresId: string;
		name: string;
		status: string;
		databaseName: string;
	}>
> = {
	name: "postgres_list",
	description:
		"List all PostgreSQL databases in the organization. Optionally filter by project.",
	category: "database",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const databases = await db.query.postgres.findMany({
			with: {
				environment: {
					with: { project: true },
				},
			},
		});

		const filtered = databases
			.filter((d) => {
				if (params.projectId && d.environment?.projectId !== params.projectId)
					return false;
				return true;
			})
			.filter(
				(d) => d.environment?.project?.organizationId === ctx.organizationId,
			);

		return {
			success: true,
			message: `Found ${filtered.length} PostgreSQL database(s)`,
			data: filtered.map((db) => ({
				postgresId: db.postgresId,
				name: db.name,
				status: db.applicationStatus || "idle",
				databaseName: db.databaseName,
			})),
		};
	},
};

const postgresSqlQuery: Tool<
	{
		postgresId: string;
		databaseName?: string;
		sql: string;
		maxRows?: number;
		statementTimeoutMs?: number;
		maxOutputChars?: number;
	},
	{ stdout: string; stderr: string }
> = {
	name: "postgres_sql_query",
	description:
		"Execute a read-only SQL query (SELECT/WITH/EXPLAIN/SHOW) against a PostgreSQL database",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database service ID"),
		databaseName: z
			.string()
			.optional()
			.describe("Target database name inside the Postgres instance"),
		sql: z.string().min(1).describe("Read-only SQL query"),
		maxRows: z
			.number()
			.int()
			.positive()
			.max(5000)
			.optional()
			.default(200)
			.describe("Maximum rows to return (best effort)"),
		statementTimeoutMs: z
			.number()
			.int()
			.positive()
			.max(600000)
			.optional()
			.default(10000)
			.describe("Statement timeout in milliseconds"),
		maxOutputChars: z
			.number()
			.int()
			.positive()
			.max(200000)
			.optional()
			.default(20000)
			.describe("Maximum stdout+stderr chars returned"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pg) {
			return {
				success: false,
				message: "Postgres access denied",
			};
		}

		const sql = normalizeSql(params.sql);
		if (!isReadOnlySql(sql)) {
			return {
				success: false,
				message:
					"Only read-only queries are allowed in postgres_sql_query (SELECT/WITH/EXPLAIN/SHOW)",
			};
		}
		if (containsPsqlMetaCommand(sql)) {
			return {
				success: false,
				message: "psql meta-commands (\\...) are not allowed",
			};
		}

		let finalSql = sql;
		if (looksLikeSingleStatement(finalSql)) {
			const lower = finalSql.toLowerCase();
			if (
				(lower.startsWith("select") || lower.startsWith("with")) &&
				!/\blimit\b/i.test(lower)
			) {
				finalSql = `${finalSql.replace(/;\s*$/, "")} LIMIT ${params.maxRows};`;
			}
		}
		if (!finalSql.trim().endsWith(";")) finalSql = `${finalSql};`;

		const script = `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '${params.statementTimeoutMs}ms';\n${finalSql}\nROLLBACK;\n`;
		const cmd = buildDockerExecPsqlCommand({
			appName: pg.appName,
			databaseUser: pg.databaseUser,
			databasePassword: pg.databasePassword,
			databaseName: params.databaseName ?? pg.databaseName,
			sqlScript: script,
			psqlExtraFlags: "-P format=unaligned -P tuples_only=on",
		});
		const maxOutputChars = params.maxOutputChars ?? 20000;

		try {
			const { stdout, stderr } = await execOnServer(pg.serverId, cmd);
			const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`;
			return {
				success: true,
				message: "Query executed successfully",
				data: {
					stdout: truncateString(stdout, maxOutputChars),
					stderr: truncateString(stderr, maxOutputChars),
				},
				...(combined.length > maxOutputChars
					? { message: "Query executed successfully (output truncated)" }
					: {}),
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Query execution failed",
				error: errorMessage,
			};
		}
	},
};

const postgresSqlExecuteDml: Tool<
	{
		postgresId: string;
		databaseName?: string;
		sql: string;
		useTransaction?: boolean;
		statementTimeoutMs?: number;
		maxOutputChars?: number;
	},
	{ stdout: string; stderr: string }
> = {
	name: "postgres_sql_execute_dml",
	description:
		"Execute DML statements (INSERT/UPDATE/DELETE) against a PostgreSQL database",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database service ID"),
		databaseName: z
			.string()
			.optional()
			.describe("Target database name inside the Postgres instance"),
		sql: z
			.string()
			.min(1)
			.describe("DML SQL statement(s): INSERT/UPDATE/DELETE"),
		useTransaction: z
			.boolean()
			.optional()
			.default(true)
			.describe("Wrap the execution in a transaction"),
		statementTimeoutMs: z
			.number()
			.int()
			.positive()
			.max(600000)
			.optional()
			.default(60000)
			.describe("Statement timeout in milliseconds"),
		maxOutputChars: z
			.number()
			.int()
			.positive()
			.max(200000)
			.optional()
			.default(20000)
			.describe("Maximum stdout+stderr chars returned"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pg) {
			return {
				success: false,
				message: "Postgres access denied",
			};
		}

		const sql = normalizeSql(params.sql);
		if (containsPsqlMetaCommand(sql)) {
			return {
				success: false,
				message: "psql meta-commands (\\...) are not allowed",
			};
		}
		if (!isDmlSql(sql)) {
			return {
				success: false,
				message:
					"Only DML statements are allowed in postgres_sql_execute_dml (INSERT/UPDATE/DELETE). Use postgres_sql_execute_admin for DDL/admin.",
			};
		}

		let finalSql = sql;
		if (!finalSql.trim().endsWith(";")) finalSql = `${finalSql};`;

		const script = params.useTransaction
			? `BEGIN;\nSET LOCAL statement_timeout = '${params.statementTimeoutMs}ms';\n${finalSql}\nCOMMIT;\n`
			: `SET statement_timeout = '${params.statementTimeoutMs}ms';\n${finalSql}\n`;

		const cmd = buildDockerExecPsqlCommand({
			appName: pg.appName,
			databaseUser: pg.databaseUser,
			databasePassword: pg.databasePassword,
			databaseName: params.databaseName ?? pg.databaseName,
			sqlScript: script,
			psqlExtraFlags: "-P format=unaligned",
		});
		const maxOutputChars = params.maxOutputChars ?? 20000;

		try {
			const { stdout, stderr } = await execOnServer(pg.serverId, cmd);
			const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`;
			return {
				success: true,
				message: "DML executed successfully",
				data: {
					stdout: truncateString(stdout, maxOutputChars),
					stderr: truncateString(stderr, maxOutputChars),
				},
				...(combined.length > maxOutputChars
					? { message: "DML executed successfully (output truncated)" }
					: {}),
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "DML execution failed",
				error: errorMessage,
			};
		}
	},
};

const postgresSqlExecuteAdmin: Tool<
	{
		postgresId: string;
		databaseName?: string;
		sql: string;
		statementTimeoutMs?: number;
		maxOutputChars?: number;
	},
	{ stdout: string; stderr: string }
> = {
	name: "postgres_sql_execute_admin",
	description:
		"Execute arbitrary SQL (DDL, roles, grants, maintenance). This is high-risk and requires approval.",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database service ID"),
		databaseName: z
			.string()
			.optional()
			.describe("Target database name inside the Postgres instance"),
		sql: z.string().min(1).describe("SQL to execute"),
		statementTimeoutMs: z
			.number()
			.int()
			.positive()
			.max(600000)
			.optional()
			.default(60000)
			.describe("Statement timeout in milliseconds"),
		maxOutputChars: z
			.number()
			.int()
			.positive()
			.max(200000)
			.optional()
			.default(20000)
			.describe("Maximum stdout+stderr chars returned"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pg) {
			return {
				success: false,
				message: "Postgres access denied",
			};
		}

		const sql = normalizeSql(params.sql);
		if (containsPsqlMetaCommand(sql)) {
			return {
				success: false,
				message: "psql meta-commands (\\...) are not allowed",
			};
		}

		let finalSql = sql;
		if (!finalSql.trim().endsWith(";")) finalSql = `${finalSql};`;
		const script = `BEGIN;\nSET LOCAL statement_timeout = '${params.statementTimeoutMs}ms';\n${finalSql}\nCOMMIT;\n`;

		const cmd = buildDockerExecPsqlCommand({
			appName: pg.appName,
			databaseUser: pg.databaseUser,
			databasePassword: pg.databasePassword,
			databaseName: params.databaseName ?? pg.databaseName,
			sqlScript: script,
			psqlExtraFlags: "-P format=unaligned",
		});
		const maxOutputChars = params.maxOutputChars ?? 20000;

		try {
			const { stdout, stderr } = await execOnServer(pg.serverId, cmd);
			const combined = `${stdout}${stderr ? `\n${stderr}` : ""}`;
			return {
				success: true,
				message: "Admin SQL executed successfully",
				data: {
					stdout: truncateString(stdout, maxOutputChars),
					stderr: truncateString(stderr, maxOutputChars),
				},
				...(combined.length > maxOutputChars
					? { message: "Admin SQL executed successfully (output truncated)" }
					: {}),
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Admin SQL execution failed",
				error: errorMessage,
			};
		}
	},
};

const postgresExportS3: Tool<
	{
		postgresId: string;
		destinationId: string;
		prefix?: string;
		databaseName?: string;
	},
	{ backupFile: string }
> = {
	name: "postgres_export_s3",
	description:
		"Export (pg_dump custom format, gzip) a PostgreSQL database to an S3 destination via rclone",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database service ID"),
		destinationId: z.string().describe("Destination ID (S3)"),
		prefix: z
			.string()
			.optional()
			.default("ai-export")
			.describe("S3 key prefix"),
		databaseName: z
			.string()
			.optional()
			.describe("Target database name inside the Postgres instance"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pg) {
			return { success: false, message: "Postgres access denied" };
		}

		const destination = await findDestinationById(params.destinationId);
		if (destination.organizationId !== ctx.organizationId) {
			return { success: false, message: "Destination access denied" };
		}

		const databaseName = params.databaseName ?? pg.databaseName;
		const timestamp = new Date().toISOString();
		const backupFileName = `${timestamp}.sql.gz`;
		const bucketDestination = `${normalizeS3Path(params.prefix || "ai-export")}${pg.postgresId}/${databaseName}/${backupFileName}`;
		const rcloneFlags = getS3Credentials(destination);
		const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
		const containerSearch = getServiceContainerCommand(pg.appName);

		const dockerDump = `docker exec -i -e PGPASSWORD=${shSingleQuote(pg.databasePassword)} "$CONTAINER_ID" bash -lc ${shSingleQuote(
			`set -eo pipefail; PGPASSWORD=${shSingleQuote(pg.databasePassword)} pg_dump -Fc --no-owner --no-acl -h localhost -U ${shSingleQuote(pg.databaseUser)} ${shSingleQuote(databaseName)} | gzip`,
		)}`;

		const cmd = `
			set -eo pipefail;
			CONTAINER_ID=$(${containerSearch});
			if [ -z "$CONTAINER_ID" ]; then
				echo "Error: Container not found for service ${pg.appName}" 1>&2;
				exit 1;
			fi
			${dockerDump} | rclone rcat ${rcloneFlags.join(" ")} ${shSingleQuote(rcloneDestination)}
		`;

		try {
			await execOnServer(pg.serverId, cmd);
			return {
				success: true,
				message: "Export completed successfully",
				data: {
					backupFile: bucketDestination,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Export failed",
				error: errorMessage,
			};
		}
	},
};

const postgresImportS3: Tool<
	{
		postgresId: string;
		destinationId: string;
		backupFile: string;
		databaseName?: string;
	},
	{ restored: boolean }
> = {
	name: "postgres_import_s3",
	description:
		"Restore a PostgreSQL database from an S3 backup file (custom format, gzip). This deletes objects and restores them.",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database service ID"),
		destinationId: z.string().describe("Destination ID (S3)"),
		backupFile: z.string().min(1).describe("S3 key/path of the backup file"),
		databaseName: z
			.string()
			.optional()
			.describe("Target database name inside the Postgres instance"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pg) {
			return { success: false, message: "Postgres access denied" };
		}

		const destination = await findDestinationById(params.destinationId);
		if (destination.organizationId !== ctx.organizationId) {
			return { success: false, message: "Destination access denied" };
		}

		const databaseName = params.databaseName ?? pg.databaseName;
		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;
		const backupPath = `${bucketPath}/${params.backupFile}`;
		const containerSearch = getServiceContainerCommand(pg.appName);

		const cmd = `
			set -eo pipefail;
			CONTAINER_ID=$(${containerSearch});
			if [ -z "$CONTAINER_ID" ]; then
				echo "Error: Container not found for service ${pg.appName}" 1>&2;
				exit 1;
			fi
			rclone cat ${rcloneFlags.join(" ")} ${shSingleQuote(backupPath)} | gunzip | docker exec -i \\
				-e PGPASSWORD=${shSingleQuote(pg.databasePassword)} \\
				"$CONTAINER_ID" pg_restore -e -U ${shSingleQuote(pg.databaseUser)} -d ${shSingleQuote(databaseName)} -O --clean --if-exists --no-owner --no-acl
		`;

		try {
			await execOnServer(pg.serverId, cmd);
			return {
				success: true,
				message: "Restore completed successfully",
				data: { restored: true },
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Restore failed",
				error: errorMessage,
			};
		}
	},
};

const postgresMigrateRemoteToLocal: Tool<
	{
		targetPostgresId: string;
		sourceHost: string;
		sourcePort?: number;
		sourceDatabase: string;
		sourceUser: string;
		sourcePassword: string;
		sslMode?: string;
		includeGlobals?: boolean;
		targetDatabaseName?: string;
	},
	{ migrated: boolean }
> = {
	name: "postgres_migrate_remote_to_local",
	description:
		"Migrate an external Postgres database into a Dokploy-managed Postgres service using pg_dump/pg_restore inside the target container",
	category: "database",
	parameters: z.object({
		targetPostgresId: z.string().describe("Target Dokploy Postgres service ID"),
		sourceHost: z.string().min(1).describe("Source Postgres host"),
		sourcePort: z
			.number()
			.int()
			.positive()
			.max(65535)
			.optional()
			.default(5432)
			.describe("Source Postgres port"),
		sourceDatabase: z.string().min(1).describe("Source database name"),
		sourceUser: z.string().min(1).describe("Source user"),
		sourcePassword: z
			.string()
			.min(1)
			.describe("Source password (temporary, not stored)"),
		sslMode: z
			.string()
			.optional()
			.default("prefer")
			.describe("PGSSLMODE for source connection"),
		includeGlobals: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				"Attempt to migrate globals (roles/grants) using pg_dumpall --globals-only",
			),
		targetDatabaseName: z
			.string()
			.optional()
			.describe("Target database name (defaults to the service databaseName)"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.targetPostgresId, ctx);
		if (!pg) {
			return { success: false, message: "Postgres access denied" };
		}

		const targetDb = params.targetDatabaseName ?? pg.databaseName;
		const containerSearch = getServiceContainerCommand(pg.appName);
		const sourcePassword = params.sourcePassword;

		const globalsCmd = params.includeGlobals
			? `PGPASSWORD=${shSingleQuote(sourcePassword)} PGSSLMODE=${shSingleQuote(params.sslMode || "prefer")} pg_dumpall --globals-only -h ${shSingleQuote(params.sourceHost)} -p ${params.sourcePort} -U ${shSingleQuote(params.sourceUser)} | PGPASSWORD=${shSingleQuote(pg.databasePassword)} psql -X -v ON_ERROR_STOP=1 -U ${shSingleQuote(pg.databaseUser)} -d postgres`
			: "";

		const migrateCmd = `PGPASSWORD=${shSingleQuote(sourcePassword)} PGSSLMODE=${shSingleQuote(params.sslMode || "prefer")} pg_dump -Fc --no-owner --no-acl -h ${shSingleQuote(params.sourceHost)} -p ${params.sourcePort} -U ${shSingleQuote(params.sourceUser)} ${shSingleQuote(params.sourceDatabase)} | PGPASSWORD=${shSingleQuote(pg.databasePassword)} pg_restore -e -U ${shSingleQuote(pg.databaseUser)} -d ${shSingleQuote(targetDb)} -O --clean --if-exists --no-owner --no-acl`;

		const inner = `set -eo pipefail; ${globalsCmd ? `${globalsCmd};` : ""} ${migrateCmd};`;

		const cmd = `
			set -eo pipefail;
			CONTAINER_ID=$(${containerSearch});
			if [ -z "$CONTAINER_ID" ]; then
				echo "Error: Container not found for service ${pg.appName}" 1>&2;
				exit 1;
			fi
			docker exec -i "$CONTAINER_ID" bash -lc ${shSingleQuote(inner)}
		`;

		try {
			await execOnServer(pg.serverId, cmd);
			return {
				success: true,
				message: "Migration completed successfully",
				data: { migrated: true },
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: "Migration failed",
				error: errorMessage,
			};
		}
	},
};

const getPostgresDetails: Tool<
	{ postgresId: string },
	{
		postgresId: string;
		name: string;
		status: string;
		databaseName: string;
		dockerImage: string;
	}
> = {
	name: "postgres_get",
	description: "Get details of a specific PostgreSQL database by ID",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pg) {
			return {
				success: false,
				message: "Postgres access denied",
				data: {
					postgresId: "",
					name: "",
					status: "",
					databaseName: "",
					dockerImage: "",
				},
			};
		}
		return {
			success: true,
			message: `PostgreSQL "${pg.name}" details retrieved`,
			data: {
				postgresId: pg.postgresId,
				name: pg.name,
				status: pg.applicationStatus || "idle",
				databaseName: pg.databaseName,
				dockerImage: pg.dockerImage,
			},
		};
	},
};

const createPostgresDatabase: Tool<
	{
		name: string;
		appName: string;
		databaseName: string;
		databaseUser: string;
		environmentId: string;
		dockerImage?: string;
		description?: string;
		serverId?: string;
	},
	{ postgresId: string; name: string }
> = {
	name: "postgres_create",
	description: "Create a new PostgreSQL database. Requires environment ID.",
	category: "database",
	parameters: z.object({
		name: z.string().describe("Display name for the database"),
		appName: z.string().describe("Unique app name (used in container naming)"),
		databaseName: z.string().describe("PostgreSQL database name"),
		databaseUser: z.string().describe("PostgreSQL username"),
		environmentId: z.string().describe("Environment ID to create database in"),
		dockerImage: z
			.string()
			.optional()
			.default("postgres:16")
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

		const newPg = await createPostgres({
			name: params.name,
			appName: params.appName,
			databaseName: params.databaseName,
			databaseUser: params.databaseUser,
			databasePassword: generatePassword(),
			environmentId: params.environmentId,
			dockerImage: params.dockerImage || "postgres:16",
			description: params.description ?? null,
			serverId: params.serverId ?? ctx.serverId ?? null,
		});

		return {
			success: true,
			message: `PostgreSQL database "${newPg.name}" created successfully`,
			data: {
				postgresId: newPg.postgresId,
				name: newPg.name,
			},
		};
	},
};

const deployPostgresDatabase: Tool<
	{ postgresId: string },
	{ postgresId: string; status: string }
> = {
	name: "postgres_deploy",
	description: "Deploy/start a PostgreSQL database",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database ID to deploy"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const pgAccess = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pgAccess) {
			return {
				success: false,
				message: "Postgres access denied",
			};
		}
		const pg = await deployPostgres(params.postgresId);
		return {
			success: true,
			message: `PostgreSQL "${pg.name}" deployed successfully`,
			data: {
				postgresId: pg.postgresId,
				status: "done",
			},
		};
	},
};

const deletePostgresDatabase: Tool<
	{ postgresId: string },
	{ deleted: boolean }
> = {
	name: "postgres_delete",
	description: "Delete a PostgreSQL database. This action is irreversible!",
	category: "database",
	parameters: z.object({
		postgresId: z.string().describe("The PostgreSQL database ID to delete"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const pg = await ensurePostgresAccess(params.postgresId, ctx);
		if (!pg) {
			return {
				success: false,
				message: "Postgres access denied",
			};
		}
		await removePostgresById(params.postgresId);
		return {
			success: true,
			message: "PostgreSQL database deleted successfully",
			data: { deleted: true },
		};
	},
};

export function registerPostgresTools() {
	toolRegistry.register(listPostgresDatabases);
	toolRegistry.register(getPostgresDetails);
	toolRegistry.register(createPostgresDatabase);
	toolRegistry.register(deployPostgresDatabase);
	toolRegistry.register(deletePostgresDatabase);
	toolRegistry.register(postgresSqlQuery);
	toolRegistry.register(postgresSqlExecuteDml);
	toolRegistry.register(postgresSqlExecuteAdmin);
	toolRegistry.register(postgresExportS3);
	toolRegistry.register(postgresImportS3);
	toolRegistry.register(postgresMigrateRemoteToLocal);
}
