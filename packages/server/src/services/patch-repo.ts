import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { TRPCError } from "@trpc/server";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import { cloneBitbucketRepository } from "../utils/providers/bitbucket";
import { cloneGitRepository } from "../utils/providers/git";
import { cloneGiteaRepository } from "../utils/providers/gitea";
import { cloneGithubRepository } from "../utils/providers/github";
import { cloneGitlabRepository } from "../utils/providers/gitlab";
import { findApplicationById } from "./application";
import { findComposeById } from "./compose";
import { normalizePatchFilePath } from "./patch";

interface PatchRepoConfig {
	type: "application" | "compose";
	id: string;
}

type DirectoryEntry = {
	name: string;
	path: string;
	type: "file" | "directory";
	children?: DirectoryEntry[];
};

const shSingleQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const getPatchRepoContext = async ({ type, id }: PatchRepoConfig) => {
	if (type === "application") {
		const application = await findApplicationById(id);
		if (application.sourceType === "docker") {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Patches are not supported for docker image applications",
			});
		}

		return {
			entity: application,
			serverId: application.buildServerId || application.serverId,
			repoPath: join(
				paths(!!(application.buildServerId || application.serverId))
					.PATCH_REPOS_PATH,
				type,
				application.appName,
			),
		};
	}

	const compose = await findComposeById(id);
	if (compose.sourceType === "raw") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Patches are not supported for raw compose in the first stage",
		});
	}

	return {
		entity: compose,
		serverId: compose.serverId,
		repoPath: join(paths(!!compose.serverId).PATCH_REPOS_PATH, type, compose.appName),
	};
};

export const ensurePatchRepo = async ({
	type,
	id,
}: PatchRepoConfig): Promise<string> => {
	const { entity, serverId, repoPath } = await getPatchRepoContext({
		type,
		id,
	});

	const entityWithOverride = {
		...entity,
		type,
		serverId,
		outputPathOverride: repoPath,
	};

	let command = "set -e;";
	if (entity.sourceType === "github") {
		command += await cloneGithubRepository(entityWithOverride);
	} else if (entity.sourceType === "gitlab") {
		command += await cloneGitlabRepository(entityWithOverride);
	} else if (entity.sourceType === "gitea") {
		command += await cloneGiteaRepository(entityWithOverride);
	} else if (entity.sourceType === "bitbucket") {
		command += await cloneBitbucketRepository(entityWithOverride);
	} else if (entity.sourceType === "git") {
		command += await cloneGitRepository(entityWithOverride);
	} else {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Patches are not supported for this source type",
		});
	}

	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}

	return repoPath;
};

export const readPatchRepoDirectory = async (
	repoPath: string,
	serverId?: string | null,
): Promise<DirectoryEntry[]> => {
	const command = `cd ${shSingleQuote(repoPath)} && git ls-tree -r --name-only HEAD`;

	let stdout: string;
	try {
		if (serverId) {
			const result = await execAsyncRemote(serverId, command);
			stdout = result.stdout;
		} else {
			const result = await execAsync(command);
			stdout = result.stdout;
		}
	} catch (error) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Failed to read patch repository: ${error}`,
		});
	}

	const files = stdout.trim().split("\n").filter(Boolean);
	const root: DirectoryEntry[] = [];
	const dirMap = new Map<string, DirectoryEntry>();

	for (const filePath of files) {
		const parts = filePath.split("/");
		let currentPath = "";

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (!part) continue;

			const isFile = i === parts.length - 1;
			const parentPath = currentPath;
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			if (!dirMap.has(currentPath)) {
				const entry: DirectoryEntry = {
					name: part,
					path: currentPath,
					type: isFile ? "file" : "directory",
					children: isFile ? undefined : [],
				};

				dirMap.set(currentPath, entry);

				if (parentPath) {
					const parent = dirMap.get(parentPath);
					parent?.children?.push(entry);
				} else {
					root.push(entry);
				}
			}
		}
	}

	return root;
};

export const readPatchRepoFile = async (
	id: string,
	type: "application" | "compose",
	filePath: string,
) => {
	const { serverId, repoPath } = await getPatchRepoContext({ id, type });
	const normalizedPath = normalizePatchFilePath(filePath);
	const fullPath = join(repoPath, normalizedPath);
	const command = `cat ${shSingleQuote(fullPath)}`;

	if (serverId) {
		const result = await execAsyncRemote(serverId, command);
		return result.stdout;
	}

	const result = await execAsync(command);
	return result.stdout;
};

export const cleanPatchRepos = async (
	serverId?: string | null,
): Promise<void> => {
	const { PATCH_REPOS_PATH } = paths(!!serverId);
	const command = `rm -rf "${PATCH_REPOS_PATH}"/* 2>/dev/null || true`;

	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};
