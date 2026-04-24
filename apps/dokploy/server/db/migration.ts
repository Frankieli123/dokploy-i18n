import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Docker from "dockerode";
import postgres from "postgres";

const DEFAULT_DB_URL =
	"postgres://dokploy:amukds4wi9001583845717ad2@dokploy-postgres:5432/dokploy";
const MANAGED_POSTGRES_SERVICE = "dokploy-postgres";
const PGVECTOR_IMAGE = "pgvector/pgvector:pg16";
const docker = new Docker({
	...(process.env.DOKPLOY_DOCKER_API_VERSION &&
		process.env.DOKPLOY_DOCKER_API_VERSION.trim() && {
			version: process.env.DOKPLOY_DOCKER_API_VERSION,
		}),
	...(process.env.DOKPLOY_DOCKER_HOST &&
		process.env.DOKPLOY_DOCKER_HOST.trim() && {
			host: process.env.DOKPLOY_DOCKER_HOST,
		}),
	...((process.env.DOKPLOY_DOCKER_PORT || process.env.DOCKER_PORT) && {
			port: Number(process.env.DOKPLOY_DOCKER_PORT || process.env.DOCKER_PORT),
		}),
});

const isPgvectorMissingError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("vector.control") ||
		message.includes('extension "vector" is not available') ||
		message.includes('type "vector" does not exist')
	);
};

const isRetryableDatabaseError = (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	const code =
		typeof error === "object" && error !== null && "code" in error
			? String((error as any).code)
			: "";

	return (
		["57P03", "53300", "55006"].includes(code) ||
		/\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND)\b/i.test(
			message,
		) ||
		/(database system is starting up|the database system is starting up)/i.test(
			message,
		) ||
		/Connection terminated unexpectedly/i.test(message)
	);
};

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const isManagedPostgresUrl = (connectionString: string) => {
	try {
		const url = new URL(connectionString);
		return url.hostname === MANAGED_POSTGRES_SERVICE;
	} catch {
		return false;
	}
};

const maybeUpgradeManagedPostgresToPgvector = async () => {
	const service = docker.getService(MANAGED_POSTGRES_SERVICE);
	const inspect = await service.inspect();
	const currentImage = inspect.Spec?.TaskTemplate?.ContainerSpec?.Image ?? "";

	if (currentImage.includes("pgvector/pgvector:")) return false;

	const nextSpec = structuredClone(inspect.Spec);
	nextSpec.TaskTemplate.ContainerSpec.Image = PGVECTOR_IMAGE;
	nextSpec.TaskTemplate.ForceUpdate = (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1;

	await service.update({
		version: Number.parseInt(inspect.Version.Index),
		...nextSpec,
	});

	console.log(
		`Updated ${MANAGED_POSTGRES_SERVICE} image to ${PGVECTOR_IMAGE} (was ${currentImage})`,
	);
	return true;
};

export const migration = async () => {
	const connectionString = process.env.DATABASE_URL || DEFAULT_DB_URL;

	const startMs = Date.now();
	let attempt = 0;
	let pgvectorUpgradeAttempted = false;

	for (;;) {
		attempt += 1;
		const sql = postgres(connectionString, { max: 1 });
		const db = drizzle(sql);

		try {
			await migrate(db, { migrationsFolder: "drizzle" });
			console.log("Migration complete");
			return;
		} catch (error) {
			if (isPgvectorMissingError(error)) {
				const canAutoFix =
					!pgvectorUpgradeAttempted && isManagedPostgresUrl(connectionString);
				if (canAutoFix) {
					pgvectorUpgradeAttempted = true;
					try {
						const didUpdate = await maybeUpgradeManagedPostgresToPgvector();
						if (didUpdate) {
							console.warn(
								"pgvector is missing. Dokploy Postgres image updated; retrying migration...",
							);
							await sleep(5_000);
							continue;
						}
					} catch (upgradeError) {
						console.error("pgvector auto-upgrade failed", upgradeError);
					}
				}

				const hint =
					'pgvector extension is missing. Install pgvector in Postgres (recommended image: "pgvector/pgvector:pg16") and rerun migrations.';
				console.error("Migration failed:", hint, error);
				throw error;
			}

			const elapsedMs = Date.now() - startMs;
			const retryable = isRetryableDatabaseError(error);
			const maxElapsedMs = 2 * 60 * 1000;

			if (!retryable || elapsedMs >= maxElapsedMs) {
				console.error("Migration failed", error);
				throw error;
			}

			const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
			console.warn(
				`Migration failed (attempt ${attempt}). Retrying in ${backoffMs}ms...`,
			);
			await sleep(backoffMs);
		} finally {
			await sql.end({ timeout: 5 });
		}
	}
};
