import { ExecError } from "../process/ExecError";
import { execAsync } from "../process/execAsync";

type CommandExecutor = typeof execAsync;

const preflightDatabase = "dokploy_restore_preflight";

const isCollationVersionMismatch = (error: unknown) => {
	const message =
		error instanceof ExecError
			? `${error.message}\n${error.stderr || ""}`
			: error instanceof Error
				? error.message
				: String(error);
	return message.toLowerCase().includes("collation version mismatch");
};

const postgresCommand = (containerId: string, sql: string) =>
	`docker exec ${containerId} psql -v ON_ERROR_STOP=1 -U dokploy postgres -c "${sql}"`;

export const getDokployDatabaseCreateCommand = (
	containerId: string,
	template: "default" | "template0",
) =>
	postgresCommand(
		containerId,
		`CREATE DATABASE dokploy${template === "template0" ? " TEMPLATE template0" : ""};`,
	);

export const preparePostgresDatabaseCreation = async (
	containerId: string,
	emit: (log: string) => void,
	execute: CommandExecutor = execAsync,
) => {
	const runSql = (sql: string) => execute(postgresCommand(containerId, sql));
	const verifyTemplate = async (template?: "template0") => {
		await runSql(
			`CREATE DATABASE ${preflightDatabase}${template ? ` TEMPLATE ${template}` : ""};`,
		);
		await runSql(`DROP DATABASE ${preflightDatabase};`);
	};

	await runSql(`DROP DATABASE IF EXISTS ${preflightDatabase};`);

	try {
		await verifyTemplate();
		return "default" as const;
	} catch (error) {
		if (!isCollationVersionMismatch(error)) throw error;
	}

	emit(
		"Detected a PostgreSQL collation version mismatch, using template0 compatibility mode...",
	);

	try {
		await verifyTemplate("template0");
		return "template0" as const;
	} catch (error) {
		if (!isCollationVersionMismatch(error)) throw error;
	}

	emit("Refreshing the template0 collation version...");
	await runSql("ALTER DATABASE template0 REFRESH COLLATION VERSION;");
	await verifyTemplate("template0");
	return "template0" as const;
};
