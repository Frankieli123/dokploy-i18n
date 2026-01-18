import { db } from "@dokploy/server/db";
import { applications } from "@dokploy/server/db/schema";
import {
	createApplication,
	deployApplication,
	findApplicationById,
	getApplicationStats,
	updateApplication,
} from "@dokploy/server/services/application";
import { removeDeployments } from "@dokploy/server/services/deployment";
import {
	containerRestart,
	getContainersByAppLabel,
} from "@dokploy/server/services/docker";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { findGithubById } from "@dokploy/server/services/github";
import { findMemberById } from "@dokploy/server/services/user";
import { removeService } from "@dokploy/server/utils/docker/utils";
import {
	removeDirectoryCode,
	removeMonitoringDirectory,
} from "@dokploy/server/utils/filesystem/directory";
import { removeTraefikConfig } from "@dokploy/server/utils/traefik/application";
import { deleteAllMiddlewares } from "@dokploy/server/utils/traefik/middleware";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const parseGithubRepoUrl = (
	repoUrl: string,
): { owner: string; repository: string } | null => {
	const trimmed = repoUrl.trim();
	if (!trimmed) return null;
	const m1 = trimmed.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i,
	);
	if (m1?.[1] && m1[2]) return { owner: m1[1], repository: m1[2] };
	const m2 = trimmed.match(/^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
	if (m2?.[1] && m2[2]) return { owner: m2[1], repository: m2[2] };
	return null;
};

const requireOrgMember = async (ctx: ToolContext) => {
	await findMemberById(ctx.userId, ctx.organizationId);
};

const applicationAccessDenied = <T>(
	message: string,
	data: T,
): ToolResult<T> => ({
	success: false,
	message,
	error: "UNAUTHORIZED",
	data,
});

const listApplications: Tool<
	{ projectId?: string },
	Array<{
		applicationId: string;
		name: string;
		status: string;
		sourceType: string;
	}>
