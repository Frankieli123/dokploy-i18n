import { readdirSync } from "node:fs";
import { join } from "node:path";
import { docker } from "@dokploy/server/constants";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { compose } from "../db/schema";
import {
	initializeStandaloneTraefik,
	initializeTraefikService,
	type TraefikOptions,
} from "../setup/traefik-setup";

export interface IUpdateData {
	latestVersion: string | null;
	updateAvailable: boolean;
}

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	updateAvailable: false,
};

const DEFAULT_UPDATE_TAGS_URL =
	"https://hub.docker.com/v2/repositories/a3180623/dokploy-i18n/tags";

const getUpdateFetchTimeoutMs = () => {
	const raw = process.env.DOKPLOY_UPDATE_FETCH_TIMEOUT_MS;
	const parsed = raw ? Number.parseInt(raw, 10) : 8000;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 8000;
};

const fetchJsonWithTimeout = async <T>(url: string): Promise<T> => {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		getUpdateFetchTimeoutMs(),
	);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { "Content-Type": "application/json" },
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`Update check failed (${response.status})`);
		}

		return (await response.json()) as T;
	} finally {
		clearTimeout(timeout);
	}
};

const normalizeUpdateTagsUrl = (tagsUrl?: string | null) => {
	const raw = tagsUrl?.trim();
	if (!raw) return DEFAULT_UPDATE_TAGS_URL;
	try {
		const u = new URL(raw);
		if (u.protocol !== "https:" && u.protocol !== "http:") {
			return DEFAULT_UPDATE_TAGS_URL;
		}
		return u.toString().replace(/\?$/, "");
	} catch {
		return DEFAULT_UPDATE_TAGS_URL;
	}
};

type SemverIdentifier = number | string;

type ParsedSemver = {
	major: number;
	minor: number;
	patch: number;
	prerelease: SemverIdentifier[];
};

const I18N_TAG_MARKER = "-i18n";

const semverTagRegex = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const parseSemverTag = (tag: string): ParsedSemver | null => {
	const match = semverTagRegex.exec(tag.trim());
	if (!match) return null;
	const major = Number.parseInt(match[1] ?? "", 10);
	const minor = Number.parseInt(match[2] ?? "", 10);
	const patch = Number.parseInt(match[3] ?? "", 10);
	if (![major, minor, patch].every(Number.isFinite)) return null;

	const prereleaseRaw = match[4];
	const prerelease = prereleaseRaw
		? prereleaseRaw
				.split(".")
				.filter(Boolean)
				.map((id) => (/^\d+$/.test(id) ? Number.parseInt(id, 10) : id))
		: [];

	return { major, minor, patch, prerelease };
};

const compareSemver = (a: ParsedSemver, b: ParsedSemver): number => {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;

	const aPre = a.prerelease;
	const bPre = b.prerelease;
	const aEmpty = aPre.length === 0;
	const bEmpty = bPre.length === 0;
	if (aEmpty && bEmpty) return 0;
	if (aEmpty) return 1;
	if (bEmpty) return -1;

	const len = Math.max(aPre.length, bPre.length);
	for (let i = 0; i < len; i++) {
		const ai = aPre[i];
		const bi = bPre[i];
		if (ai === undefined) return -1;
		if (bi === undefined) return 1;
		if (ai === bi) continue;

		const aNum = typeof ai === "number";
		const bNum = typeof bi === "number";
		if (aNum && bNum) return ai < bi ? -1 : 1;
		if (aNum) return -1;
		if (bNum) return 1;
		return String(ai) < String(bi) ? -1 : 1;
	}

	return 0;
};

const pickLatestVersionTag = (
	tags: { name: string; digest: string }[],
	options?: { preferSubstring?: string },
): { name: string; digest: string } | null => {
	const parsed = tags
		.map((t) => {
			const name = typeof t.name === "string" ? t.name.trim() : "";
			const digest = typeof t.digest === "string" ? t.digest.trim() : "";
			if (!name || !digest) return null;
			const version = parseSemverTag(name);
			return version ? { name, digest, version } : null;
		})
		.filter((t): t is NonNullable<typeof t> => t !== null);

	if (parsed.length === 0) return null;

	const prefer = options?.preferSubstring?.trim().toLowerCase() ?? "";
	let candidates = parsed;
	if (prefer.length > 0) {
		const filtered = parsed.filter((t) =>
			t.name.toLowerCase().includes(prefer),
		);
		if (filtered.length > 0) candidates = filtered;
	}

	const first = candidates[0];
	if (!first) return null;

	let best = first;
	for (const candidate of candidates.slice(1)) {
		if (compareSemver(candidate.version, best.version) > 0) best = candidate;
	}

	return { name: best.name, digest: best.digest };
};

/** Returns current Dokploy docker image tag or `latest` by default. */
export const getDokployImageTag = () => {
	return process.env.RELEASE_TAG || "latest";
};

export const getDokployImage = (tag?: string | null) => {
	return `a3180623/dokploy-i18n:${tag || getDokployImageTag()}`;
};

