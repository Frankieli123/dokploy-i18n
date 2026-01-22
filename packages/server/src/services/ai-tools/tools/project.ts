import { db } from "@dokploy/server/db";
import { projects } from "@dokploy/server/db/schema";
import {
	createProject,
	deleteProjectWithCleanup,
	findProjectById,
	updateProjectById,
} from "@dokploy/server/services/project";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const listProjects: Tool<
	{ limit?: number },
	Array<{
		projectId: string;
		name: string;
		description: string | null;
		environmentCount: number;
	}>
> = {
	name: "project_list",
	description: "List all projects in the organization",
	category: "project",
	parameters: z.object({
		limit: z
			.number()
			.optional()
			.describe("Maximum number of projects to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const allProjects = await db.query.projects.findMany({
			where: ctx?.organizationId
				? eq(projects.organizationId, ctx.organizationId)
				: undefined,
			with: {
				environments: true,
			},
			limit: params.limit || 50,
		});

		return {
			success: true,
			message: `Found ${allProjects.length} project(s)`,
			data: allProjects.map((p) => ({
				projectId: p.projectId,
				name: p.name,
				description: p.description,
				environmentCount: p.environments?.length || 0,
			})),
		};
	},
};

const findProjects: Tool<
	{ query?: string; name?: string; limit?: number },
	Array<{ projectId: string; name: string; description: string | null }>
> = {
	name: "project_find",
	description: "Find projects by keyword in name or description",
	category: "project",
	parameters: z
		.object({
			query: z.string().min(1).optional().describe("Search keyword"),
			name: z.string().min(1).optional().describe("Search keyword (alias)"),
			limit: z
				.number()
				.optional()
				.describe("Maximum number of results to return (default 20)"),
		})
		.refine((v) => Boolean(v.query || v.name), {
			message: "Either 'query' or 'name' is required",
		}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const rawQuery = (params as unknown as { query?: string; name?: string })
			.query;
		const rawName = (params as unknown as { query?: string; name?: string }).name;
		const q = (rawQuery ?? rawName ?? "").trim().toLowerCase();
		const limit = params.limit ?? 20;

		const allProjects = await db.query.projects.findMany({
			where: ctx?.organizationId
				? eq(projects.organizationId, ctx.organizationId)
				: undefined,
			limit: 200,
		});

		const matches = allProjects
			.filter((p) => {
				const name = (p.name ?? "").toLowerCase();
				const description = (p.description ?? "").toLowerCase();
				return name.includes(q) || description.includes(q);
			})
			.slice(0, limit);

		return {
			success: true,
			message: `Found ${matches.length} matching project(s)`,
			data: matches.map((p) => ({
				projectId: p.projectId,
				name: p.name,
				description: p.description,
			})),
		};
	},
};

const getProjectDetails: Tool<
	{ projectId: string },
	{
		projectId: string;
		name: string;
		description: string | null;
		environments: Array<{
			environmentId: string;
			name: string;
			serviceCount: number;
		}>;
	}
