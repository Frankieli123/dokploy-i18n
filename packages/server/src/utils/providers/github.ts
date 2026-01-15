import { join } from "node:path";
import { paths } from "@dokploy/server/constants";
import type { apiFindGithubBranches } from "@dokploy/server/db/schema";
import { findGithubById, type Github } from "@dokploy/server/services/github";
import type { InferResultType } from "@dokploy/server/types/with";
import { createAppAuth } from "@octokit/auth-app";
import { TRPCError } from "@trpc/server";
import { Octokit } from "octokit";
import { ProxyAgent, fetch as undiciFetch } from "undici";

const normalizeMirrorPrefixUrl = (input: string) => {
	const trimmed = input.trim();
	if (!trimmed) {
		return "";
	}
	return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const shSingleQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const getOctokitRequestOptions = (githubProvider: Github) => {
	const proxyUrl = githubProvider.githubApiProxyUrl?.trim();
	if (!proxyUrl) {
		return undefined;
	}

	const agent = new ProxyAgent(proxyUrl);
	return {
		fetch: (url: any, options: any) =>
			undiciFetch(url, {
				...options,
				dispatcher: agent,
			}) as any,
	} as const;
};

export const authGithub = (githubProvider: Github): Octokit => {
	if (!haveGithubRequirements(githubProvider)) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Github Account not configured correctly",
		});
	}

	const octokit: Octokit = new Octokit({
		authStrategy: createAppAuth,
		auth: {
			appId: githubProvider?.githubAppId || 0,
			privateKey: githubProvider?.githubPrivateKey || "",
			installationId: githubProvider?.githubInstallationId,
		},
		...(githubProvider.githubApiProxyUrl
			? {
					request: getOctokitRequestOptions(githubProvider),
				}
			: {}),
	});

	return octokit;
};

export const getGithubToken = async (
	octokit: ReturnType<typeof authGithub>,
) => {
	const installation = (await octokit.auth({
		type: "installation",
	})) as {
		token: string;
	};

	return installation.token;
};

/**
 * Check if a GitHub user has write/admin permissions on a repository
 * This is used to validate PR authors before allowing preview deployments
 */
export const checkUserRepositoryPermissions = async (
	githubProvider: Github,
	owner: string,
	repo: string,
	username: string,
): Promise<{ hasWriteAccess: boolean; permission: string | null }> => {
	try {
		const octokit = authGithub(githubProvider);

		// Check if user is a collaborator with write permissions
		const { data: permission } =
			await octokit.rest.repos.getCollaboratorPermissionLevel({
				owner,
				repo,
				username,
			});

		// Allow only users with 'write', 'admin', or 'maintain' permissions
		// Currently exists Read, Triage, Write, Maintain, Admin
		const allowedPermissions = ["write", "admin", "maintain"];
		const hasWriteAccess = allowedPermissions.includes(permission.permission);

		return {
			hasWriteAccess,
			permission: permission.permission,
		};
	} catch (error) {
		// If user is not a collaborator, GitHub API returns 404
		console.warn(
			`User ${username} is not a collaborator of ${owner}/${repo}:`,
			error,
		);
		return {
			hasWriteAccess: false,
			permission: null,
		};
	}
};

export const haveGithubRequirements = (githubProvider: Github) => {
	return !!(
		githubProvider?.githubAppId &&
		githubProvider?.githubPrivateKey &&
		githubProvider?.githubInstallationId
	);
};

const getErrorCloneRequirements = (entity: {
	repository?: string | null;
	owner?: string | null;
	branch?: string | null;
}) => {
	const reasons: string[] = [];
	const { repository, owner, branch } = entity;

	if (!repository) reasons.push("1. Repository not assigned.");
	if (!owner) reasons.push("2. Owner not specified.");
	if (!branch) reasons.push("3. Branch not defined.");

	return reasons;
};

export type ApplicationWithGithub = InferResultType<
	"applications",
	{ github: true }
>;

export type ComposeWithGithub = InferResultType<"compose", { github: true }>;

