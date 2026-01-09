import { IS_CLOUD } from "@dokploy/server/constants";
import { getNodeInfo, getSwarmNodes } from "@dokploy/server/services/docker";
import { findServerById, getAllServers } from "@dokploy/server/services/server";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const shSingleQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const truncate = (value: string, maxChars: number) => {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n...[TRUNCATED to ${maxChars} chars]`;
};

const matchesAny = (command: string, patterns: RegExp[]) =>
	patterns.some((p) => p.test(command));

const DANGEROUS_PATTERNS: RegExp[] = [
	/\brm\b\s+-rf\s+\/(\s|$)/i,
	/\bmkfs(\.|\b)/i,
	/\bdd\b\s+if=/i,
	/\bdd\b\s+of=/i,
	/\bwipefs\b/i,
	/\bfdisk\b/i,
	/\bsfdisk\b/i,
	/\bparted\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bpoweroff\b/i,
	/\bhalt\b/i,
	/\bkill\b\s+-9\s+-1\b/i,
	/\bcurl\b[\s\S]*\|\s*(bash|sh)\b/i,
	/\bwget\b[\s\S]*\|\s*(bash|sh)\b/i,
];

const normalizeCommand = (command: string) => command.trim();

const buildWrappedCommand = (
	command: string,
	opts: { cwd?: string; timeoutMs?: number },
) => {
	const cmd = normalizeCommand(command);
	const body = opts.cwd ? `cd ${shSingleQuote(opts.cwd)} && ${cmd}` : cmd;
	const wrapped = `bash -lc ${shSingleQuote(body)}`;
	if (!opts.timeoutMs) return wrapped;
	const timeoutSeconds = Math.ceil(opts.timeoutMs / 1000);
	return `timeout ${timeoutSeconds}s ${wrapped}`;
};

type ServerExecResultData = {
	stdout: string;
	stderr: string;
	exitHint?: string;
	servers?: Array<{ serverId: string; name: string; ipAddress: string }>;
};

async function resolveDefaultServerId(organizationId: string): Promise<
	| {
			pickedServerId: string;
			candidates: Array<{ serverId: string; name: string; ipAddress: string }>;
	  }
	| {
			pickedServerId: null;
			candidates: Array<{ serverId: string; name: string; ipAddress: string }>;
	  }
> {
	const servers = await getAllServers();
	const orgServers = servers.filter((s) => s.organizationId === organizationId);
	const activeServers = orgServers.filter((s) => s.serverStatus === "active");
	const deployServers = activeServers.filter((s) => s.serverType === "deploy");
	const candidatesRaw =
		deployServers.length > 0 ? deployServers : activeServers;
	const candidates = candidatesRaw.map((s) => ({
		serverId: s.serverId,
		name: s.name,
		ipAddress: s.ipAddress,
	}));
	if (candidates.length === 1) {
		return { pickedServerId: candidates[0]!.serverId, candidates };
	}
	return { pickedServerId: null, candidates };
}

const serverExec: Tool<
	{
		serverId?: string;
		command: string;
		cwd?: string;
		timeoutMs?: number;
		maxOutputChars?: number;
		allowNetwork?: boolean;
		allowWrite?: boolean;
		allowUnsafe?: boolean;
		confirm: "EXECUTE" | "EXECUTE_UNSAFE";
	},
	ServerExecResultData
> = {
	name: "server_exec",
	description:
		"Execute a command on a target server. High-risk tool: requires approval and an explicit confirm token. Blocks extremely dangerous commands unless allowUnsafe=true + confirm=EXECUTE_UNSAFE.",
	category: "server",
	parameters: z
		.object({
			serverId: z
				.string()
				.optional()
				.describe("Target serverId (defaults to conversation serverId)"),
			command: z.string().min(1).describe("Shell command to execute"),
			cwd: z
				.string()
				.optional()
				.describe("Working directory on the target server"),
			timeoutMs: z
				.number()
				.int()
				.min(1000)
				.max(600000)
				.optional()
				.default(15000),
			maxOutputChars: z
				.number()
				.int()
				.min(1000)
				.max(200000)
				.optional()
				.default(20000),
			allowNetwork: z.boolean().optional().default(false),
			allowWrite: z.boolean().optional().default(false),
			allowUnsafe: z.boolean().optional().default(false),
			confirm: z.enum(["EXECUTE", "EXECUTE_UNSAFE"]),
		})
		.superRefine((val, ctx) => {
			if (val.allowUnsafe && val.confirm !== "EXECUTE_UNSAFE") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "allowUnsafe=true requires confirm=EXECUTE_UNSAFE",
				});
			}
			if (!val.allowUnsafe && val.confirm !== "EXECUTE") {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						"confirm must be EXECUTE (use allowUnsafe + EXECUTE_UNSAFE for dangerous commands)",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId ?? null;
		if (!serverId && IS_CLOUD) {
			const resolved = await resolveDefaultServerId(ctx.organizationId);
			return {
				success: false,
				message:
					"serverId is required in cloud mode (either pass serverId or set a conversation serverId)",
				error: "MISSING_SERVER_ID",
				data: { stdout: "", stderr: "", servers: resolved.candidates },
			};
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Server access denied",
					error: "UNAUTHORIZED",
					data: { stdout: "", stderr: "" },
				};
			}
		}

		const command = normalizeCommand(params.command);
		if (command.length > 20000) {
			return {
				success: false,
				message: "Command too long",
				error: "COMMAND_TOO_LONG",
				data: { stdout: "", stderr: "" },
			};
		}

		const isDangerous = matchesAny(command, DANGEROUS_PATTERNS);
		if (isDangerous && !params.allowUnsafe) {
			return {
				success: false,
				message:
					"Command blocked: extremely dangerous patterns detected. Use allowUnsafe=true and confirm=EXECUTE_UNSAFE if you really intend to run it.",
				error: "DANGEROUS_COMMAND_BLOCKED",
				data: { stdout: "", stderr: "" },
			};
		}

		const wrapped = buildWrappedCommand(command, {
			cwd: params.cwd,
			timeoutMs: params.timeoutMs,
		});

		try {
			const result = serverId
				? await execAsyncRemote(serverId, wrapped)
				: await execAsync(wrapped);
			return {
				success: true,
				message: "Command executed",
				data: {
					stdout: truncate(result.stdout ?? "", params.maxOutputChars ?? 20000),
					stderr: truncate(result.stderr ?? "", params.maxOutputChars ?? 20000),
					...(serverId ? {} : { exitHint: "local" }),
				},
			};
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			// Best-effort: also try local exec if server has no SSH key? But keep strict for safety.
			return {
				success: false,
				message: "Command execution failed",
				error: msg,
				data: { stdout: "", stderr: "" },
			};
		}
	},
};

const listServers: Tool<
	Record<string, never>,
	Array<{
		serverId: string;
		name: string;
		username: string;
		ipAddress: string;
		serverStatus: string;
	}>
> = {
	name: "server_list",
	description: "List all registered servers in the organization",
	category: "server",
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const servers = await getAllServers();
		const filtered = ctx?.organizationId
			? servers.filter((s) => s.organizationId === ctx.organizationId)
			: servers;
		return {
			success: true,
			message: `Found ${filtered.length} server(s)`,
			data: filtered.map((s) => ({
				serverId: s.serverId,
				name: s.name,
				username: s.username ?? "root",
				ipAddress: s.ipAddress,
				serverStatus: s.serverStatus || "active",
			})),
		};
	},
};

const findServers: Tool<
	{ query: string; limit?: number },
	Array<{
		serverId: string;
		name: string;
		username: string;
		ipAddress: string;
		serverStatus: string;
	}>
> = {
	name: "server_find",
	description: "Find servers by keyword in name or IP address",
	category: "server",
	parameters: z.object({
		query: z.string().min(1).describe("Search keyword"),
		limit: z
			.number()
			.optional()
			.describe("Maximum number of results to return (default 20)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const q = params.query.trim().toLowerCase();
		const limit = params.limit ?? 20;
		const servers = await getAllServers();
		const matches = servers
			.filter((s) => {
				if (ctx?.organizationId && s.organizationId !== ctx.organizationId)
					return false;
				const name = (s.name ?? "").toLowerCase();
				const ip = (s.ipAddress ?? "").toLowerCase();
				return name.includes(q) || ip.includes(q);
			})
			.slice(0, limit);

		return {
			success: true,
			message: `Found ${matches.length} matching server(s)`,
			data: matches.map((s) => ({
				serverId: s.serverId,
				name: s.name,
				username: s.username ?? "root",
				ipAddress: s.ipAddress,
				serverStatus: s.serverStatus || "active",
			})),
		};
	},
};

const getServerDetails: Tool<
	{ serverId: string },
	{
		serverId: string;
		name: string;
		ipAddress: string;
		serverStatus: string;
		sshKeyId: string | null;
	}
> = {
	name: "server_get",
	description: "Get details of a specific server by ID",
	category: "server",
	parameters: z.object({
		serverId: z.string().describe("The server ID"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const srv = await findServerById(params.serverId);
		return {
			success: true,
			message: `Server "${srv.name}" details retrieved`,
			data: {
				serverId: srv.serverId,
				name: srv.name,
				ipAddress: srv.ipAddress,
				serverStatus: srv.serverStatus || "active",
				sshKeyId: srv.sshKeyId,
			},
		};
	},
};

const getServerStatus: Tool<
	{ serverId?: string },
	{ nodes?: unknown; info?: unknown }
> = {
	name: "server_status",
	description:
		"Get Docker Swarm status and node information for the local or specified server",
	category: "server",
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (optional, defaults to local)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx?.serverId;
		if (serverId) {
			const srv = await findServerById(serverId);
			if (ctx?.organizationId && srv.organizationId !== ctx.organizationId) {
				return {
					success: false,
					message: "Server access denied",
					data: {},
				};
			}
			return {
				success: true,
				message: `Server "${srv.name}" is registered`,
				data: {
					info: {
						serverId: srv.serverId,
						name: srv.name,
						ipAddress: srv.ipAddress,
						status: srv.serverStatus || "active",
					},
				},
			};
		}

		const nodes = await getSwarmNodes();
		const nodeId =
			Array.isArray(nodes) && nodes.length > 0 ? nodes[0]?.ID : null;
		const info = nodeId ? await getNodeInfo(nodeId).catch(() => null) : null;

		return {
			success: true,
			message: "Local Docker status retrieved",
			data: {
				nodes: Array.isArray(nodes)
					? nodes.map(
							(n: {
								ID: string;
								Description?: { Hostname?: string };
								Status?: { State?: string };
							}) => ({
								id: n.ID,
								hostname: n.Description?.Hostname,
								state: n.Status?.State,
							}),
						)
					: undefined,
				info: info
					? {
							containers: (info as { Containers?: number }).Containers,
							containersRunning: (info as { ContainersRunning?: number })
								.ContainersRunning,
							containersPaused: (info as { ContainersPaused?: number })
								.ContainersPaused,
							containersStopped: (info as { ContainersStopped?: number })
								.ContainersStopped,
							images: (info as { Images?: number }).Images,
							memoryLimit: (info as { MemoryLimit?: number }).MemoryLimit,
							cpus: (info as { NCPU?: number }).NCPU,
							memTotal: (info as { MemTotal?: number }).MemTotal,
						}
					: null,
			},
		};
	},
};

export function registerServerTools() {
	toolRegistry.register(listServers);
	toolRegistry.register(findServers);
	toolRegistry.register(getServerDetails);
	toolRegistry.register(getServerStatus);
	toolRegistry.register(serverExec);
}