> = {
	name: "application_list",
	description: "List all applications. Optionally filter by project.",
	category: "application",
	parameters: z.object({
		projectId: z.string().optional().describe("Filter by project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const projectId = params.projectId ?? ctx?.projectId;
		const apps = await db.query.applications.findMany({
			with: {
				environment: {
					with: { project: true },
				},
			},
		});

		const filtered = apps.filter((app) => {
			if (ctx?.organizationId) {
				if (app.environment?.project?.organizationId !== ctx.organizationId)
					return false;
			}
			if (projectId) {
				return app.environment?.project?.projectId === projectId;
			}
			return true;
		});

		return {
			success: true,
			message: `Found ${filtered.length} application(s)`,
			data: filtered.map((app) => ({
				applicationId: app.applicationId,
				name: app.name,
				status: app.applicationStatus || "idle",
				sourceType: app.sourceType,
			})),
		};
	},
};

const deleteApplication: Tool<
	{ applicationId: string },
	{ applicationId: string; deleted: boolean }
> = {
	name: "application_delete",
	description: "Delete an application and clean up its runtime resources.",
	category: "application",
	aliases: ["delete application", "remove application", "删除应用", "删除应用程序"],
	parameters: z.object({
		applicationId: z.string().min(1).describe("Application ID"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await requireOrgMember(ctx);
		const application = await findApplicationById(params.applicationId);
		if (application.environment?.project?.organizationId !== ctx.organizationId) {
			return applicationAccessDenied("Application access denied", {
				applicationId: params.applicationId,
				deleted: false,
			});
		}

		await db
			.delete(applications)
			.where(eq(applications.applicationId, params.applicationId))
			.returning();

		const nested = application as unknown as ApplicationNested;
		const cleanupOperations = [
			async () => await deleteAllMiddlewares(nested),
			async () => await removeDeployments(application),
			async () => await removeDirectoryCode(application.appName, application.serverId),
			async () =>
				await removeMonitoringDirectory(application.appName, application.serverId),
			async () => await removeTraefikConfig(application.appName, application.serverId),
			async () => await removeService(application.appName, application.serverId),
		];

		for (const operation of cleanupOperations) {
			try {
				await operation();
			} catch {}
		}

		return {
			success: true,
			message: `Application "${application.name}" deleted`,
			data: { applicationId: params.applicationId, deleted: true },
		};
	},
};

const updateApplicationGithubSource: Tool<
	{
		applicationId: string;
		githubId: string;
		owner: string;
		repository: string;
		branch: string;
		buildPath?: string;
		enableSubmodules?: boolean;
	},
	{
		applicationId: string;
		sourceType: string;
		githubId: string;
		owner: string;
		repository: string;
		branch: string;
		buildPath: string;
		enableSubmodules: boolean;
	}
> = {
	name: "application_update_github_source",
	description:
		"Configure an application to deploy from a GitHub repository (owner/repo/branch).",
	category: "application",
	parameters: z.object({
		applicationId: z.string().min(1).describe("Application ID"),
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repository: z.string().min(1).describe("Repository name"),
		branch: z.string().min(1).describe("Branch name"),
		buildPath: z
			.string()
			.optional()
			.default("/")
			.describe("Build path within repo (default /)"),
		enableSubmodules: z
			.boolean()
			.optional()
			.default(false)
			.describe("Whether to clone submodules"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const app = await findApplicationById(params.applicationId);
		if (app.environment?.project?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Application access denied",
				data: {
					applicationId: params.applicationId,
					sourceType: "",
					githubId: "",
					owner: "",
					repository: "",
					branch: "",
					buildPath: "",
					enableSubmodules: false,
				},
			};
		}

		const next = await updateApplication(params.applicationId, {
			sourceType: "github",
			githubId: params.githubId,
			owner: params.owner,
			repository: params.repository,
			branch: params.branch,
			buildPath: params.buildPath ?? "/",
			enableSubmodules: params.enableSubmodules ?? false,
		});
		if (!next) {
			return {
				success: false,
				message: "Application update failed",
				error: "Update did not return a record",
			};
		}

		return {
			success: true,
			message: "Application GitHub source updated",
			data: {
				applicationId: next.applicationId,
				sourceType: next.sourceType,
				githubId: next.githubId ?? "",
				owner: next.owner ?? "",
				repository: next.repository ?? "",
				branch: next.branch ?? "",
				buildPath: next.buildPath ?? "/",
				enableSubmodules: Boolean(next.enableSubmodules),
			},
		};
	},
};

const updateApplicationBuildConfig: Tool<
	{
		applicationId: string;
		buildType:
			| "dockerfile"
			| "heroku_buildpacks"
			| "paketo_buildpacks"
			| "nixpacks"
			| "static"
			| "railpack";
		dockerfile?: string;
		dockerContextPath?: string;
		dockerBuildStage?: string;
		herokuVersion?: string;
		railpackVersion?: string;
		publishDirectory?: string;
		isStaticSpa?: boolean;
		confirm: "CONFIRM_APPLICATION_BUILD_CONFIG";
	},
	{
		applicationId: string;
		buildType: string;
		dockerfile: string;
		dockerContextPath: string;
		dockerBuildStage: string;
		publishDirectory: string;
		isStaticSpa: boolean;
		herokuVersion: string;
		railpackVersion: string;
	}
> = {
	name: "application_update_build_config",
	description:
		"Update an application's build type and build settings (e.g. set buildType=dockerfile and dockerfile path).",
	category: "application",
	aliases: ["set build type", "dockerfile build", "build config"],
	tags: ["application", "build", "dockerfile", "nixpacks", "static"],
	parameters: z
		.object({
			applicationId: z.string().min(1).describe("Application ID"),
			buildType: z
				.enum([
					"dockerfile",
					"heroku_buildpacks",
					"paketo_buildpacks",
					"nixpacks",
					"static",
					"railpack",
				])
				.describe("Build type to use"),
			dockerfile: z
				.string()
				.optional()
				.describe('Dockerfile path (default "Dockerfile")'),
			dockerContextPath: z
				.string()
				.optional()
				.describe("Docker build context path relative to the repo"),
			dockerBuildStage: z
				.string()
				.optional()
				.describe("Optional multi-stage build target"),
			herokuVersion: z.string().optional().describe("Heroku stack version"),
			railpackVersion: z.string().optional().describe("Railpack version"),
			publishDirectory: z
				.string()
				.optional()
				.describe("Publish directory for static builds"),
			isStaticSpa: z.boolean().optional().describe("Treat static output as SPA"),
			confirm: z.literal("CONFIRM_APPLICATION_BUILD_CONFIG"),
		})
		.superRefine((val, ctx) => {
			if (val.buildType === "dockerfile") {
				const dockerfile = (val.dockerfile ?? "Dockerfile").trim();
				if (dockerfile.length === 0) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "dockerfile is required when buildType=dockerfile",
						path: ["dockerfile"],
					});
				}
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const app = await findApplicationById(params.applicationId);
		if (app.environment?.project?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Application access denied",
				data: {
					applicationId: params.applicationId,
					buildType: "",
					dockerfile: "",
					dockerContextPath: "",
					dockerBuildStage: "",
					publishDirectory: "",
					isStaticSpa: false,
					herokuVersion: "",
					railpackVersion: "",
				},
			};
		}

		const next = await updateApplication(params.applicationId, {
			buildType: params.buildType,
			...(params.buildType === "dockerfile"
				? { dockerfile: (params.dockerfile ?? "Dockerfile").trim() }
				: {}),
			...(typeof params.dockerContextPath === "string"
				? { dockerContextPath: params.dockerContextPath }
				: {}),
			...(typeof params.dockerBuildStage === "string"
				? { dockerBuildStage: params.dockerBuildStage }
				: {}),
			...(typeof params.publishDirectory === "string"
				? { publishDirectory: params.publishDirectory }
				: {}),
			...(typeof params.isStaticSpa === "boolean"
				? { isStaticSpa: params.isStaticSpa }
				: {}),
			...(typeof params.herokuVersion === "string"
				? { herokuVersion: params.herokuVersion }
				: {}),
			...(typeof params.railpackVersion === "string"
				? { railpackVersion: params.railpackVersion }
				: {}),
		});
		if (!next) {
			return {
				success: false,
				message: "Application update failed",
				error: "Update did not return a record",
			};
		}

		return {
			success: true,
			message: "Application build config updated",
			data: {
				applicationId: next.applicationId,
				buildType: next.buildType,
				dockerfile: next.dockerfile ?? "",
				dockerContextPath: next.dockerContextPath ?? "",
				dockerBuildStage: next.dockerBuildStage ?? "",
				publishDirectory: next.publishDirectory ?? "",
				isStaticSpa: Boolean(next.isStaticSpa),
				herokuVersion: next.herokuVersion ?? "",
				railpackVersion: next.railpackVersion ?? "",
			},
		};
	},
};

const findApplications: Tool<
	{ query: string; projectId?: string; limit?: number },
	Array<{
		applicationId: string;
		name: string;
		appName: string;
		projectId?: string;
	}>
> = {
	name: "application_find",
	description:
		"Find applications by keyword in name or appName. Optionally restrict search to a project.",
	category: "application",
	parameters: z.object({
		query: z.string().min(1).describe("Search keyword"),
		projectId: z
			.string()
			.optional()
			.describe("Restrict search to a project ID"),
		limit: z
			.number()
			.optional()
			.describe("Maximum number of results to return (default 20)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const q = params.query.trim().toLowerCase();
		const projectId = params.projectId ?? ctx?.projectId;
		const limit = params.limit ?? 20;

		const apps = await db.query.applications.findMany({
			with: {
				environment: {
					with: { project: true },
				},
			},
		});

		const filtered = apps
			.filter((app) => {
				if (ctx?.organizationId) {
					if (app.environment?.project?.organizationId !== ctx.organizationId)
						return false;
				}
				const appProjectId = app.environment?.project?.projectId;
				if (projectId && appProjectId !== projectId) return false;
				const name = (app.name ?? "").toLowerCase();
				const appName = (app.appName ?? "").toLowerCase();
				return name.includes(q) || appName.includes(q);
			})
			.slice(0, limit);

		return {
			success: true,
			message: `Found ${filtered.length} matching application(s)`,
			data: filtered.map((app) => ({
				applicationId: app.applicationId,
				name: app.name,
				appName: app.appName,
				projectId: app.environment?.project?.projectId,
			})),
		};
	},
};

const getApplicationDetails: Tool<
	{ applicationId: string },
	{
		applicationId: string;
		name: string;
		status: string;
		sourceType: string;
		appName: string;
	}
> = {
	name: "application_get",
	description: "Get details of a specific application by ID",
	category: "application",
	parameters: z.object({
		applicationId: z.string().describe("The application ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const app = await findApplicationById(params.applicationId);
		return {
			success: true,
			message: `Application "${app.name}" details retrieved`,
			data: {
				applicationId: app.applicationId,
				name: app.name,
				status: app.applicationStatus || "idle",
				sourceType: app.sourceType,
				appName: app.appName,
			},
		};
	},
};

const createNewApplication: Tool<
	{
		name: string;
		appName: string;
		environmentId: string;
		description?: string;
		serverId?: string;
	},
	{ applicationId: string; name: string }
> = {
	name: "application_create",
	description: "Create a new application. Requires environment ID.",
	category: "application",
	parameters: z.object({
		name: z.string().describe("Display name for the application"),
		appName: z.string().describe("Unique app name (used in container naming)"),
		environmentId: z
			.string()
			.describe("Environment ID to create application in"),
		description: z.string().optional().describe("Description"),
		serverId: z.string().optional().describe("Server ID for remote deployment"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		const env = await findEnvironmentById(params.environmentId);
		if (env.project?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Environment access denied",
				error: "UNAUTHORIZED",
				data: { applicationId: "", name: "" },
			};
		}

		const app = await createApplication({
			name: params.name,
			appName: params.appName,
			environmentId: params.environmentId,
			description: params.description,
			serverId: params.serverId ?? ctx?.serverId,
		});

		return {
			success: true,
			message: `Application "${app.name}" created successfully`,
			data: {
				applicationId: app.applicationId,
				name: app.name,
			},
		};
	},
};

const createGithubSiteAndDeploy: Tool<
	{
		name: string;
		appName: string;
		environmentId: string;
		repoUrl?: string;
		owner?: string;
		repository?: string;
		branch?: string;
		githubId?: string;
		buildPath?: string;
		enableSubmodules?: boolean;
		buildType?:
			| "dockerfile"
			| "heroku_buildpacks"
			| "paketo_buildpacks"
			| "nixpacks"
			| "static"
			| "railpack";
		dockerfile?: string;
		dockerContextPath?: string;
		dockerBuildStage?: string;
		herokuVersion?: string;
		railpackVersion?: string;
		publishDirectory?: string;
		isStaticSpa?: boolean;
		description?: string;
		serverId?: string;
		deployNow?: boolean;
		confirm: "CONFIRM_GITHUB_SITE_CREATE";
	},
	{ applicationId: string; name: string; appName: string; deployed: boolean }
> = {
	name: "application_github_create_and_deploy",
	description:
		"One-click: create an application from a GitHub repo and deploy it. Creates the app, configures GitHub source, optional build config, then deploys.",
	category: "application",
	aliases: [
		"github site",
		"github deploy site",
		"create github app and deploy",
		"one-click github deploy",
		"GitHub建站",
		"一键建站",
		"GitHub建站并上线",
		"一键部署GitHub项目",
	],
	tags: ["github", "site", "deploy", "create", "建站", "上线", "一键", "部署"],
	parameters: z
		.object({
			name: z.string().min(1).describe("Display name for the application"),
			appName: z
				.string()
				.min(1)
				.describe("Unique app name (used in container naming)"),
			environmentId: z
				.string()
				.min(1)
				.describe("Environment ID to create the app in"),
			repoUrl: z
				.string()
				.optional()
				.describe("GitHub repo URL (https://github.com/owner/repo or git@...)"),
			owner: z.string().optional().describe("Repository owner"),
			repository: z.string().optional().describe("Repository name"),
			branch: z.string().optional().default("main").describe("Branch name"),
			githubId: z
				.string()
				.optional()
				.describe("GitHub provider ID (optional if only 1 exists)"),
			buildPath: z
				.string()
				.optional()
				.default("/")
				.describe("Build path within repo (default /)"),
			enableSubmodules: z
				.boolean()
				.optional()
				.default(false)
				.describe("Whether to clone submodules"),
			buildType: z
				.enum([
					"dockerfile",
					"heroku_buildpacks",
					"paketo_buildpacks",
					"nixpacks",
					"static",
					"railpack",
				])
				.optional()
				.describe("Optional build type override"),
			dockerfile: z.string().optional().describe("Dockerfile path (default Dockerfile)"),
			dockerContextPath: z
				.string()
				.optional()
				.describe("Docker build context path relative to repo"),
			dockerBuildStage: z.string().optional().describe("Optional multi-stage build target"),
			herokuVersion: z.string().optional().describe("Heroku stack version"),
			railpackVersion: z.string().optional().describe("Railpack version"),
			publishDirectory: z.string().optional().describe("Publish directory for static builds"),
			isStaticSpa: z.boolean().optional().describe("Treat static output as SPA"),
			description: z.string().optional().describe("Description"),
			serverId: z.string().optional().describe("Server ID for remote deployment"),
			deployNow: z
				.boolean()
				.optional()
				.default(true)
				.describe("Deploy/start immediately after creation"),
			confirm: z.literal("CONFIRM_GITHUB_SITE_CREATE"),
		})
		.superRefine((val, ctx2) => {
			const hasOwnerRepo = Boolean(val.owner?.trim()) && Boolean(val.repository?.trim());
			const hasUrl = Boolean(val.repoUrl?.trim());
			if (!hasOwnerRepo && !hasUrl) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Provide either repoUrl or (owner + repository)",
					path: ["repoUrl"],
				});
			}
			if (val.buildType === "dockerfile") {
				const dockerfile = (val.dockerfile ?? "Dockerfile").trim();
				if (dockerfile.length === 0) {
					ctx2.addIssue({
						code: z.ZodIssueCode.custom,
						message: "dockerfile is required when buildType=dockerfile",
						path: ["dockerfile"],
					});
				}
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		await findMemberById(ctx.userId, ctx.organizationId);

		const env = await findEnvironmentById(params.environmentId);
		if (env.project?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Environment access denied",
				error: "UNAUTHORIZED",
				data: { applicationId: "", name: "", appName: "", deployed: false },
			};
		}

		let githubId = params.githubId?.trim() ?? "";
		if (githubId) {
			const provider = await findGithubById(githubId);
			if (provider.gitProvider?.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "GitHub provider access denied",
					error: "UNAUTHORIZED",
					data: { applicationId: "", name: "", appName: "", deployed: false },
				};
			}
		} else {
			const providers = await db.query.github.findMany({
				with: { gitProvider: true },
			});
			const filtered = providers.filter(
				(p) => p.gitProvider?.organizationId === ctx.organizationId,
			);
			if (filtered.length !== 1) {
				return {
					success: false,
					message:
						filtered.length === 0
							? "No GitHub provider found. Connect GitHub first."
							: "Multiple GitHub providers found. Specify githubId.",
					error: "MISSING_GITHUB_PROVIDER",
					data: { applicationId: "", name: "", appName: "", deployed: false },
				};
			}
			githubId = filtered[0]?.githubId ?? "";
		}

		let owner = params.owner?.trim() ?? "";
		let repository = params.repository?.trim() ?? "";
		if ((!owner || !repository) && params.repoUrl) {
			const parsed = parseGithubRepoUrl(params.repoUrl);
			if (parsed) {
				owner = parsed.owner;
				repository = parsed.repository;
			}
		}
		if (!owner || !repository) {
			return {
				success: false,
				message: "Invalid repo parameters (missing owner/repository)",
				error: "INVALID_REPO",
				data: { applicationId: "", name: "", appName: "", deployed: false },
			};
		}

		const app = await createApplication({
			name: params.name,
			appName: params.appName,
			environmentId: params.environmentId,
			description: params.description,
			serverId: params.serverId ?? ctx.serverId,
		});

		await updateApplication(app.applicationId, {
			sourceType: "github",
			githubId,
			owner,
			repository,
			branch: (params.branch ?? "main").trim() || "main",
			buildPath: params.buildPath ?? "/",
			enableSubmodules: params.enableSubmodules ?? false,
		});

		if (params.buildType) {
			await updateApplication(app.applicationId, {
				buildType: params.buildType,
				...(params.buildType === "dockerfile"
					? { dockerfile: (params.dockerfile ?? "Dockerfile").trim() }
					: {}),
				...(typeof params.dockerContextPath === "string"
					? { dockerContextPath: params.dockerContextPath }
					: {}),
				...(typeof params.dockerBuildStage === "string"
					? { dockerBuildStage: params.dockerBuildStage }
					: {}),
				...(typeof params.publishDirectory === "string"
					? { publishDirectory: params.publishDirectory }
					: {}),
				...(typeof params.isStaticSpa === "boolean"
					? { isStaticSpa: params.isStaticSpa }
					: {}),
				...(typeof params.herokuVersion === "string"
					? { herokuVersion: params.herokuVersion }
					: {}),
				...(typeof params.railpackVersion === "string"
					? { railpackVersion: params.railpackVersion }
					: {}),
			});
		}

		if (!params.deployNow) {
			return {
				success: true,
				message: `Application "${app.name}" created and configured`,
				data: {
					applicationId: app.applicationId,
					name: app.name,
					appName: app.appName,
					deployed: false,
				},
			};
		}

		try {
			await deployApplication({
				applicationId: app.applicationId,
				titleLog: "AI one-click GitHub deploy",
				descriptionLog: `Repo: ${owner}/${repository} (${params.branch ?? "main"})`,
			});
			return {
				success: true,
				message: `Application "${app.name}" created and deployed`,
				data: {
					applicationId: app.applicationId,
					name: app.name,
					appName: app.appName,
					deployed: true,
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: `Application "${app.name}" created but deployment failed`,
				error: msg,
				data: {
					applicationId: app.applicationId,
					name: app.name,
					appName: app.appName,
					deployed: false,
				},
			};
		}
	},
};

const deployApp: Tool<
	{ applicationId: string },
	{ applicationId: string; status: string }
> = {
	name: "application_deploy",
	description:
		"Deploy an application. This will build and start the application.",
	category: "application",
	parameters: z.object({
		applicationId: z.string().describe("The application ID to deploy"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params) => {
		await deployApplication({
			applicationId: params.applicationId,
			titleLog: "AI-triggered deployment",
			descriptionLog: "Deployment initiated by AI assistant",
		});
		return {
			success: true,
			message: "Application deployment started",
			data: {
				applicationId: params.applicationId,
				status: "deploying",
			},
		};
	},
};

const restartApp: Tool<
	{ applicationId: string },
	{ applicationId: string; restarted: boolean }
> = {
	name: "application_restart",
	description: "Restart an application's containers",
	category: "application",
	parameters: z.object({
		applicationId: z.string().describe("The application ID to restart"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params) => {
		const app = await findApplicationById(params.applicationId);
		const containers =
			(await getContainersByAppLabel(
				app.appName,
				"swarm",
				app.serverId ?? undefined,
			)) ?? [];

		for (const container of containers) {
			await containerRestart(container.containerId);
		}

		return {
			success: true,
			message: `Application "${app.name}" restarted (${containers.length} containers)`,
			data: {
				applicationId: params.applicationId,
				restarted: true,
			},
		};
	},
};

const getAppStatus: Tool<
	{ applicationId: string },
	{ applicationId: string; name: string; status: string; stats: unknown }
> = {
	name: "application_status",
	description: "Get the current status and resource usage of an application",
	category: "application",
	parameters: z.object({
		applicationId: z.string().describe("The application ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const app = await findApplicationById(params.applicationId);
		const stats = await getApplicationStats(app.appName);

		return {
			success: true,
			message: `Status for "${app.name}"`,
			data: {
				applicationId: app.applicationId,
				name: app.name,
				status: app.applicationStatus || "idle",
				stats: stats || { running: false },
			},
		};
	},
};

export function registerApplicationTools() {
	toolRegistry.register(listApplications);
	toolRegistry.register(getApplicationDetails);
	toolRegistry.register(findApplications);
	toolRegistry.register(deleteApplication);
	toolRegistry.register(createNewApplication);
	toolRegistry.register(createGithubSiteAndDeploy);
	toolRegistry.register(updateApplicationGithubSource);
	toolRegistry.register(updateApplicationBuildConfig);
	toolRegistry.register(deployApp);
	toolRegistry.register(restartApp);
	toolRegistry.register(getAppStatus);
}