export const pullLatestRelease = async (tag?: string | null) => {
	const stream = await docker.pull(getDokployImage(tag));
	await new Promise((resolve, reject) => {
		docker.modem.followProgress(stream, (err, res) =>
			err ? reject(err) : resolve(res),
		);
	});
};

/** Returns Dokploy docker service image digest */
export const getServiceImageDigest = async () => {
	const { stdout } = await execAsync(
		"docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
	);

	const currentDigest = stdout.trim().split("@")[1];

	if (!currentDigest) {
		throw new Error("Could not get current service image digest");
	}

	return currentDigest;
};

/** Returns latest version number and information whether server update is available by comparing current image's digest against digest for provided image tag via Docker hub API. */
export const getUpdateData = async (
	tagsUrl?: string | null,
): Promise<IUpdateData> => {
	let currentDigest: string;
	try {
		currentDigest = await getServiceImageDigest();
	} catch (error) {
		// TODO: Docker versions 29.0.0 change the way to get the service image digest, so we need to update this in the future we upgrade to that version.
		return DEFAULT_UPDATE_DATA;
	}

	const baseUrl = normalizeUpdateTagsUrl(tagsUrl);
	const base = new URL(baseUrl);
	const defaultBase = new URL(DEFAULT_UPDATE_TAGS_URL);

	const firstPageUrl = new URL(baseUrl);
	firstPageUrl.searchParams.set("page_size", "100");

	let url: string | null = firstPageUrl.toString();
	let allResults: { digest: string; name: string }[] = [];
	try {
		while (url) {
			const data: {
				next: string | null;
				results: { digest: string; name: string }[];
			} = await fetchJsonWithTimeout(url);

			allResults = allResults.concat(data.results);
			url = data?.next;

			if (url && base.origin !== defaultBase.origin) {
				try {
					const nextUrl: URL = new URL(url);
					if (nextUrl.origin === defaultBase.origin) {
						nextUrl.protocol = base.protocol;
						nextUrl.username = base.username;
						nextUrl.password = base.password;
						nextUrl.host = base.host;
						url = nextUrl.toString();
					}
				} catch {
					// ignore URL rewrite errors
				}
			}
		}
	} catch {
		return DEFAULT_UPDATE_DATA;
	}

	const imageTag = getDokployImageTag();
	const searchedDigest = allResults.find((t) => t.name === imageTag)?.digest;

	if (!searchedDigest) {
		return DEFAULT_UPDATE_DATA;
	}

	if (imageTag === "latest") {
		const versionedTag = pickLatestVersionTag(
			allResults.filter(
				(t) =>
					t.digest === searchedDigest &&
					typeof t.name === "string" &&
					t.name.toLowerCase().includes(I18N_TAG_MARKER),
			),
		);

		if (!versionedTag) {
			return DEFAULT_UPDATE_DATA;
		}

		const { name: latestVersion, digest } = versionedTag;
		const updateAvailable = digest !== currentDigest;

		return { latestVersion, updateAvailable };
	}

	if (parseSemverTag(imageTag)) {
		const latest = pickLatestVersionTag(
			allResults.filter(
				(t) =>
					typeof t.name === "string" &&
					t.name.toLowerCase().includes(I18N_TAG_MARKER),
			),
		);
		if (latest) {
			return {
				latestVersion: latest.name,
				updateAvailable: latest.digest !== currentDigest,
			};
		}
	}
	const updateAvailable = searchedDigest !== currentDigest;
	return { latestVersion: imageTag, updateAvailable };
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`
process_items() {
    local parent_dir="$1"
    local __resultvar=$2

    local items_json=""
    local first=true
    for item in "$parent_dir"/*; do
        [ -e "$item" ] || continue
        process_item "$item" item_json
        if [ "$first" = true ]; then
            first=false
            items_json="$item_json"
        else
            items_json="$items_json,$item_json"
        fi
    done

    eval $__resultvar="'[$items_json]'"
}

process_item() {
    local item_path="$1"
    local __resultvar=$2

    local item_name=$(basename "$item_path")
    local escaped_name=$(echo "$item_name" | sed 's/"/\\"/g')
    local escaped_path=$(echo "$item_path" | sed 's/"/\\"/g')

    if [ -d "$item_path" ]; then
        # Is directory
        process_items "$item_path" children_json
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"directory","children":'"$children_json"'}'
    else
        # Is file
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"file"}'
    fi

    eval $__resultvar="'$json'"
}

root_dir=${dirPath}

process_items "$root_dir" json_output

echo "$json_output"
			`,
		);
		const result = JSON.parse(stdout);
		return result;
	}

	const stack = [dirPath];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) continue;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			if (item.isDirectory()) {
				stack.push(fullPath);
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};

