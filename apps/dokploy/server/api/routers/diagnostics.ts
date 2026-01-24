import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execAsyncRemote, getRemoteDocker, paths } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { redisConfig } from "@/server/queues/redis-connection";
import { myQueue } from "@/server/queues/queueSetup";
import { createTRPCRouter, adminProcedure } from "../trpc";

const MAX_BYTES_DEFAULT = 64 * 1024;
const MAX_BYTES_HARD_LIMIT = 2 * 1024 * 1024;
const TAIL_MAX_LINES = 2000;

const subpathOptional = z
	.string()
	.optional()
	.default("")
	.describe("Path relative to Dokploy base path (no leading /, no ..)");
const subpathRequired = z
	.string()
	.min(1)
	.describe("Path relative to Dokploy base path (no leading /, no ..)");

function normalizeSubpath(input: string): string {
	const raw = input.trim().replace(/\\/g, "/");
	const parts = raw.split("/").filter(Boolean);
	if (parts.length === 0) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid subpath" });
	}
	if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "subpath must be relative (no leading / or drive letter)",
		});
	}
	for (const part of parts) {
		if (part === "." || part === "..") {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Path traversal is not allowed",
			});
		}
		if (!/^[a-zA-Z0-9._-]+$/.test(part)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Invalid path segment: "${part}"`,
			});
		}
	}
	return parts.join("/");
}

function resolveInBase(
	basePath: string,
	subpath: string,
	mode: "local" | "server",
): string {
	const trimmed = subpath.trim();
	if (!trimmed) return basePath;
	const normalized = normalizeSubpath(trimmed);
	if (mode === "server") {
		return `${basePath.replace(/\/+$/g, "")}/${normalized}`;
	}
	return path.join(basePath, ...normalized.split("/").filter(Boolean));
}

async function readFileHead(
	filePath: string,
	maxBytes: number,
): Promise<{ content: string; bytesRead: number; truncated: boolean }> {
	const clamped = Math.max(1, Math.min(MAX_BYTES_HARD_LIMIT, maxBytes));
	const handle = await fs.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(clamped);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead >= clamped;
		return {
			content: buffer.subarray(0, bytesRead).toString("utf8"),
			bytesRead,
			truncated,
		};
	} finally {
		await handle.close();
	}
}

async function tailFile(
	filePath: string,
	lines: number,
	maxBytes: number,
): Promise<{ content: string; bytesRead: number; truncated: boolean }> {
	const clampedBytes = Math.max(1, Math.min(MAX_BYTES_HARD_LIMIT, maxBytes));
	const clampedLines = Math.max(1, Math.min(TAIL_MAX_LINES, lines));
	const st = await fs.stat(filePath);
	const start = Math.max(0, st.size - clampedBytes);
	const handle = await fs.open(filePath, "r");
	try {
		const len = Math.max(0, st.size - start);
		const buffer = Buffer.alloc(len);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const parts = text.split(/\r?\n/);
		const sliced = parts.slice(-clampedLines).join("\n");
		return {
			content: sliced,
			bytesRead,
			truncated: start > 0,
		};
	} finally {
		await handle.close();
	}
}

export const diagnosticsRouter = createTRPCRouter({
	runtime: adminProcedure.query(({ ctx }) => {
		return {
			now: new Date().toISOString(),
			pid: process.pid,
			node: {
				version: process.version,
				versions: process.versions,
			},
			platform: {
				platform: process.platform,
				arch: process.arch,
				release: os.release(),
				hostname: os.hostname(),
				uptimeSec: os.uptime(),
			},
			process: {
				cwd: process.cwd(),
				uptimeSec: process.uptime(),
				memoryUsage: process.memoryUsage(),
			},
			request: {
				method: ctx.req.method,
				url: ctx.req.url,
				headers: ctx.req.headers,
			},
			context: {
				userId: ctx.user.id,
				ownerId: ctx.user.ownerId,
				role: ctx.user.role,
				activeOrganizationId: ctx.session.activeOrganizationId,
			},
			paths: {
				local: paths(false),
				server: paths(true),
			},
		};
	}),

	env: adminProcedure.query(() => {
		return process.env;
	}),

	queueStats: adminProcedure.query(async () => {
		try {
			const counts = await myQueue.getJobCounts(
				"active",
				"waiting",
				"delayed",
				"completed",
				"failed",
			);
			return {
				queue: {
					name: myQueue.name,
					prefix: process.env.BULLMQ_PREFIX || "",
				},
				redis: redisConfig,
				counts,
			};
		} catch (error) {
			return {
				queue: {
					name: myQueue.name,
					prefix: process.env.BULLMQ_PREFIX || "",
				},
				redis: redisConfig,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}),

	dockerPing: adminProcedure
		.input(z.object({ serverId: z.string().optional() }).optional())
		.query(async ({ input }) => {
			const docker = await getRemoteDocker(input?.serverId ?? null);
			try {
				const ping = await docker.ping();
				return { ok: true, ping };
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),

	dockerInfo: adminProcedure
		.input(
			z
				.object({
					serverId: z.string().optional(),
					includeInfo: z.boolean().optional().default(true),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			const docker = await getRemoteDocker(input?.serverId ?? null);
			try {
				const [version, info] = await Promise.all([
					docker.version(),
					input?.includeInfo === false ? Promise.resolve(null) : docker.info(),
				]);
				return { ok: true, version, info };
			} catch (error) {
				return {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}),

	listBaseDir: adminProcedure
		.input(
			z
				.object({
					subpath: subpathOptional,
					serverId: z.string().optional(),
				})
				.refine(
					(v) => typeof v.subpath === "string",
					{ message: "Invalid input" },
				),
		)
		.query(async ({ input }) => {
			const base = paths(!!input.serverId).BASE_PATH;
			const fullPath = resolveInBase(
				base,
				input.subpath ?? "",
				input.serverId ? "server" : "local",
			);

			if (input.serverId) {
				const cmd = `ls -la "${fullPath.replace(/"/g, '\\"')}"`;
				const { stdout, stderr } = await execAsyncRemote(input.serverId, cmd);
				return { base, path: fullPath, stdout, stderr };
			}

			const entries = await fs.readdir(fullPath, { withFileTypes: true });
			const detailed = await Promise.all(
				entries.map(async (e) => {
					const p = path.join(fullPath, e.name);
					let st: { size: number; mtimeMs: number } | null = null;
					try {
						const s = await fs.stat(p);
						st = { size: s.size, mtimeMs: s.mtimeMs };
					} catch {}
					return {
						name: e.name,
						type: e.isDirectory()
							? "dir"
							: e.isFile()
								? "file"
								: e.isSymbolicLink()
									? "symlink"
									: "other",
						size: st?.size ?? null,
						mtimeMs: st?.mtimeMs ?? null,
					};
				}),
			);
			return { base, path: fullPath, entries: detailed };
		}),

	readBaseFile: adminProcedure
		.input(
			z.object({
				subpath: subpathRequired,
				serverId: z.string().optional(),
				maxBytes: z.number().min(1).max(MAX_BYTES_HARD_LIMIT).optional(),
			}),
		)
		.query(async ({ input }) => {
			const base = paths(!!input.serverId).BASE_PATH;
			const fullPath = resolveInBase(
				base,
				input.subpath,
				input.serverId ? "server" : "local",
			);
			const maxBytes = input.maxBytes ?? MAX_BYTES_DEFAULT;

			if (input.serverId) {
				const bytes = Math.max(1, Math.min(MAX_BYTES_HARD_LIMIT, maxBytes));
				const cmd = `head -c ${bytes} "${fullPath.replace(/"/g, '\\"')}"`;
				const { stdout, stderr } = await execAsyncRemote(input.serverId, cmd);
				return {
					base,
					path: fullPath,
					content: stdout,
					stderr,
					maxBytes: bytes,
				};
			}

			const result = await readFileHead(fullPath, maxBytes);
			return { base, path: fullPath, ...result, maxBytes };
		}),

	tailBaseFile: adminProcedure
		.input(
			z.object({
				subpath: subpathRequired,
				serverId: z.string().optional(),
				lines: z.number().min(1).max(TAIL_MAX_LINES).optional().default(200),
				maxBytes: z.number().min(1).max(MAX_BYTES_HARD_LIMIT).optional(),
			}),
		)
		.query(async ({ input }) => {
			const base = paths(!!input.serverId).BASE_PATH;
			const fullPath = resolveInBase(
				base,
				input.subpath,
				input.serverId ? "server" : "local",
			);
			const maxBytes = input.maxBytes ?? MAX_BYTES_HARD_LIMIT;

			if (input.serverId) {
				const lines = Math.max(1, Math.min(TAIL_MAX_LINES, input.lines ?? 200));
				const cmd = `tail -n ${lines} "${fullPath.replace(/"/g, '\\"')}"`;
				const { stdout, stderr } = await execAsyncRemote(input.serverId, cmd);
				return {
					base,
					path: fullPath,
					content: stdout,
					stderr,
					lines,
				};
			}

			const result = await tailFile(fullPath, input.lines ?? 200, maxBytes);
			return { base, path: fullPath, lines: input.lines, maxBytes, ...result };
		}),
});
