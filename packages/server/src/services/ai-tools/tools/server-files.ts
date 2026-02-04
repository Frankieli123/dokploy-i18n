import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execAsyncRemote } from "@dokploy/server";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

const MAX_BYTES_HARD_LIMIT = 5 * 1024 * 1024;
const TAIL_MAX_LINES = 5000;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function normalizeFilePath(value: string): string {
	return value.trim();
}

function isAbsolutePath(value: string): boolean {
	const v = value.trim();
	if (v.startsWith("/")) return true;
	return /^[a-zA-Z]:[\\/]/.test(v);
}

function assertAbsolutePath(filePath: string): string {
	const normalized = normalizeFilePath(filePath);
	if (!normalized || !isAbsolutePath(normalized)) {
		throw new Error("Path must be an absolute path");
	}
	return normalized;
}

function clampBytes(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1, Math.min(MAX_BYTES_HARD_LIMIT, Math.floor(n)));
}

function clampLines(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(1, Math.min(TAIL_MAX_LINES, Math.floor(n)));
}

function shQuote(value: string): string {
	return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function getPosixDirname(filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/");
	const idx = normalized.lastIndexOf("/");
	if (idx <= 0) return "/";
	return normalized.slice(0, idx) || "/";
}

async function readFileHeadLocal(filePath: string, maxBytes: number) {
	const handle = await fs.open(filePath, "r");
	try {
		const st = await handle.stat();
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return {
			content: buffer.subarray(0, bytesRead).toString("utf8"),
			bytesRead,
			truncated: st.size > bytesRead,
			sizeBytes: st.size,
		};
	} finally {
		await handle.close();
	}
}

async function tailFileLocal(filePath: string, lines: number, maxBytes: number) {
	const st = await fs.stat(filePath);
	const start = Math.max(0, st.size - maxBytes);
	const handle = await fs.open(filePath, "r");
	try {
		const len = Math.max(0, st.size - start);
		const buffer = Buffer.alloc(len);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const parts = text.split(/\r?\n/);
		return {
			content: parts.slice(-lines).join("\n"),
			bytesRead,
			truncated: start > 0,
			sizeBytes: st.size,
		};
	} finally {
		await handle.close();
	}
}

const serverFileList: Tool<
	{ path: string; serverId?: string },
	| {
			mode: "local";
			path: string;
			entries: Array<{
				name: string;
				type: "dir" | "file" | "symlink" | "other";
				sizeBytes: number | null;
				mtimeMs: number | null;
			}>;
	  }
	| { mode: "remote"; path: string; serverId: string; stdout: string; stderr: string }
> = {
	name: "server_file_list",
	description: "List directory contents on the server filesystem (local or via SSH when serverId is provided).",
	category: "server",
	tags: ["file", "filesystem", "list", "dir", "server", "ssh"],
	parameters: z.object({
		path: z.string().min(1).describe("Absolute path to a directory"),
		serverId: z.string().min(1).optional().describe("Optional target serverId (SSH)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const targetPath = assertAbsolutePath(params.path);
		const serverId = isNonEmptyString(params.serverId)
			? params.serverId.trim()
			: isNonEmptyString(ctx.serverId)
				? ctx.serverId.trim()
				: null;

		if (serverId) {
			const { stdout, stderr } = await execAsyncRemote(
				serverId,
				`ls -la -- ${shQuote(targetPath)}`,
			);
			return {
				success: true,
				message: `Listed directory "${targetPath}" on server "${serverId}"`,
				data: { mode: "remote", path: targetPath, serverId, stdout, stderr },
			};
		}

		const entries = await fs.readdir(targetPath, { withFileTypes: true });
		const detailed = await Promise.all(
			entries.map(async (e) => {
				const full = path.join(targetPath, e.name);
				let st: { size: number; mtimeMs: number } | null = null;
				try {
					const s = await fs.stat(full);
					st = { size: s.size, mtimeMs: s.mtimeMs };
				} catch {}
				const type: "dir" | "file" | "symlink" | "other" = e.isDirectory()
					? "dir"
					: e.isFile()
						? "file"
						: e.isSymbolicLink()
							? "symlink"
							: "other";
				return {
					name: e.name,
					type,
					sizeBytes: st?.size ?? null,
					mtimeMs: st?.mtimeMs ?? null,
				};
			}),
		);

		return {
			success: true,
			message: `Listed directory "${targetPath}"`,
			data: { mode: "local", path: targetPath, entries: detailed },
		};
	},
};

const serverFileRead: Tool<
	{ path: string; serverId?: string; maxBytes?: number },
	{
		mode: "local" | "remote";
		path: string;
		serverId?: string;
		content: string;
		bytesRead: number;
		maxBytes: number;
		truncated: boolean;
		sizeBytes?: number;
		stderr?: string;
	}
> = {
	name: "server_file_read",
	description:
		"Read the beginning of a file from the server filesystem (supports maxBytes; local or via SSH when serverId is provided).",
	category: "server",
	tags: ["file", "filesystem", "read", "head", "server", "ssh", "log"],
	parameters: z.object({
		path: z.string().min(1).describe("Absolute path to a file"),
		maxBytes: z.number().min(1).max(MAX_BYTES_HARD_LIMIT).optional().default(64 * 1024),
		serverId: z.string().min(1).optional().describe("Optional target serverId (SSH)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const targetPath = assertAbsolutePath(params.path);
		const maxBytes = clampBytes(params.maxBytes, 64 * 1024);
		const serverId = isNonEmptyString(params.serverId)
			? params.serverId.trim()
			: isNonEmptyString(ctx.serverId)
				? ctx.serverId.trim()
				: null;

		if (serverId) {
			const { stdout, stderr } = await execAsyncRemote(
				serverId,
				`head -c ${maxBytes} -- ${shQuote(targetPath)}`,
			);
			const bytesRead = Buffer.byteLength(stdout, "utf8");
			return {
				success: true,
				message: `Read file "${targetPath}" on server "${serverId}"`,
				data: {
					mode: "remote",
					path: targetPath,
					serverId,
					content: stdout,
					stderr,
					bytesRead,
					maxBytes,
					truncated: bytesRead >= maxBytes,
				},
			};
		}

		const res = await readFileHeadLocal(targetPath, maxBytes);
		return {
			success: true,
			message: `Read file "${targetPath}"`,
			data: {
				mode: "local",
				path: targetPath,
				content: res.content,
				bytesRead: res.bytesRead,
				maxBytes,
				truncated: res.truncated,
				sizeBytes: res.sizeBytes,
			},
		};
	},
};

const serverFileTail: Tool<
	{ path: string; serverId?: string; lines?: number; maxBytes?: number },
	{
		mode: "local" | "remote";
		path: string;
		serverId?: string;
		content: string;
		bytesRead: number;
		lines: number;
		maxBytes: number;
		truncated: boolean;
		sizeBytes?: number;
		stderr?: string;
	}
> = {
	name: "server_file_tail",
	description:
		"Read the last N lines of a file from the server filesystem (local or via SSH when serverId is provided).",
	category: "server",
	tags: ["file", "filesystem", "tail", "read", "log", "server", "ssh"],
	parameters: z.object({
		path: z.string().min(1).describe("Absolute path to a file"),
		lines: z.number().min(1).max(TAIL_MAX_LINES).optional().default(200),
		maxBytes: z.number().min(1).max(MAX_BYTES_HARD_LIMIT).optional().default(MAX_BYTES_HARD_LIMIT),
		serverId: z.string().min(1).optional().describe("Optional target serverId (SSH)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const targetPath = assertAbsolutePath(params.path);
		const lines = clampLines(params.lines, 200);
		const maxBytes = clampBytes(params.maxBytes, MAX_BYTES_HARD_LIMIT);
		const serverId = isNonEmptyString(params.serverId)
			? params.serverId.trim()
			: isNonEmptyString(ctx.serverId)
				? ctx.serverId.trim()
				: null;

		if (serverId) {
			const { stdout, stderr } = await execAsyncRemote(
				serverId,
				`tail -n ${lines} -- ${shQuote(targetPath)}`,
			);
			let content = stdout;
			let truncated = false;
			const bytes = Buffer.byteLength(content, "utf8");
			if (bytes > maxBytes) {
				const buf = Buffer.from(content, "utf8");
				content = buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8");
				truncated = true;
			}
			const bytesRead = Buffer.byteLength(content, "utf8");
			return {
				success: true,
				message: `Tailed file "${targetPath}" on server "${serverId}"`,
				data: {
					mode: "remote",
					path: targetPath,
					serverId,
					content,
					stderr,
					bytesRead,
					lines,
					maxBytes,
					truncated,
				},
			};
		}

		const res = await tailFileLocal(targetPath, lines, maxBytes);
		return {
			success: true,
			message: `Tailed file "${targetPath}"`,
			data: {
				mode: "local",
				path: targetPath,
				content: res.content,
				bytesRead: res.bytesRead,
				lines,
				maxBytes,
				truncated: res.truncated,
				sizeBytes: res.sizeBytes,
			},
		};
	},
};

const serverFileWrite: Tool<
	{
		path: string;
		serverId?: string;
		content?: string;
		contentBase64?: string;
		mode?: "overwrite" | "append";
		createParentDirs?: boolean;
	},
	{
		mode: "local" | "remote";
		path: string;
		serverId?: string;
		bytesWritten: number;
		writeMode: "overwrite" | "append";
	}
> = {
	name: "server_file_write",
	description:
		"Write a file on the server filesystem (overwrite or append). Supports local writes or SSH writes when serverId is provided.",
	category: "server",
	tags: ["file", "filesystem", "write", "append", "server", "ssh"],
	parameters: z
		.object({
			path: z.string().min(1).describe("Absolute path to write"),
			serverId: z.string().min(1).optional().describe("Optional target serverId (SSH)"),
			content: z.string().optional().describe("UTF-8 text content to write"),
			contentBase64: z
				.string()
				.optional()
				.describe("Base64-encoded bytes to write (use for binary)"),
			mode: z.enum(["overwrite", "append"]).optional().default("overwrite"),
			createParentDirs: z.boolean().optional().default(true),
		})
		.refine((v) => typeof v.content === "string" || typeof v.contentBase64 === "string", {
			message: "Either content or contentBase64 is required",
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const targetPath = assertAbsolutePath(params.path);
		const serverId = isNonEmptyString(params.serverId)
			? params.serverId.trim()
			: isNonEmptyString(ctx.serverId)
				? ctx.serverId.trim()
				: null;
		const writeMode = params.mode === "append" ? "append" : "overwrite";
		const createParentDirs = params.createParentDirs !== false;

		const buf = (() => {
			if (typeof params.contentBase64 === "string") {
				return Buffer.from(params.contentBase64, "base64");
			}
			return Buffer.from(params.content ?? "", "utf8");
		})();

		if (serverId) {
			const dir = getPosixDirname(targetPath);
			const b64 = buf.toString("base64");
			const redir = writeMode === "append" ? ">>" : ">";
			const mkParent = createParentDirs
				? `mkdir -p -- ${shQuote(dir)}; `
				: "";
			const cmd =
				`set -e; ` +
				mkParent +
				`printf %s ${shQuote(b64)} | base64 -d ${redir} ${shQuote(targetPath)}`;
			await execAsyncRemote(serverId, cmd);
			return {
				success: true,
				message: `Wrote ${buf.length} bytes to "${targetPath}" on server "${serverId}"`,
				data: {
					mode: "remote",
					path: targetPath,
					serverId,
					bytesWritten: buf.length,
					writeMode,
				},
			};
		}

		if (createParentDirs) {
			await fs.mkdir(path.dirname(targetPath), { recursive: true });
		}
		if (writeMode === "append") {
			await fs.appendFile(targetPath, buf);
		} else {
			await fs.writeFile(targetPath, buf);
		}

		return {
			success: true,
			message: `Wrote ${buf.length} bytes to "${targetPath}"`,
			data: {
				mode: "local",
				path: targetPath,
				bytesWritten: buf.length,
				writeMode,
			},
		};
	},
};

export function registerServerFileTools() {
	toolRegistry.register(serverFileList);
	toolRegistry.register(serverFileRead);
	toolRegistry.register(serverFileTail);
	toolRegistry.register(serverFileWrite);
}