export const cleanupFullDocker = async (serverId?: string | null) => {
	const cleanupImages = "docker image prune --force";
	const cleanupVolumes = "docker volume prune --force";
	const cleanupContainers = "docker container prune --force";
	const cleanupSystem = "docker system prune  --force --volumes";
	const cleanupBuilder = "docker builder prune  --force";

	try {
		if (serverId) {
			await execAsyncRemote(
				serverId,
				`
	${cleanupImages}
	${cleanupVolumes}
	${cleanupContainers}
	${cleanupSystem}
	${cleanupBuilder}
			`,
			);
		}
		await execAsync(`
			${cleanupImages}
			${cleanupVolumes}
			${cleanupContainers}
			${cleanupSystem}
			${cleanupBuilder}
					`);
	} catch (error) {
		console.log(error);
	}
};

export const getDockerResourceType = async (
	resourceName: string,
	serverId?: string,
) => {
	try {
		let result = "";
		const command = `
RESOURCE_NAME="${resourceName}"
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, command);
			result = stdout.trim();
		} else {
			const { stdout } = await execAsync(command);
			result = stdout.trim();
		}
		if (result === "service") {
			return "service";
		}
		if (result === "standalone") {
			return "standalone";
		}
		return "unknown";
	} catch (error) {
		console.error(error);
		return "unknown";
	}
};

export const reloadDockerResource = async (
	resourceName: string,
	serverId?: string,
	version?: string | null,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		if (resourceName === "dokploy" && version) {
			const image = getDokployImage(version);
			command = `docker service update --force --image ${image} ${resourceName} || docker service update --force ${resourceName}`;
		} else {
			command = `docker service update --force ${resourceName}`;
		}
	} else if (resourceType === "standalone") {
		command = `docker restart ${resourceName}`;
	} else {
		throw new Error("Resource type not found");
	}
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const readEnvironmentVariables = async (
	resourceName: string,
	serverId?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .Config.Env}}'`;
	} else {
		throw new Error("Resource type not found");
	}
	if (!command.trim()) {
		throw new Error("Command is empty");
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}
	if (result === "null") {
		return "";
	}
	return JSON.parse(result)?.join("\n");
};

export const readPorts = async (
	resourceName: string,
	serverId?: string,
): Promise<
	{ targetPort: number; publishedPort: number; protocol?: string }[]
> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.EndpointSpec.Ports}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .NetworkSettings.Ports}}'`;
	} else {
		throw new Error("Resource type not found");
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}

	if (result === "null") {
		return [];
	}

	const parsedResult = JSON.parse(result);

	if (resourceType === "service") {
		return parsedResult
			.map((port: any) => ({
				targetPort: port.TargetPort,
				publishedPort: port.PublishedPort,
				protocol: port.Protocol,
			}))
			.filter((port: any) => port.targetPort !== 80 && port.targetPort !== 443);
	}
	const ports: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[] = [];
	for (const key in parsedResult) {
		if (Object.hasOwn(parsedResult, key)) {
			const containerPortMapppings = parsedResult[key];
			const protocol = key.split("/")[1];
			const targetPort = Number.parseInt(key.split("/")[0] ?? "0", 10);

			containerPortMapppings.forEach((mapping: any) => {
				ports.push({
					targetPort: targetPort,
					publishedPort: Number.parseInt(mapping.HostPort, 10),
					protocol: protocol,
				});
			});
		}
	}
	return ports.filter(
		(port: any) => port.targetPort !== 80 && port.targetPort !== 443,
	);
};

export const checkPortInUse = async (
	port: number,
	serverId?: string,
): Promise<{ isInUse: boolean; conflictingContainer?: string }> => {
	try {
		const command = `docker ps -a --format '{{.Names}}' | grep -v '^dokploy-traefik$' | while read name; do docker port "$name" 2>/dev/null | grep -q ':${port}' && echo "$name" && break; done || true`;
		const { stdout } = serverId
			? await execAsyncRemote(serverId, command)
			: await execAsync(command);
		const container = stdout.trim();
		return {
			isInUse: !!container,
			conflictingContainer: container || undefined,
		};
	} catch (error) {
		console.error("Error checking port availability:", error);
		return { isInUse: false };
	}
};

export const writeTraefikSetup = async (input: TraefikOptions) => {
	const resourceType = await getDockerResourceType(
		"dokploy-traefik",
		input.serverId,
	);

	if (resourceType === "service") {
		await initializeTraefikService({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
		await reconnectServicesToTraefik(input.serverId);
	} else if (resourceType === "standalone") {
		await initializeStandaloneTraefik({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
		await reconnectServicesToTraefik(input.serverId);
	} else {
		throw new Error("Traefik resource type not found");
	}
};

export const reconnectServicesToTraefik = async (serverId?: string) => {
	const composeResult = await db.query.compose.findMany({
		where: and(
			...(serverId ? [eq(compose.serverId, serverId)] : []),
			eq(compose.isolatedDeployment, true),
		),
	});

	if (!composeResult.length) {
		return;
	}

	let commands = "";
	for (const composeItem of composeResult) {
		commands += `docker network connect ${composeItem.appName} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1\n`;
	}

	if (!commands.trim()) {
		return;
	}

	if (serverId) {
		await execAsyncRemote(serverId, commands);
	} else {
		await execAsync(commands);
	}
};