interface CloneGithubRepository {
	appName: string;
	owner: string | null;
	branch: string | null;
	githubId: string | null;
	repository: string | null;
	type?: "application" | "compose";
	enableSubmodules: boolean;
	serverId: string | null;
}
export const cloneGithubRepository = async ({
	type = "application",
	...entity
}: CloneGithubRepository) => {
	let command = "set -e;";
	const isCompose = type === "compose";
	const {
		appName,
		repository,
		owner,
		branch,
		githubId,
		enableSubmodules,
		serverId,
	} = entity;
	const { APPLICATIONS_PATH, COMPOSE_PATH } = paths(!!serverId);

	if (!githubId) {
		command += `echo "Error: ❌ Github Provider not found"; exit 1;`;

		return command;
	}

	const requirements = getErrorCloneRequirements(entity);

	// Check if requirements are met
	if (requirements.length > 0) {
		command += `echo "GitHub Repository configuration failed for application: ${appName}"; echo "Reasons:"; echo "${requirements.join("\n")}"; exit 1;`;
		return command;
	}

	const githubProvider = await findGithubById(githubId);
	const basePath = isCompose ? COMPOSE_PATH : APPLICATIONS_PATH;
	const outputPath = join(basePath, appName, "code");
	const repoclone = `github.com/${owner}/${repository}.git`;
	const canonical = `https://${repoclone}`;
	const mirrorPrefixUrl = normalizeMirrorPrefixUrl(
		githubProvider.githubMirrorPrefixUrl ?? "",
	);
	const shouldUseMirror = Boolean(mirrorPrefixUrl);
	const forwardAuth = Boolean(githubProvider.githubMirrorForwardAuth);

	let cloneUrl = shouldUseMirror ? `${mirrorPrefixUrl}${canonical}` : canonical;
	let gitConfigArgs = "";
	if (forwardAuth || !shouldUseMirror) {
		try {
			const octokit = authGithub(githubProvider);
			const token = await getGithubToken(octokit);
			const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
			gitConfigArgs = `-c http.extraheader=${shSingleQuote(
				`Authorization: Basic ${basic}`,
			)} `;
		} catch (error) {
			if (error instanceof TRPCError) {
				throw error;
			}
			command +=
				'echo "[WARN] Failed to fetch GitHub token; trying unauthenticated clone (private repos may fail).";';
		}
	}

	if (githubProvider.githubApiProxyUrl) {
		const proxy = shSingleQuote(githubProvider.githubApiProxyUrl);
		command += `export http_proxy=${proxy}; export https_proxy=${proxy}; `;
		command += `export HTTP_PROXY=${proxy}; export HTTPS_PROXY=${proxy}; `;
	}

	command += `rm -rf ${shSingleQuote(outputPath)};`;
	command += `mkdir -p ${shSingleQuote(outputPath)};`;

	command += `echo "Cloning Repo ${repoclone} to ${outputPath}: ✅";`;
	if (shouldUseMirror && forwardAuth) {
		command += `if ! git ${gitConfigArgs}clone --branch ${shSingleQuote(branch || "")} --depth 1 ${
			enableSubmodules ? "--recurse-submodules" : ""
		} ${shSingleQuote(cloneUrl)} ${shSingleQuote(outputPath)} --progress; then `;
		command += 'echo "Mirror clone failed, falling back to direct clone..."; ';
		command += `rm -rf ${shSingleQuote(outputPath)}; `;
		command += `mkdir -p ${shSingleQuote(outputPath)}; `;
		command += `git ${gitConfigArgs}clone --branch ${shSingleQuote(branch || "")} --depth 1 ${
			enableSubmodules ? "--recurse-submodules" : ""
		} ${shSingleQuote(canonical)} ${shSingleQuote(outputPath)} --progress; `;
		command += "fi;";
	} else {
		command += `git ${gitConfigArgs}clone --branch ${shSingleQuote(branch || "")} --depth 1 ${
			enableSubmodules ? "--recurse-submodules" : ""
		} ${shSingleQuote(cloneUrl)} ${shSingleQuote(outputPath)} --progress;`;
	}

	return command;
};

export const getGithubRepositories = async (githubId?: string) => {
	if (!githubId) {
		return [];
	}

	const githubProvider = await findGithubById(githubId);
	const octokit = authGithub(githubProvider);

	const repositories = (await octokit.paginate(
		octokit.rest.apps.listReposAccessibleToInstallation,
	)) as unknown as Awaited<
		ReturnType<typeof octokit.rest.apps.listReposAccessibleToInstallation>
	>["data"]["repositories"];

	return repositories;
};

export const getGithubBranches = async (
	input: typeof apiFindGithubBranches._type,
) => {
	if (!input.githubId) {
		return [];
	}
	const githubProvider = await findGithubById(input.githubId);
	const octokit = authGithub(githubProvider);

	const branches = (await octokit.paginate(octokit.rest.repos.listBranches, {
		owner: input.owner,
		repo: input.repo,
	})) as unknown as Awaited<
		ReturnType<typeof octokit.rest.repos.listBranches>
	>["data"];

	return branches;
};
