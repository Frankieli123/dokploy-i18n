import fs from "node:fs";

export const {
	DATABASE_URL,
	POSTGRES_PASSWORD_FILE,
	POSTGRES_USER = "dokploy",
	POSTGRES_DB = "dokploy",
	POSTGRES_HOST = "dokploy-postgres",
	POSTGRES_PORT = "5432",
} = process.env;

export const readSecret = (path: string): string => {
	try {
		const value = fs.readFileSync(path, "utf8").trim();
		if (!value) throw new Error("Secret is empty");
		return value;
	} catch {
		throw new Error(`Cannot read secret at ${path}`);
	}
};

export let dbUrl: string;
if (DATABASE_URL) {
	dbUrl = DATABASE_URL;
} else if (POSTGRES_PASSWORD_FILE) {
	const password = readSecret(POSTGRES_PASSWORD_FILE);
	dbUrl = `postgres://${POSTGRES_USER}:${encodeURIComponent(password)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;
} else {
	if (process.env.NODE_ENV !== "test") {
		console.warn(`
⚠️  [DEPRECATED DATABASE CONFIG]
POSTGRES_PASSWORD_FILE is not configured. Falling back to the legacy database password.
`);
	}
	dbUrl = `postgres://dokploy:amukds4wi9001583845717ad2@${
		process.env.NODE_ENV === "production" ? "dokploy-postgres" : "localhost"
	}:5432/dokploy`;
}
