import { quote } from "shell-quote";

export type ExternalDatabaseType = "postgres" | "mysql" | "mariadb" | "mongo" | "redis";
export type ExternalDatabaseMigrationMode = "overwrite" | "import";

const q = (value: string) => quote([value]);

function getServiceContainerIdCommand(appName: string): string {
	return `docker ps -q --filter "status=running" --filter "label=com.docker.swarm.service.name=${appName}" | head -n 1`;
}

function parseUrlOrThrow(input: string): URL {
	try {
		return new URL(input);
	} catch {
		throw new Error("Invalid connection URL");
	}
}

function extractDbFromPathname(pathname: string): string | undefined {
	const raw = pathname.replace(/^\/+/, "");
	return raw.length > 0 ? raw : undefined;
}

type ParsedMySqlLike = {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
};

function parseMySqlLikeUrl(
	sourceUrl: string,
	options: { protocols: string[]; fallbackDatabase?: string },
): ParsedMySqlLike {
	const url = parseUrlOrThrow(sourceUrl);
	if (!options.protocols.includes(url.protocol)) {
		throw new Error(`Unsupported protocol: ${url.protocol}`);
	}

	const host = url.hostname.trim();
	const port = url.port ? Number.parseInt(url.port, 10) : 3306;
	const user = url.username.trim();
	const password = url.password;
	const database =
		extractDbFromPathname(url.pathname) ?? options.fallbackDatabase?.trim();

	if (!host) throw new Error("Source host is required");
	if (!Number.isFinite(port) || port <= 0) throw new Error("Invalid source port");
	if (!user) throw new Error("Source username is required");
	if (typeof password !== "string") throw new Error("Source password is required");
	if (!database) throw new Error("Source database is required");

	return { host, port, user, password, database };
}

export function buildPostgresExternalMigrationCommand(input: {
	appName: string;
	targetDatabase: string;
	targetUser: string;
	targetPassword: string;
	sourceUrl: string;
	mode: ExternalDatabaseMigrationMode;
}): string {
	const cleanFlags =
		input.mode === "overwrite" ? "--clean --if-exists" : "";

	return `
set -eo pipefail;
CONTAINER_ID=$(${getServiceContainerIdCommand(input.appName)});
if [ -z "$CONTAINER_ID" ]; then echo "Error: Container not found"; exit 1; fi
docker exec -i "$CONTAINER_ID" pg_dump -Fc --no-acl --no-owner --no-password ${q(
		input.sourceUrl,
	)} | docker exec -i -e PGPASSWORD=${q(
		input.targetPassword,
	)} "$CONTAINER_ID" pg_restore -U ${q(input.targetUser)} -d ${q(
		input.targetDatabase,
	)} -O --no-password --exit-on-error ${cleanFlags};
`;
}

export function buildMysqlExternalMigrationCommand(input: {
	appName: string;
	targetDatabase: string;
	targetRootPassword: string;
	sourceUrl: string;
	sourceDatabase?: string;
	mode: ExternalDatabaseMigrationMode;
}): string {
	const src = parseMySqlLikeUrl(input.sourceUrl, {
		protocols: ["mysql:"],
		fallbackDatabase: input.sourceDatabase,
	});

	const addDrop = input.mode === "overwrite" ? "--add-drop-table" : "";

	return `
set -eo pipefail;
CONTAINER_ID=$(${getServiceContainerIdCommand(input.appName)});
if [ -z "$CONTAINER_ID" ]; then echo "Error: Container not found"; exit 1; fi
docker exec -i -e MYSQL_PWD=${q(
		src.password,
	)} "$CONTAINER_ID" mysqldump --default-character-set=utf8mb4 --single-transaction --no-tablespaces --quick --routines --triggers --events ${addDrop} -h ${q(
		src.host,
	)} -P ${src.port} -u ${q(src.user)} ${q(src.database)} | docker exec -i -e MYSQL_PWD=${q(
		input.targetRootPassword,
	)} "$CONTAINER_ID" mysql -u root ${q(input.targetDatabase)};
`;
}

