import fs from "node:fs";
import net from "node:net";
import { URL } from "node:url";

const TIMEOUT_MS = Number(process.env.POSTGRES_WAIT_TIMEOUT || 120_000);
const RETRY_DELAY_MS = Number(process.env.POSTGRES_WAIT_RETRY || 2000);

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDatabaseUrl(): string {
	const {
		DATABASE_URL,
		POSTGRES_PASSWORD_FILE,
		POSTGRES_USER = "dokploy",
		POSTGRES_DB = "dokploy",
		POSTGRES_HOST = "dokploy-postgres",
		POSTGRES_PORT = "5432",
	} = process.env;

	if (DATABASE_URL) {
		return DATABASE_URL;
	}

	if (POSTGRES_PASSWORD_FILE) {
		try {
			const password = fs.readFileSync(POSTGRES_PASSWORD_FILE, "utf8").trim();
			return `postgres://${POSTGRES_USER}:${encodeURIComponent(password)}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;
		} catch {
			console.error(
				`[wait-for-postgres] Cannot read secret at ${POSTGRES_PASSWORD_FILE}`,
			);
			process.exit(1);
		}
	}

	return "postgres://dokploy:amukds4wi9001583845717ad2@dokploy-postgres:5432/dokploy";
}

function resolvePostgresTarget(): { host: string; port: number } {
	const databaseUrl = resolveDatabaseUrl();

	try {
		const url = new URL(databaseUrl);
		const host = url.hostname;
		const port = Number(url.port || 5432);

		if (!host) {
			throw new Error("DATABASE_URL has no hostname");
		}

		return { host, port };
	} catch {
		console.error("[wait-for-postgres] Invalid DATABASE_URL:", databaseUrl);
		process.exit(1);
	}
}

function checkTcpConnection(host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host, port });
		socket.setTimeout(3000);
		socket.on("connect", () => {
			socket.end();
			resolve();
		});
		socket.on("timeout", () => {
			socket.destroy();
			reject(new Error("Connection timeout"));
		});
		socket.on("error", reject);
	});
}

async function waitForPostgres() {
	const { host, port } = resolvePostgresTarget();
	const start = Date.now();

	console.log(
		`[wait-for-postgres] Waiting for postgres at ${host}:${port} (timeout ${TIMEOUT_MS}ms)`,
	);

	while (true) {
		try {
			await checkTcpConnection(host, port);
			console.log("[wait-for-postgres] Postgres is reachable ✅");
			return;
		} catch {
			const elapsed = Date.now() - start;
			if (elapsed > TIMEOUT_MS) {
				console.error(
					`[wait-for-postgres] Timeout after ${elapsed}ms. Postgres not reachable ❌`,
				);
				process.exit(1);
			}

			console.log(
				`[wait-for-postgres] Postgres not ready yet, retrying in ${RETRY_DELAY_MS}ms...`,
			);
			await sleep(RETRY_DELAY_MS);
		}
	}
}

waitForPostgres().catch((error) => {
	console.error("[wait-for-postgres] Fatal error:", error);
	process.exit(1);
});
