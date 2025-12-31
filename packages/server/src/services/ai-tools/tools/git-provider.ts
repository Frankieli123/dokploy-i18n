import { db } from "@dokploy/server/db";
import { gitProvider as gitProviderTable } from "@dokploy/server/db/schema";
import type { GitProvider } from "@dokploy/server/services/git-provider";
import {
	findGitProviderById,
	removeGitProvider,
} from "@dokploy/server/services/git-provider";
import { findMemberById } from "@dokploy/server/services/user";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type GitProviderSummary = {
	gitProviderId: string;
	name: string;
	providerType: string;
	createdAt: string;
	github: {
		githubId: string;
		githubAppName: string | null;
		githubAppId: number | null;
		githubClientId: string | null;
		githubInstallationId: string | null;
		githubMirrorPrefixUrl: string | null;
		githubMirrorForwardAuth: boolean | null;
		githubApiProxyUrl: string | null;
	} | null;
	gitlab: {
		gitlabId: string;
		gitlabUrl: string;
		applicationId: string | null;
		redirectUri: string | null;
		groupName: string | null;
		expiresAt: number | null;
	} | null;
	gitea: {
		giteaId: string;
		giteaUrl: string;
		redirectUri: string | null;
		clientId: string | null;
		scopes: string | null;
		expiresAt: number | null;
		lastAuthenticatedAt: number | null;
	} | null;
	bitbucket: {
		bitbucketId: string;
		bitbucketUsername: string | null;
		bitbucketEmail: string | null;
		bitbucketWorkspaceName: string | null;
	} | null;
};

const toIsoString = (v: unknown): string => {
	if (v instanceof Date) return v.toISOString();
	return String(v ?? "");
};

const toSummary = (p: {
	gitProviderId: string;
	name: string;
	providerType: string;
	createdAt: unknown;
	github?: {
		githubId: string;
		githubAppName: string | null;
		githubAppId: number | null;
		githubClientId: string | null;
		githubInstallationId: string | null;
		githubMirrorPrefixUrl: string | null;
		githubMirrorForwardAuth: boolean | null;
		githubApiProxyUrl: string | null;
	} | null;
	gitlab?: {
		gitlabId: string;
		gitlabUrl: string;
		applicationId: string | null;
		redirectUri: string | null;
		groupName: string | null;
		expiresAt: number | null;
	} | null;
	gitea?: {
		giteaId: string;
		giteaUrl: string;
		redirectUri: string | null;
		clientId: string | null;
		scopes: string | null;
		expiresAt: number | null;
		lastAuthenticatedAt: number | null;
	} | null;
	bitbucket?: {
		bitbucketId: string;
		bitbucketUsername: string | null;
		bitbucketEmail: string | null;
		bitbucketWorkspaceName: string | null;
	} | null;
}): GitProviderSummary => {
	return {
		gitProviderId: p.gitProviderId,
		name: p.name,
		providerType: p.providerType,
		createdAt: toIsoString(p.createdAt),
		github: p.github
			? {
					githubId: p.github.githubId,
					githubAppName: p.github.githubAppName ?? null,
					githubAppId: p.github.githubAppId ?? null,
					githubClientId: p.github.githubClientId ?? null,
					githubInstallationId: p.github.githubInstallationId ?? null,
					githubMirrorPrefixUrl: p.github.githubMirrorPrefixUrl ?? null,
					githubMirrorForwardAuth:
						typeof p.github.githubMirrorForwardAuth === "boolean"
							? p.github.githubMirrorForwardAuth
							: null,
					githubApiProxyUrl: p.github.githubApiProxyUrl ?? null,
				}
			: null,
		gitlab: p.gitlab
			? {
					gitlabId: p.gitlab.gitlabId,
					gitlabUrl: p.gitlab.gitlabUrl,
					applicationId: p.gitlab.applicationId ?? null,
					redirectUri: p.gitlab.redirectUri ?? null,
					groupName: p.gitlab.groupName ?? null,
					expiresAt: p.gitlab.expiresAt ?? null,
				}
			: null,
		gitea: p.gitea
			? {
					giteaId: p.gitea.giteaId,
					giteaUrl: p.gitea.giteaUrl,
					redirectUri: p.gitea.redirectUri ?? null,
					clientId: p.gitea.clientId ?? null,
					scopes: p.gitea.scopes ?? null,
					expiresAt: p.gitea.expiresAt ?? null,
					lastAuthenticatedAt: p.gitea.lastAuthenticatedAt ?? null,
				}
			: null,
		bitbucket: p.bitbucket
			? {
					bitbucketId: p.bitbucket.bitbucketId,
					bitbucketUsername: p.bitbucket.bitbucketUsername ?? null,
					bitbucketEmail: p.bitbucket.bitbucketEmail ?? null,
					bitbucketWorkspaceName: p.bitbucket.bitbucketWorkspaceName ?? null,
				}
			: null,
	};
};