export function buildMariadbExternalMigrationCommand(input: {
	appName: string;
	targetDatabase: string;
	targetUser: string;
	targetPassword: string;
	sourceUrl: string;
	sourceDatabase?: string;
	mode: ExternalDatabaseMigrationMode;
}): string {
	const src = parseMySqlLikeUrl(input.sourceUrl, {
		protocols: ["mariadb:", "mysql:"],
		fallbackDatabase: input.sourceDatabase,
	});

	const addDrop = input.mode === "overwrite" ? "--add-drop-table" : "";

	return `
set -eo pipefail;
CONTAINER_ID=$(${getServiceContainerIdCommand(input.appName)});
if [ -z "$CONTAINER_ID" ]; then echo "Error: Container not found"; exit 1; fi
docker exec -i -e MYSQL_PWD=${q(
		src.password,
	)} "$CONTAINER_ID" mariadb-dump --single-transaction --quick --routines --triggers --events ${addDrop} --host=${q(
		src.host,
	)} --port=${src.port} --user=${q(src.user)} ${q(
		src.database,
	)} | docker exec -i -e MYSQL_PWD=${q(
		input.targetPassword,
	)} "$CONTAINER_ID" mariadb -u ${q(input.targetUser)} ${q(input.targetDatabase)};
`;
}

function parseMongoSourceDatabase(
	sourceUrl: string,
	fallback?: string,
): string {
	const url = parseUrlOrThrow(sourceUrl);
	if (url.protocol !== "mongodb:" && url.protocol !== "mongodb+srv:") {
		throw new Error(`Unsupported protocol: ${url.protocol}`);
	}

	const fromPath = extractDbFromPathname(url.pathname);
	const picked = fromPath ?? fallback?.trim();
	if (!picked) {
		throw new Error(
			"Source database is required (include it in the MongoDB URL path or pass sourceDatabase)",
		);
	}
	return picked;
}

export function buildMongoExternalMigrationCommand(input: {
	appName: string;
	targetUser: string;
	targetPassword: string;
	sourceUrl: string;
	sourceDatabase?: string;
	targetDatabase?: string;
	mode: ExternalDatabaseMigrationMode;
}): string {
	const sourceDb = parseMongoSourceDatabase(input.sourceUrl, input.sourceDatabase);
	const targetDb = (input.targetDatabase?.trim() || sourceDb).trim();
	const drop = input.mode === "overwrite" ? "--drop" : "";
	const nsTransform =
		sourceDb === targetDb
			? ""
			: `--nsFrom ${q(`${sourceDb}.*`)} --nsTo ${q(`${targetDb}.*`)}`;

	return `
set -eo pipefail;
CONTAINER_ID=$(${getServiceContainerIdCommand(input.appName)});
if [ -z "$CONTAINER_ID" ]; then echo "Error: Container not found"; exit 1; fi
docker exec -i "$CONTAINER_ID" mongodump --uri ${q(
		input.sourceUrl,
	)} --db ${q(sourceDb)} --archive --gzip | docker exec -i "$CONTAINER_ID" mongorestore --host localhost --username ${q(
		input.targetUser,
	)} --password ${q(
		input.targetPassword,
	)} --authenticationDatabase admin ${drop} ${nsTransform} --archive --gzip;
`;
}

function getRedisVolumeName(mounts: Array<{ type: string; mountPath: string; volumeName?: string | null }>, appName: string): string {
	const byData = mounts.find(
		(m) => m.type === "volume" && m.mountPath === "/data" && m.volumeName,
	)?.volumeName;
	return byData || `${appName}-data`;
}

export function buildRedisExternalMigrationCommand(input: {
	appName: string;
	dockerImage: string;
	replicas: number;
	mounts: Array<{ type: string; mountPath: string; volumeName?: string | null }>;
	sourceUrl: string;
	mode: ExternalDatabaseMigrationMode;
}): string {
	if (input.mode !== "overwrite") {
		throw new Error('Redis only supports mode="overwrite" for now');
	}

	const url = parseUrlOrThrow(input.sourceUrl);
	if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
		throw new Error(`Unsupported protocol: ${url.protocol}`);
	}

	const volumeName = getRedisVolumeName(input.mounts, input.appName);
	const replicas = Number.isFinite(input.replicas) && input.replicas > 0 ? input.replicas : 1;

	// We stop the service, write dump.rdb into the same volume via a one-off container, then start the service again.
	return `
set -eo pipefail;
docker service scale ${q(input.appName)}=0;
docker run --rm -v ${q(`${volumeName}:/data`)} ${q(
		input.dockerImage,
	)} sh -lc ${q(`redis-cli -u ${input.sourceUrl} --rdb /data/dump.rdb`)};
docker service scale ${q(input.appName)}=${replicas};
`;
}

