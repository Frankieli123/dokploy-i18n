import { z } from "zod";
import { getTrpcBridge } from "../../ai/trpc-bridge";
import { toolRegistry } from "../registry";
import type { Tool, ToolContext, ToolResult } from "../types";

const bridgeNotConfigured = () => ({
	success: false as const,
	message:
		"tRPC bridge is not configured (dokploy app must call setTrpcBridge at runtime)",
	error: "TRPC_BRIDGE_NOT_CONFIGURED",
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function callTrpc(params: {
	procedureName: string;
	input: unknown;
	ctx: ToolContext;
}): Promise<ToolResult<unknown>> {
	const bridge = getTrpcBridge();
	if (!bridge) return bridgeNotConfigured();

	try {
		const data = await bridge.callProcedure({
			procedureName: params.procedureName,
			input: params.input,
			ctx: { organizationId: params.ctx.organizationId, userId: params.ctx.userId },
		});
		return { success: true, message: "OK", data };
	} catch (error) {
		return {
			success: false,
			message: `tRPC procedure "${params.procedureName}" failed`,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

type ServiceRef = {
	serviceType:
		| "application"
		| "compose"
		| "postgres"
		| "mysql"
		| "mariadb"
		| "mongo"
		| "redis";
	serviceId: string;
	name: string;
	appName?: string | null;
	serverId?: string | null;
	buildServerId?: string | null;
	environmentId: string;
	projectId: string;
	domains?: Array<{ domainId: string; host?: string | null }>;
};

type ProjectInventory = {
	projectId: string;
	name: string;
	environments: Array<{
		environmentId: string;
		name?: string | null;
		services: ServiceRef[];
	}>;
};

type ProjectSummary = { projectId: string; name: string };
type ResolveSingleProjectData =
	| Record<string, unknown>
	| { matches: ProjectSummary[] }
	| { projects: ProjectSummary[] };

function pickId(obj: Record<string, unknown>, keys: string[]): string | null {
	for (const k of keys) {
		const v = asNonEmptyString(obj[k]);
		if (v) return v;
	}
	return null;
}

function pickDomains(obj: Record<string, unknown>): ServiceRef["domains"] | undefined {
	const domains = obj.domains;
	if (!Array.isArray(domains) || domains.length === 0) return undefined;
	const out: Array<{ domainId: string; host?: string | null }> = [];
	for (const d of domains) {
		if (!isRecord(d)) continue;
		const domainId = asNonEmptyString(d.domainId);
		if (!domainId) continue;
		out.push({ domainId, host: asNonEmptyString(d.host) });
	}
	return out.length > 0 ? out : undefined;
}

function normalizeService(params: {
	projectId: string;
	environmentId: string;
	serviceType: ServiceRef["serviceType"];
	obj: unknown;
}): ServiceRef | null {
	if (!isRecord(params.obj)) return null;
	const serviceId = pickId(params.obj, [
		"applicationId",
		"composeId",
		"postgresId",
		"mysqlId",
		"mariadbId",
		"mongoId",
		"redisId",
	]);
	const name = asNonEmptyString(params.obj.name);
	if (!serviceId || !name) return null;

	const appName = asNonEmptyString(params.obj.appName);
	const serverId = asNonEmptyString(params.obj.serverId);
	const buildServerId = asNonEmptyString(params.obj.buildServerId);
	const domains = pickDomains(params.obj);

	return {
		projectId: params.projectId,
		environmentId: params.environmentId,
		serviceType: params.serviceType,
		serviceId,
		name,
		...(appName ? { appName } : {}),
		...(serverId ? { serverId } : {}),
		...(buildServerId ? { buildServerId } : {}),
		...(domains ? { domains } : {}),
	};
}

function normalizeProject(raw: unknown): ProjectInventory | null {
	if (!isRecord(raw)) return null;
	const projectId = asNonEmptyString(raw.projectId);
	const name = asNonEmptyString(raw.name);
	if (!projectId || !name) return null;

	const environmentsRaw = asArray(raw.environments);
	const environments: ProjectInventory["environments"] = [];

	for (const envRaw of environmentsRaw) {
		if (!isRecord(envRaw)) continue;
		const environmentId = asNonEmptyString(envRaw.environmentId);
		if (!environmentId) continue;
		const envName = asNonEmptyString(envRaw.name);

		const services: ServiceRef[] = [];
		for (const a of asArray(envRaw.applications)) {
			const s = normalizeService({
				projectId,
				environmentId,
				serviceType: "application",
				obj: a,
			});
			if (s) services.push(s);
		}
		for (const a of asArray(envRaw.compose)) {
			const s = normalizeService({
				projectId,
				environmentId,
				serviceType: "compose",
				obj: a,
			});
			if (s) services.push(s);
		}
		for (const a of asArray(envRaw.postgres)) {
			const s = normalizeService({
				projectId,
				environmentId,
				serviceType: "postgres",
				obj: a,
			});
			if (s) services.push(s);
		}
		for (const a of asArray(envRaw.mysql)) {
			const s = normalizeService({
				projectId,
				environmentId,
				serviceType: "mysql",
				obj: a,
			});
			if (s) services.push(s);
		}
		for (const a of asArray(envRaw.mariadb)) {
			const s = normalizeService({
				projectId,
				environmentId,
				serviceType: "mariadb",
				obj: a,
			});
			if (s) services.push(s);
		}
		for (const a of asArray(envRaw.mongo)) {
			const s = normalizeService({
				projectId,
				environmentId,
				serviceType: "mongo",
				obj: a,
			});
			if (s) services.push(s);
		}
		for (const a of asArray(envRaw.redis)) {
			const s = normalizeService({
				projectId,
				environmentId,
				serviceType: "redis",
				obj: a,
			});
			if (s) services.push(s);
		}

		environments.push({
			environmentId,
			...(envName ? { name: envName } : {}),
			services,
		});
	}

	return { projectId, name, environments };
}

async function resolveSingleProject(params: {
	projectId?: string;
	projectName?: string;
	ctx: ToolContext;
}): Promise<ToolResult<ResolveSingleProjectData>> {
	const directId = asNonEmptyString(params.projectId);
	if (directId) {
		const res = await callTrpc({
			procedureName: "project.one",
			input: { projectId: directId },
			ctx: params.ctx,
		});
		if (!res.success) return res as ToolResult<ResolveSingleProjectData>;
		if (!isRecord(res.data)) {
			return { success: false, message: "Project not found" };
		}
		return { success: true, message: "Project loaded", data: res.data };
	}

	const name = asNonEmptyString(params.projectName);
	if (!name) {
		return {
			success: false,
			message: "Missing projectId or projectName",
			error: "PROJECT_NOT_SPECIFIED",
		};
	}

	const listRes = await callTrpc({
		procedureName: "project.all",
		input: undefined,
		ctx: params.ctx,
	});
	if (!listRes.success) return listRes as ToolResult<ResolveSingleProjectData>;

	const candidates = asArray(listRes.data)
		.map((raw) => {
			if (!isRecord(raw)) return null;
			const projectId = asNonEmptyString(raw.projectId);
			const projectName = asNonEmptyString(raw.name);
			if (!projectId || !projectName) return null;
			return {
				summary: { projectId, name: projectName } satisfies ProjectSummary,
				raw,
			};
		})
		.filter(
			(v): v is { summary: ProjectSummary; raw: Record<string, unknown> } =>
				!!v,
		);

	const q = name.toLowerCase();
	const matches = candidates.filter((p) =>
		p.summary.name.toLowerCase().includes(q),
	);

	if (matches.length === 0) {
		return {
			success: false,
			message: `No project name matches "${name}"`,
			data: {
				projects: candidates.slice(0, 20).map((p) => p.summary),
			},
		};
	}

	if (matches.length > 1) {
		return {
			success: false,
			message: `Multiple projects match "${name}"`,
			data: {
				matches: matches.slice(0, 20).map((p) => p.summary),
			},
		};
	}

	const match = matches[0];
	if (!match) {
		return { success: false, message: "Project not found" };
	}
	return { success: true, message: "Project loaded", data: match.raw };
}

const projectsInventory: Tool<
	{
		projectId?: string;
		projectName?: string;
		limit?: number;
		includeServices?: boolean;
	},
	{
		projects: ProjectInventory[];
	}
> = {
	name: "projects_inventory",
	description:
		"Read projects/environments/services inventory (IDs, appName, serverId). Supports selecting a single project by id or name.",
	category: "project",
	tags: ["project", "projects", "inventory", "applications", "containers", "ids"],
	parameters: z.object({
		projectId: z.string().optional(),
		projectName: z.string().optional(),
		limit: z.number().min(1).max(50).optional().default(50),
		includeServices: z.boolean().optional().default(true),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const bridge = getTrpcBridge();
		if (!bridge) return bridgeNotConfigured();

			const wantSingle = asNonEmptyString(params.projectId) || asNonEmptyString(params.projectName);
			if (wantSingle) {
				const single = await resolveSingleProject({
					projectId: params.projectId,
					projectName: params.projectName,
					ctx,
				});
				if (!single.success) return single as ToolResult<{ projects: ProjectInventory[] }>;
				if (!isRecord(single.data)) {
					return { success: false, message: "Project not found" };
				}
				const p = normalizeProject(single.data);
				if (!p) return { success: false, message: "Project not found" };
				const out = params.includeServices
					? p
					: { projectId: p.projectId, name: p.name, environments: [] as any[] };
				return {
					success: true,
					message: "Project inventory loaded",
					data: { projects: [out as ProjectInventory] },
				};
			}

		const res = await callTrpc({
			procedureName: "project.all",
			input: undefined,
			ctx,
		});
		if (!res.success) return res as ToolResult<{ projects: ProjectInventory[] }>;

		const projects = asArray(res.data)
			.map((p) => normalizeProject(p))
			.filter((p): p is ProjectInventory => !!p)
			.slice(0, params.limit);

		if (!params.includeServices) {
			return {
				success: true,
				message: `Loaded ${projects.length} project(s)`,
				data: {
					projects: projects.map((p) => ({
						projectId: p.projectId,
						name: p.name,
						environments: [],
					})),
				},
			};
		}

		return {
			success: true,
			message: `Loaded ${projects.length} project(s)`,
			data: { projects },
		};
	},
};

const projectContainers: Tool<
	{
		projectId?: string;
		projectName?: string;
		includeUnmatched?: boolean;
		limitPerServer?: number;
	},
	{
		project: { projectId: string; name: string };
		servers: Array<{
			serverId: string | null;
			containers: Array<{
				containerId: string;
				name: string;
				image?: string | null;
				state?: string | null;
				status?: string | null;
				ports?: string | null;
				matchedService?: Pick<ServiceRef, "serviceType" | "serviceId" | "name" | "appName">;
			}>;
		}>;
	}
> = {
	name: "project_containers",
	description:
		"List docker containers associated with a Dokploy project by matching services.appName (groups by server). If includeUnmatched=true and the project has no appName services, it falls back to listing containers from the current server context without matching.",
	category: "server",
	tags: ["docker", "containers", "project", "logs", "inventory"],
	parameters: z.object({
		projectId: z.string().optional(),
		projectName: z.string().optional(),
		includeUnmatched: z
			.boolean()
			.optional()
			.default(false)
			.describe(
				"Include containers that do not match any service appName. If the project has no appName services, this returns containers from the current server context without matching.",
			),
		limitPerServer: z.number().min(1).max(2000).optional().default(400),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const limitPerServer = typeof params.limitPerServer === "number" ? params.limitPerServer : 400;
		const includeUnmatched = params.includeUnmatched === true;

		const single = await resolveSingleProject({
			projectId: params.projectId ?? ctx.projectId,
			projectName: params.projectName,
			ctx,
		});
		if (!single.success) return single as any;
		if (!isRecord(single.data)) {
			return { success: false, message: "Project not found" };
		}
		const project = normalizeProject(single.data);
		if (!project) return { success: false, message: "Project not found" };

		const services = project.environments.flatMap((e) => e.services);
		const byServerKey = new Map<string, ServiceRef[]>();
		for (const s of services) {
			const appName = asNonEmptyString(s.appName);
			if (!appName) continue;
			const serverKey = asNonEmptyString(s.serverId) ?? "__local__";
			const arr = byServerKey.get(serverKey) ?? [];
			arr.push(s);
			byServerKey.set(serverKey, arr);
		}

		if (byServerKey.size === 0) {
			if (includeUnmatched) {
				const serverId = asNonEmptyString(ctx.serverId);
				const containersRes = await callTrpc({
					procedureName: "docker.getContainers",
					input: serverId ? { serverId } : {},
					ctx,
				});

				const rawContainers = containersRes.success ? asArray(containersRes.data) : [];
				const containers: Array<{
					containerId: string;
					name: string;
					image?: string | null;
					state?: string | null;
					status?: string | null;
					ports?: string | null;
					matchedService?: Pick<ServiceRef, "serviceType" | "serviceId" | "name" | "appName">;
				}> = [];

				for (const c of rawContainers) {
					if (!isRecord(c)) continue;
					const containerId = asNonEmptyString(c.containerId);
					const name = asNonEmptyString(c.name);
					if (!containerId || !name) continue;

					containers.push({
						containerId,
						name,
						image: asNonEmptyString(c.image),
						state: asNonEmptyString(c.state),
						status: asNonEmptyString(c.status),
						ports: asNonEmptyString(c.ports),
						matchedService: undefined,
					});

					if (containers.length >= limitPerServer) break;
				}

				return {
					success: true,
					message:
						"No Dokploy services with appName were found in this project; listing containers from the current server context without matching (unmatched).",
					data: {
						project: { projectId: project.projectId, name: project.name },
						servers: [{ serverId: serverId ?? null, containers }],
					},
				};
			}

			return {
				success: true,
				message:
					"No Dokploy services with appName were found in this project (this does not mean there are no running containers)",
				data: { project: { projectId: project.projectId, name: project.name }, servers: [] },
			};
		}

		const servers: Array<{
			serverId: string | null;
			containers: Array<{
				containerId: string;
				name: string;
				image?: string | null;
				state?: string | null;
				status?: string | null;
				ports?: string | null;
				matchedService?: Pick<ServiceRef, "serviceType" | "serviceId" | "name" | "appName">;
			}>;
		}> = [];

		for (const [serverKey, svcList] of byServerKey) {
			const serverId = serverKey === "__local__" ? null : serverKey;
			const appNames = Array.from(
				new Set(
					svcList
						.map((s) => asNonEmptyString(s.appName))
						.filter((v): v is string => !!v),
				),
			).slice(0, 200);

			const svcByAppName = new Map<string, ServiceRef>();
			for (const s of svcList) {
				const a = asNonEmptyString(s.appName);
				if (!a) continue;
				const k = a.toLowerCase();
				if (!svcByAppName.has(k)) svcByAppName.set(k, s);
			}

			const pattern = appNames.map(escapeRegex).join("|");
			const matcher =
				pattern.length > 0
					? new RegExp(`^(${pattern})(?:[._-]|$)`, "i")
					: null;

			const containersRes = await callTrpc({
				procedureName: "docker.getContainers",
				input: serverId ? { serverId } : {},
				ctx,
			});
			if (!containersRes.success) {
				servers.push({
					serverId,
					containers: [
						{
							containerId: "",
							name: "",
							status: null,
							state: null,
							image: null,
							ports: null,
							matchedService: undefined,
						},
					].slice(0, 0),
				});
				continue;
			}

			const rawContainers = asArray(containersRes.data);
			const containers: Array<{
				containerId: string;
				name: string;
				image?: string | null;
				state?: string | null;
				status?: string | null;
				ports?: string | null;
				matchedService?: Pick<ServiceRef, "serviceType" | "serviceId" | "name" | "appName">;
			}> = [];

			for (const c of rawContainers) {
				if (!isRecord(c)) continue;
				const containerId = asNonEmptyString(c.containerId);
				const name = asNonEmptyString(c.name);
				if (!containerId || !name) continue;
				const m = matcher ? matcher.exec(name) : null;
				const matchedApp = m?.[1] ? m[1].toLowerCase() : null;
				const svc = matchedApp ? svcByAppName.get(matchedApp) : undefined;

				if (!includeUnmatched && !svc) continue;

				containers.push({
					containerId,
					name,
					image: asNonEmptyString(c.image),
					state: asNonEmptyString(c.state),
					status: asNonEmptyString(c.status),
					ports: asNonEmptyString(c.ports),
					matchedService: svc
						? {
								serviceType: svc.serviceType,
								serviceId: svc.serviceId,
								name: svc.name,
								appName: svc.appName,
							}
						: undefined,
				});

				if (containers.length >= limitPerServer) break;
			}

			servers.push({ serverId, containers });
		}

		return {
			success: true,
			message: `Loaded containers for project "${project.name}"`,
			data: { project: { projectId: project.projectId, name: project.name }, servers },
		};
	},
};

export function registerInventoryTools() {
	toolRegistry.register(projectsInventory);
	toolRegistry.register(projectContainers);
}