const gitProviderList: Tool<Record<string, never>, GitProviderSummary[]> = {
	name: "git_provider_list",
	description:
		"List connected git providers for the current user and organization. Secrets/tokens are never returned.",
	category: "github",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		const items = await db.query.gitProvider.findMany({
			with: {
				gitlab: true,
				bitbucket: true,
				github: true,
				gitea: true,
			},
			orderBy: desc(gitProviderTable.createdAt),
			where: and(
				eq(gitProviderTable.userId, ctx.userId),
				eq(gitProviderTable.organizationId, ctx.organizationId),
			),
		});

		return {
			success: true,
			message: `Found ${items.length} git provider(s)`,
			data: items.map((p) =>
				toSummary({
					gitProviderId: p.gitProviderId,
					name: p.name,
					providerType: p.providerType,
					createdAt: p.createdAt,
					github: p.github
						? {
								githubId: p.github.githubId,
								githubAppName: p.github.githubAppName,
								githubAppId: p.github.githubAppId,
								githubClientId: p.github.githubClientId,
								githubInstallationId: p.github.githubInstallationId,
								githubMirrorPrefixUrl: p.github.githubMirrorPrefixUrl,
								githubMirrorForwardAuth:
									typeof p.github.githubMirrorForwardAuth === "boolean"
										? p.github.githubMirrorForwardAuth
										: null,
								githubApiProxyUrl: p.github.githubApiProxyUrl,
							}
						: null,
					gitlab: p.gitlab
						? {
								gitlabId: p.gitlab.gitlabId,
								gitlabUrl: p.gitlab.gitlabUrl,
								applicationId: p.gitlab.applicationId,
								redirectUri: p.gitlab.redirectUri,
								groupName: p.gitlab.groupName,
								expiresAt: p.gitlab.expiresAt,
							}
						: null,
					gitea: p.gitea
						? {
								giteaId: p.gitea.giteaId,
								giteaUrl: p.gitea.giteaUrl,
								redirectUri: p.gitea.redirectUri,
								clientId: p.gitea.clientId,
								scopes: p.gitea.scopes,
								expiresAt: p.gitea.expiresAt,
								lastAuthenticatedAt: p.gitea.lastAuthenticatedAt,
							}
						: null,
					bitbucket: p.bitbucket
						? {
								bitbucketId: p.bitbucket.bitbucketId,
								bitbucketUsername: p.bitbucket.bitbucketUsername,
								bitbucketEmail: p.bitbucket.bitbucketEmail,
								bitbucketWorkspaceName: p.bitbucket.bitbucketWorkspaceName,
							}
						: null,
				}),
			),
		};
	},
};

const gitProviderRemove: Tool<
	{ gitProviderId: string; confirm: "CONFIRM_GIT_PROVIDER_DELETE" },
	{ deleted: boolean }
> = {
	name: "git_provider_remove",
	description:
		"Remove a git provider connection by ID. Requires approval + confirm.",
	category: "github",
	parameters: z.object({
		gitProviderId: z.string().min(1),
		confirm: z.literal("CONFIRM_GIT_PROVIDER_DELETE"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		let provider: GitProvider;
		try {
			provider = await findGitProviderById(params.gitProviderId);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Git provider not found",
				error: msg,
				data: { deleted: false },
			};
		}

		if (provider.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "You are not allowed to delete this Git provider",
				error: "UNAUTHORIZED",
				data: { deleted: false },
			};
		}

		try {
			const deleted = await removeGitProvider(params.gitProviderId);
			return {
				success: true,
				message: "Git provider removed",
				data: { deleted: Boolean(deleted) },
			};
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Error deleting this Git provider",
				error: msg,
				data: { deleted: false },
			};
		}
	},
};

export function registerGitProviderTools() {
	toolRegistry.register(gitProviderList);
	toolRegistry.register(gitProviderRemove);
}