> = {
	name: "project_get",
	description: "Get details of a specific project including its environments",
	category: "project",
	parameters: z.object({
		projectId: z.string().describe("The project ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const project = await findProjectById(params.projectId);
		if (ctx?.organizationId && project.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Project access denied",
				data: { projectId: "", name: "", description: null, environments: [] },
			};
		}
		return {
			success: true,
			message: `Project "${project.name}" details retrieved`,
			data: {
				projectId: project.projectId,
				name: project.name,
				description: project.description,
				environments: project.environments.map((env) => ({
					environmentId: env.environmentId,
					name: env.name,
					serviceCount:
						(env.applications?.length || 0) +
						(env.postgres?.length || 0) +
						(env.mysql?.length || 0) +
						(env.mariadb?.length || 0) +
						(env.mongo?.length || 0) +
						(env.redis?.length || 0) +
						(env.compose?.length || 0),
				})),
			},
		};
	},
};

const createNewProject: Tool<
	{ name: string; description?: string },
	{ projectId: string; name: string; environmentId: string }
> = {
	name: "project_create",
	description:
		"Create a new project. A production environment is automatically created.",
	category: "project",
	parameters: z.object({
		name: z.string().describe("Name of the project"),
		description: z.string().optional().describe("Description of the project"),
	}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		if (!ctx?.organizationId) {
			return {
				success: false,
				message: "Organization ID is required",
				data: { projectId: "", name: "", environmentId: "" },
			};
		}

		const normalizedName = String(params.name ?? "").trim();
		if (normalizedName.length === 0) {
			return {
				success: false,
				message: "Project name is required",
				data: { projectId: "", name: "", environmentId: "" },
			};
		}

		const result = await createProject(
			{
				name: normalizedName,
				description: params.description || null,
			},
			ctx.organizationId,
		);

		return {
			success: true,
			message: `Project "${result.project.name}" created with production environment`,
			data: {
				projectId: result.project.projectId,
				name: result.project.name,
				environmentId: result.environment.environmentId,
			},
		};
	},
};

const updateProjectTool: Tool<
	{ projectId: string; name?: string; description?: string | null },
	{ projectId: string; name: string; description: string | null }
> = {
	name: "project_update",
	description: "Update a project's name and/or description",
	category: "project",
	parameters: z
		.object({
			projectId: z.string().min(1).describe("The project ID to update"),
			name: z.string().optional().describe("New project name"),
			description: z
				.string()
				.optional()
				.nullable()
				.describe("New project description (empty/null clears)"),
		})
		.refine((v) => Boolean(v.name?.trim()) || typeof v.description !== "undefined", {
			message: "Provide at least one field to update: name or description",
		}),
	riskLevel: "medium",
	requiresApproval: true,
	execute: async (params, ctx) => {
		if (!ctx?.organizationId) {
			return {
				success: false,
				message: "Organization ID is required",
				data: { projectId: "", name: "", description: null },
			};
		}

		const project = await findProjectById(params.projectId);
		if (project.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Project access denied",
				data: { projectId: "", name: "", description: null },
			};
		}

		const updates: { name?: string; description?: string | null } = {};

		if (typeof params.name === "string") {
			const normalizedName = params.name.trim();
			if (normalizedName.length === 0) {
				return {
					success: false,
					message: "Project name cannot be empty",
					data: { projectId: project.projectId, name: project.name, description: project.description },
				};
			}
			updates.name = normalizedName;
		}

		if (typeof params.description !== "undefined") {
			if (params.description == null) {
				updates.description = null;
			} else {
				const normalized = params.description.trim();
				updates.description = normalized.length > 0 ? normalized : null;
			}
		}

		const updated = await updateProjectById(params.projectId, updates);
		if (!updated) {
			return {
				success: false,
				message: "Failed to update project",
				data: { projectId: project.projectId, name: project.name, description: project.description },
			};
		}

		return {
			success: true,
			message: `Project "${updated.name}" updated`,
			data: {
				projectId: updated.projectId,
				name: updated.name,
				description: updated.description,
			},
		};
	},
};

const deleteProjectTool: Tool<
	{ projectId: string },
	{ projectId: string; deleted: boolean }
> = {
	name: "project_delete",
	description:
		"Delete a project and all its environments and services. This action is irreversible.",
	category: "project",
	parameters: z.object({
		projectId: z.string().describe("The project ID to delete"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const project = await findProjectById(params.projectId);
		if (ctx?.organizationId && project.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "Project access denied",
				data: { projectId: "", deleted: false },
			};
		}
		await deleteProjectWithCleanup({
			projectId: params.projectId,
			deleteComposeVolumes: true,
			deleteDatabaseVolumes: true,
			deleteApplicationVolumes: true,
		});

		return {
			success: true,
			message: `Project "${project.name}" has been deleted`,
			data: {
				projectId: params.projectId,
				deleted: true,
			},
		};
	},
};

export function registerProjectTools() {
	toolRegistry.register(listProjects);
	toolRegistry.register(getProjectDetails);
	toolRegistry.register(findProjects);
	toolRegistry.register(createNewProject);
	toolRegistry.register(updateProjectTool);
	toolRegistry.register(deleteProjectTool);
}
