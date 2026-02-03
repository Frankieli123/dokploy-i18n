import fs from "node:fs";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
	var db: PostgresJsDatabase<typeof schema> | undefined;
}

function readSecret(path: string): string {
	try {
		return fs.readFileSync(path, "utf8").trim();
	} catch {
		throw new Error(`Cannot read secret at ${path}`);
	}
}

const {
	DATABASE_URL,
	POSTGRES_PASSWORD_FILE,
	POSTGRES_USER = "dokploy",
	POSTGRES_DB = "dokploy",
	POSTGRES_HOST = "dokploy-postgres",
	POSTGRES_PORT = "5432",
} = process.env;

let dbUrl: string;

if (DATABASE_URL) {
	dbUrl = DATABASE_URL;
} else if (POSTGRES_PASSWORD_FILE) {
	const password = readSecret(POSTGRES_PASSWORD_FILE);
	dbUrl = `postgres://${POSTGRES_USER}:${encodeURIComponent(
		password,
	)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;
} else {
	console.warn(
		`\n\t\t⚠️  [DEPRECATED DATABASE CONFIG]\n\t\tYou are using the legacy hardcoded database credentials.\n\t\tThis mode WILL BE REMOVED in a future release.\n\t\t\n\t\tPlease migrate to Docker Secrets using POSTGRES_PASSWORD_FILE.\n\t\tPlease execute this guide: https://dokploy.com/SECURITY_MIGRATION.md\n\t\t`,
	);
	dbUrl =
		"postgres://dokploy:amukds4wi9001583845717ad2@dokploy-postgres:5432/dokploy";
}

export let db: PostgresJsDatabase<typeof schema>;
if (process.env.NODE_ENV === "production") {
	db = drizzle(postgres(dbUrl), {
		schema,
	});
} else {
	if (!global.db)
		global.db = drizzle(postgres(dbUrl), {
			schema,
		});

	db = global.db;
}
