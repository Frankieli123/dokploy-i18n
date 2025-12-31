import { db } from "@dokploy/server/db";
import {
	createApplication,
	deployApplication,
	findApplicationById,
	getApplicationStats,
	updateApplication,
} from "@dokploy/server/services/application";
import {
	containerRestart,
	getContainersByAppLabel,
} from "@dokploy/server/services/docker";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

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
	toolRegistry.register(createNewApplication);
	toolRegistry.register(updateApplicationGithubSource);
	toolRegistry.register(updateApplicationBuildConfig);
	toolRegistry.register(deployApp);
	toolRegistry.register(restartApp);
	toolRegistry.register(getAppStatus);
}
