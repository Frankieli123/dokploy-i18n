import { IS_CLOUD } from "@dokploy/server/constants";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import { getContainersByAppNameMatch } from "@dokploy/server/services/docker";
import { checkServiceAccess } from "@dokploy/server/services/user";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

function shQuote(value: string): string {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function clampMaxChars(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1000, Math.min(200_000, Math.floor(n)));
}

function clampTimeoutMs(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1000, Math.min(10 * 60_000, Math.floor(n)));
}

function clampMaxBufferBytes(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(64_000, Math.min(50_000_000, Math.floor(n)));
}

function truncateText(
	text: string,
	maxChars: number,
): {
	text: string;
	truncated: boolean;
} {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

function normalizeShell(value: unknown): "sh" | "bash" {
	const v = typeof value === "string" ? value.trim().toLowerCase() : "";
	return v === "bash" ? "bash" : "sh";
}

function normalizeWorkdir(value: unknown): string | null {
	if (typeof value !== "string") return "/";
	const trimmed = value.trim();
	if (!trimmed) return "/";
	if (!trimmed.startsWith("/")) return null;
	return trimmed;
}

type TargetType = "application" | "compose";

async function resolveService(params: {
	targetType: TargetType;
	targetId: string;
	organizationId: string;
	userId: string;
}): Promise<{
	appName: string;
	serverId: string | null;
	appType?: "docker-compose";
}> {
	const targetId = params.targetId.trim();
	await checkServiceAccess(
		params.userId,
		targetId,
		params.organizationId,
		"access",
	);

	if (params.targetType === "application") {
		const app = await findApplicationById(targetId);
		if (app.environment.project.organizationId !== params.organizationId) {
			throw new Error("Permission denied");
		}
		return { appName: app.appName, serverId: app.serverId ?? null };
	}

	const svc = await findComposeById(targetId);
	if (svc.environment.project.organizationId !== params.organizationId) {
		throw new Error("Permission denied");
	}
	return {
		appName: svc.appName,
		serverId: svc.serverId ?? null,
		appType: "docker-compose",
	};
}

type ListedContainer = {
	containerId: string;
	name: string;
	state: string;
	status?: string;
};

async function listContainers(params: {
	appName: string;
	serverId: string | null;
	appType?: "docker-compose";
	includeStopped: boolean;
}): Promise<ListedContainer[]> {
	const rows =
		(await getContainersByAppNameMatch(
			params.appName,
			params.appType,
			params.serverId ?? undefined,
		)) ?? [];

	const normalized = rows
		.map((c) => ({
			containerId: String((c as any).containerId ?? "").trim(),
			name: String((c as any).name ?? "").trim(),
			state: String((c as any).state ?? "").trim(),
			status: String((c as any).status ?? "").trim(),
		}))
		.filter((c) => c.containerId.length > 0 && c.name.length > 0);

	if (params.includeStopped) return normalized;
	return normalized.filter((c) => c.state.toLowerCase() === "running");
}

async function execOnServer(params: {
	serverId: string | null;
	command: string;
	timeoutMs: number;
	maxBufferBytes: number;
}): Promise<{ stdout: string; stderr: string }> {
	if (params.serverId) {
		return await execAsyncRemote(params.serverId, params.command, undefined, {
			timeoutMs: params.timeoutMs,
			maxBufferBytes: params.maxBufferBytes,
		});
	}
	return await execAsync(params.command, {
		timeoutMs: params.timeoutMs,
		maxBufferBytes: params.maxBufferBytes,
	});
}

const serviceContainerList: Tool<
	{
		targetType: TargetType;
		targetId: string;
		includeStopped?: boolean;
	},
	{
		targetType: TargetType;
		targetId: string;
		appName: string;
		serverId: string | null;
		containers: ListedContainer[];
	}
> = {
	name: "service_container_list",
	aliases: ["container_list", "docker_container_list"],
	description:
		"List Docker containers belonging to a Dokploy-managed service (application or compose). Use this to pick a containerId for service_container_exec.",
	category: "server",
	tags: ["docker", "container", "list", "terminal", "exec"],
	parameters: z.object({
		targetType: z.enum(["application", "compose"]),
		targetId: z.string().min(1).describe("applicationId or composeId"),
		includeStopped: z.boolean().optional().default(true),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		try {
			const resolved = await resolveService({
				targetType: params.targetType,
				targetId: params.targetId,
				organizationId: ctx.organizationId,
				userId: ctx.userId,
			});

			if (!resolved.serverId && IS_CLOUD) {
				return {
					success: false,
					message:
						"Container tools are not available in the cloud local runtime",
					error: "CLOUD_LOCAL_UNAVAILABLE",
				};
			}

			const containers = await listContainers({
				appName: resolved.appName,
				serverId: resolved.serverId,
				appType: resolved.appType,
				includeStopped: params.includeStopped !== false,
			});

			return {
				success: true,
				message: `Found ${containers.length} container(s) for "${resolved.appName}"`,
				data: {
					targetType: params.targetType,
					targetId: params.targetId.trim(),
					appName: resolved.appName,
					serverId: resolved.serverId,
					containers,
				},
			};
		} catch (error) {
			return {
				success: false,
				message: "Failed to list containers",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

const serviceContainerExec: Tool<
	{
		targetType: TargetType;
		targetId: string;
		command: string;
		containerId?: string;
		shell?: "sh" | "bash";
		workdir?: string;
		timeoutMs?: number;
		maxOutputChars?: number;
		maxBufferBytes?: number;
	},
	{
		targetType: TargetType;
		targetId: string;
		appName: string;
		serverId: string | null;
		containerId: string;
		command: string;
		stdout: string;
		stderr: string;
		truncated: boolean;
		timeoutMs: number;
		maxBufferBytes: number;
		exitCode?: number;
	}
> = {
	name: "service_container_exec",
	aliases: [
		"container_exec",
		"docker_container_exec",
		"container_command_execute",
	],
	description:
		"Execute a one-shot shell command inside a container belonging to a Dokploy-managed service (application or compose). Dangerous: can modify or destroy data.",
	category: "server",
	tags: ["docker", "container", "exec", "terminal", "shell", "command"],
	parameters: z.object({
		targetType: z.enum(["application", "compose"]),
		targetId: z.string().min(1).describe("applicationId or composeId"),
		command: z
			.string()
			.min(1)
			.max(200_000)
			.describe("Shell command to run in the container"),
		containerId: z
			.string()
			.min(1)
			.optional()
			.describe("Optional specific containerId (or exact container name)"),
		shell: z.enum(["sh", "bash"]).optional().default("sh"),
		workdir: z.string().min(1).optional().default("/"),
		timeoutMs: z
			.number()
			.min(1000)
			.max(10 * 60_000)
			.optional()
			.default(60_000),
		maxOutputChars: z
			.number()
			.min(1000)
			.max(200_000)
			.optional()
			.default(20_000),
		maxBufferBytes: z
			.number()
			.min(64_000)
			.max(50_000_000)
			.optional()
			.default(5_000_000)
			.describe("Max bytes to buffer from stdout/stderr before truncation"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const maxOutputChars = clampMaxChars(params.maxOutputChars, 20_000);
		const timeoutMs = clampTimeoutMs(params.timeoutMs, 60_000);
		const maxBufferBytes = clampMaxBufferBytes(
			params.maxBufferBytes,
			5_000_000,
		);

		let resolved: Awaited<ReturnType<typeof resolveService>>;
		try {
			resolved = await resolveService({
				targetType: params.targetType,
				targetId: params.targetId,
				organizationId: ctx.organizationId,
				userId: ctx.userId,
			});
		} catch (error) {
			return {
				success: false,
				message: "Permission denied or service not found",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		if (!resolved.serverId && IS_CLOUD) {
			return {
				success: false,
				message: "Container tools are not available in the cloud local runtime",
				error: "CLOUD_LOCAL_UNAVAILABLE",
			};
		}

		let containers: ListedContainer[] = [];
		try {
			containers = await listContainers({
				appName: resolved.appName,
				serverId: resolved.serverId,
				appType: resolved.appType,
				includeStopped: true,
			});
		} catch (error) {
			return {
				success: false,
				message: "Failed to resolve containers for this service",
				error: error instanceof Error ? error.message : String(error),
			};
		}

		const requested =
			typeof params.containerId === "string" ? params.containerId.trim() : "";
		const selected = (() => {
			if (requested) {
				return (
					containers.find((c) => c.containerId === requested) ??
					containers.find((c) => c.name === requested) ??
					null
				);
			}
			return (
				containers.find((c) => c.state.toLowerCase() === "running") ??
				containers[0] ??
				null
			);
		})();

		if (!selected) {
			return {
				success: false,
				message: "No container found for this service (is it running?)",
				error: "CONTAINER_NOT_FOUND",
			};
		}

		const shell = normalizeShell(params.shell);
		const workdir = normalizeWorkdir(params.workdir);
		if (!workdir) {
			return {
				success: false,
				message:
					"Invalid workdir (must be an absolute path inside the container)",
				error: "INVALID_WORKDIR",
			};
		}

		const shellCmd = shell === "bash" ? "bash -lc" : "sh -c";
		const dockerCmd =
			"docker exec -i " +
			`-w ${shQuote(workdir)} ` +
			`${shQuote(selected.containerId)} ` +
			`${shellCmd} ` +
			`${shQuote(params.command)}`;

		try {
			const { stdout, stderr } = await execOnServer({
				serverId: resolved.serverId,
				command: dockerCmd,
				timeoutMs,
				maxBufferBytes,
			});
			const out = truncateText(stdout ?? "", maxOutputChars);
			const err = truncateText(stderr ?? "", maxOutputChars);
			return {
				success: true,
				message: `Command executed in container "${selected.containerId}"`,
				data: {
					targetType: params.targetType,
					targetId: params.targetId.trim(),
					appName: resolved.appName,
					serverId: resolved.serverId,
					containerId: selected.containerId,
					command: params.command,
					stdout: out.text,
					stderr: err.text,
					truncated: out.truncated || err.truncated,
					timeoutMs,
					maxBufferBytes,
				},
			};
		} catch (error) {
			if (error instanceof ExecError) {
				const out = truncateText(error.stdout ?? "", maxOutputChars);
				const err = truncateText(error.stderr ?? "", maxOutputChars);
				return {
					success: false,
					message: "Command execution failed",
					error: error.message,
					data: {
						targetType: params.targetType,
						targetId: params.targetId.trim(),
						appName: resolved.appName,
						serverId: resolved.serverId,
						containerId: selected.containerId,
						command: params.command,
						stdout: out.text,
						stderr: err.text,
						truncated: out.truncated || err.truncated,
						timeoutMs,
						maxBufferBytes,
						exitCode: error.exitCode,
					},
				};
			}
			return {
				success: false,
				message: "Command execution failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
};

export function registerContainerTools() {
	toolRegistry.register(serviceContainerList);
	toolRegistry.register(serviceContainerExec);
}
