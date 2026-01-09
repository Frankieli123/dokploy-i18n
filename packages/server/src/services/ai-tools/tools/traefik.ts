import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { findServerById } from "@dokploy/server/services/server";
import {
	readDirectory,
	reloadDockerResource,
} from "@dokploy/server/services/settings";
import { canAccessToTraefikFiles } from "@dokploy/server/services/user";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import {
	readConfigInPath,
	writeTraefikConfigInPath,
} from "@dokploy/server/utils/traefik/application";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

type TraefikTreeItem = {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TraefikTreeItem[];
};

const truncateOutput = (input: string, maxChars: number) => {
	if (input.length <= maxChars) return { text: input, truncated: false };
	return {
		text: `${input.slice(0, maxChars)}\n...[TRUNCATED]`,
		truncated: true,
	};
};

const resolveTraefikPath = (root: string, relativePath?: string) => {
	const rootResolved = path.resolve(root);
	const targetResolved = relativePath
		? path.resolve(rootResolved, relativePath)
		: rootResolved;
	if (
		targetResolved !== rootResolved &&
		!targetResolved.startsWith(`${rootResolved}${path.sep}`)
	) {
		throw new Error("Access denied: path traversal detected");
	}
	return { rootResolved, targetResolved };
};

const traefikAcmeLogTail: Tool<
	{
		serverId?: string;
		tailLines?: number;
		maxOutputChars?: number;
		onlyRelevant?: boolean;
	},
	{
		content: string;
		truncated: boolean;
		returnedLines: number;
		requestedTailLines: number;
		onlyRelevant: boolean;
	}
> = {
	name: "traefik_acme_log_tail",
	description:
		"Tail Traefik (dokploy-traefik) logs and return ACME/challenge-related lines (read-only, truncated)",
	category: "server",
	aliases: [
		"traefik acme logs",
		"acme log",
		"letsencrypt log",
		"certificate renew log",
		"ACME日志",
		"证书续签日志",
		"Traefik日志",
	],
	tags: [
		"traefik",
		"acme",
		"letsencrypt",
		"log",
		"tls",
		"certificate",
		"日志",
		"证书",
		"续签",
	],
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (defaults to current context)"),
		tailLines: z
			.number()
			.int()
			.min(1)
			.max(5000)
			.optional()
			.default(300)
			.describe("How many lines to tail from Traefik logs"),
		maxOutputChars: z
			.number()
			.int()
			.min(1000)
			.max(200000)
			.optional()
			.default(20000)
			.describe("Maximum output characters (truncates if exceeded)"),
		onlyRelevant: z
			.boolean()
			.optional()
			.default(true)
			.describe(
				"If true, only returns lines likely related to ACME/challenges; otherwise returns raw tail",
			),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		const tailLines = params.tailLines ?? 300;
		const maxOutputChars = params.maxOutputChars ?? 20000;
		const onlyRelevant = params.onlyRelevant ?? true;

		const command =
			`docker service logs --tail ${tailLines} dokploy-traefik 2>&1 || ` +
			`docker logs --tail ${tailLines} dokploy-traefik 2>&1`;

		let raw = "";
		try {
			const { stdout } = serverId
				? await execAsyncRemote(serverId, command)
				: await execAsync(command);
			raw = (stdout ?? "").trimEnd();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				message: `Failed to read Traefik logs: ${msg}`,
			};
		}

		const lines = raw === "" ? [] : raw.split(/\r?\n/);

		let selectedLines = lines;
		if (onlyRelevant) {
			const re =
				/(acme|let'?s\s*encrypt|challenge|tls-?alpn|http-01|dns-01|renew|certificate)/i;
			selectedLines = lines.filter((l) => re.test(l));
			if (selectedLines.length === 0) {
				return {
					success: true,
					message:
						"No ACME-related lines found in Traefik logs. Set onlyRelevant=false to view raw tail output.",
					data: {
						content: "",
						truncated: false,
						returnedLines: 0,
						requestedTailLines: tailLines,
						onlyRelevant,
					},
				};
			}
		}

		const joined = selectedLines.join("\n");
		const { text, truncated } = truncateOutput(joined, maxOutputChars);

		const returnedLines = text === "" ? 0 : text.split(/\r?\n/).length;

		return {
			success: true,
			message: "Traefik log tail",
			data: {
				content: text,
				truncated,
				returnedLines,
				requestedTailLines: tailLines,
				onlyRelevant,
			},
		};
	},
};

const readTraefikMiddlewares: Tool<
	{ serverId?: string; maxOutputChars?: number },
	{
		filePath: string;
		content: string;
		middlewares: string[];
		truncated: boolean;
	}
> = {
	name: "traefik_read_middlewares",
	description:
		"Read Traefik dynamic middlewares configuration (middlewares.yml) and list middleware names (read-only, truncated)",
	category: "server",
	aliases: [
		"traefik middlewares",
		"list traefik middlewares",
		"read middlewares.yml",
		"Traefik中间件",
		"读取Traefik中间件",
	],
	tags: ["traefik", "middleware", "middlewares", "config", "read", "中间件"],
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (defaults to current context)"),
		maxOutputChars: z
			.number()
			.int()
			.min(1000)
			.max(200000)
			.optional()
			.default(20000)
			.describe("Maximum output characters (truncates if exceeded)"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		const traefikDynamic = paths(!!serverId).DYNAMIC_TRAEFIK_PATH;
		const configPath = path.join(traefikDynamic, "middlewares.yml");

		const raw = await readConfigInPath(configPath, serverId);
		if (!raw) {
			return { success: false, message: "middlewares.yml not found or empty" };
		}

		let middlewares: string[] = [];
		try {
			const parsed = parseYaml(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const http = (parsed as { http?: unknown }).http;
				if (http && typeof http === "object" && !Array.isArray(http)) {
					const mws = (http as { middlewares?: unknown }).middlewares;
					if (mws && typeof mws === "object" && !Array.isArray(mws)) {
						middlewares = Object.keys(mws as Record<string, unknown>).sort();
					}
				}
			}
		} catch {
			middlewares = [];
		}

		const maxOutputChars = params.maxOutputChars ?? 20000;
		const { text, truncated } = truncateOutput(raw, maxOutputChars);

		return {
			success: true,
			message: `Read Traefik middlewares (${middlewares.length} found)`,
			data: {
				filePath: "middlewares.yml",
				content: text,
				middlewares,
				truncated,
			},
		};
	},
};

const listTraefikFiles: Tool<
	{ serverId?: string; subPath?: string },
	{ root: string; items: TraefikTreeItem[] }
> = {
	name: "traefik_list_files",
	description:
		"List Traefik configuration directory tree (restricted to Traefik folder)",
	category: "server",
	aliases: [
		"traefik files",
		"list traefik config",
		"traefik directory",
		"Traefik配置文件",
		"Traefik目录",
	],
	tags: ["traefik", "config", "file", "list", "配置", "文件", "目录"],
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (defaults to current context)"),
		subPath: z
			.string()
			.optional()
			.describe("Subdirectory path relative to Traefik root"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		const traefikRoot = paths(!!serverId).MAIN_TRAEFIK_PATH;
		const { rootResolved, targetResolved } = resolveTraefikPath(
			traefikRoot,
			params.subPath,
		);

		const items = (await readDirectory(
			targetResolved,
			serverId,
		)) as unknown as TraefikTreeItem[];

		return {
			success: true,
			message: `Read Traefik directory tree (${path.relative(rootResolved, targetResolved) || "."})`,
			data: {
				root: rootResolved,
				items,
			},
		};
	},
};

const writeMainTraefikConfig: Tool<
	{ serverId?: string; content: string },
	{ configPath: string; backupPath?: string }
> = {
	name: "traefik_main_config_write",
	description:
		"Replace the main Traefik configuration file (traefik.yml). Creates a backup before overwriting.",
	category: "server",
	aliases: [
		"write traefik config",
		"update traefik.yml",
		"edit traefik config",
		"写入Traefik配置",
		"修改Traefik配置",
	],
	tags: ["traefik", "config", "write", "update", "配置", "写入", "修改"],
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (defaults to current context)"),
		content: z.string().min(1).describe("New traefik.yml content (YAML)"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		try {
			parseYaml(params.content);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				message: `Invalid YAML: ${msg}`,
			};
		}

		const traefikRoot = paths(!!serverId).MAIN_TRAEFIK_PATH;
		const configPath = path.join(traefikRoot, "traefik.yml");
		const backupPath = path.join(traefikRoot, `traefik.yml.bak.${Date.now()}`);
		let backupCreated = false;

		try {
			const current = await readConfigInPath(configPath, serverId);
			if (current !== null) {
				await writeTraefikConfigInPath(backupPath, current, serverId);
				const backupContent = await readConfigInPath(backupPath, serverId);
				backupCreated = backupContent !== null;
			}
		} catch {
			// ignore backup errors
		}

		await writeTraefikConfigInPath(configPath, params.content, serverId);
		const after = await readConfigInPath(configPath, serverId);
		const normalizedAfter = (after ?? "").replace(/\r\n/g, "\n");
		const normalizedExpected = params.content.replace(/\r\n/g, "\n");
		if (!after || normalizedAfter !== normalizedExpected) {
			return {
				success: false,
				message: "Failed to write traefik.yml",
			};
		}

		const didBackup = backupCreated || (!serverId && existsSync(backupPath));
		return {
			success: true,
			message: "traefik.yml updated successfully",
			data: {
				configPath,
				...(didBackup ? { backupPath } : {}),
			},
		};
	},
};

const writeTraefikDynamicConfig: Tool<
	{ serverId?: string; fileName: string; content: string; confirm: string },
	{ configPath: string; backupPath?: string }
> = {
	name: "traefik_dynamic_config_write",
	description:
		"Write a Traefik dynamic configuration file under the Traefik dynamic directory. Creates a backup before overwriting.",
	category: "server",
	aliases: [
		"write traefik dynamic config",
		"update traefik dynamic yml",
		"edit traefik dynamic config",
		"写入Traefik动态配置",
		"修改Traefik动态配置",
	],
	tags: ["traefik", "dynamic", "config", "write", "update", "配置", "写入", "修改"],
	parameters: z
		.object({
			serverId: z
				.string()
				.optional()
				.describe("Server ID (defaults to current context)"),
			fileName: z
				.string()
				.min(1)
				.describe(
					'Target filename inside the Traefik dynamic directory (no subdirectories), e.g. "dokploy.yml" or "git-proxy.yml"',
				),
			content: z.string().min(1).describe("New dynamic config content (YAML)"),
			confirm: z
				.literal("WRITE_TRAEFIK_DYNAMIC")
				.describe("Confirmation token: WRITE_TRAEFIK_DYNAMIC"),
		})
		.superRefine((v, ctx2) => {
			const name = v.fileName.trim();
			if (name.length === 0) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "fileName is required",
				});
				return;
			}
			if (name.includes("/") || name.includes("\\")) {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "fileName must not include directory separators",
				});
			}
			const ext = path.extname(name).toLowerCase();
			if (ext !== ".yml" && ext !== ".yaml") {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Only .yml or .yaml files are allowed",
				});
			}
			if (name.toLowerCase() === "acme.json") {
				ctx2.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Writing acme.json is not allowed",
				});
			}
		}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(ctx.userId, ctx.organizationId);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		try {
			parseYaml(params.content);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				message: `Invalid YAML: ${msg}`,
			};
		}

		const fileName = params.fileName.trim();
		const traefikDynamic = paths(!!serverId).DYNAMIC_TRAEFIK_PATH;
		const { rootResolved, targetResolved } = resolveTraefikPath(
			traefikDynamic,
			fileName,
		);

		const configPath = targetResolved;
		const backupPath = path.join(
			rootResolved,
			`${path.basename(configPath)}.bak.${Date.now()}`,
		);
		let backupCreated = false;

		try {
			const current = await readConfigInPath(configPath, serverId);
			if (current !== null) {
				await writeTraefikConfigInPath(backupPath, current, serverId);
				const backupContent = await readConfigInPath(backupPath, serverId);
				backupCreated = backupContent !== null;
			}
		} catch {
			// ignore backup errors
		}

		await writeTraefikConfigInPath(configPath, params.content, serverId);
		const after = await readConfigInPath(configPath, serverId);
		const normalizedAfter = (after ?? "").replace(/\r\n/g, "\n");
		const normalizedExpected = params.content.replace(/\r\n/g, "\n");
		if (!after || normalizedAfter !== normalizedExpected) {
			return {
				success: false,
				message: "Failed to write Traefik dynamic config file",
			};
		}

		const didBackup = backupCreated || (!serverId && existsSync(backupPath));
		return {
			success: true,
			message: "Traefik dynamic config updated successfully",
			data: {
				configPath,
				...(didBackup ? { backupPath } : {}),
			},
		};
	},
};

const reloadTraefik: Tool<{ serverId?: string }, { reloaded: boolean }> = {
	name: "traefik_reload",
	description:
		"Reload Traefik (dokploy-traefik) to apply configuration changes.",
	category: "server",
	aliases: [
		"restart traefik",
		"reload reverse proxy",
		"apply traefik config",
		"重载Traefik",
		"重启Traefik",
		"应用配置",
	],
	tags: ["traefik", "reload", "proxy", "重载", "重启", "代理"],
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (defaults to current context)"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		await reloadDockerResource("dokploy-traefik", serverId);
		return {
			success: true,
			message: "Traefik reload triggered",
			data: { reloaded: true },
		};
	},
};

const readTraefikConfig: Tool<
	{ serverId?: string; filePath: string },
	{ filePath: string; content: string }
> = {
	name: "traefik_read_config",
	description:
		"Read a Traefik config/log file content (restricted, blocks acme.json, size-limited)",
	category: "server",
	aliases: [
		"read traefik config",
		"view traefik file",
		"cat traefik file",
		"读取Traefik配置",
		"查看Traefik文件",
	],
	tags: ["traefik", "config", "read", "file", "log", "读取", "配置", "文件"],
	parameters: z.preprocess(
		(input) => {
			if (!input || typeof input !== "object" || Array.isArray(input)) {
				return input;
			}
			const record = input as Record<string, unknown>;
			if (record.filePath == null && typeof record.path === "string") {
				return {
					...record,
					filePath: record.path,
				};
			}
			return input;
		},
		z.object({
			serverId: z
				.string()
				.optional()
				.describe("Server ID (defaults to current context)"),
			filePath: z
				.string()
				.min(1)
				.default("traefik.yml")
				.describe("File path relative to Traefik root"),
		}),
	),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		const traefikRoot = paths(!!serverId).MAIN_TRAEFIK_PATH;
		const { rootResolved, targetResolved } = resolveTraefikPath(
			traefikRoot,
			params.filePath,
		);

		const baseName = path.basename(targetResolved).toLowerCase();
		if (baseName === "acme.json") {
			return {
				success: false,
				message: "Access denied: reading acme.json is not allowed",
			};
		}

		const allowedExtensions = new Set([
			".yml",
			".yaml",
			".toml",
			".json",
			".log",
			".txt",
			".tmp",
		]);
		const ext = path.extname(baseName).toLowerCase();
		if (!allowedExtensions.has(ext)) {
			return {
				success: false,
				message: `Access denied: file extension not allowed (${ext || "(none)"})`,
			};
		}

		const raw = await readConfigInPath(targetResolved, serverId);
		if (!raw) {
			return { success: false, message: "File not found or empty" };
		}

		const content =
			raw.length > 100000 ? `${raw.slice(0, 100000)}\n...[TRUNCATED]` : raw;

		return {
			success: true,
			message: `Read Traefik file: ${path.relative(rootResolved, targetResolved)}`,
			data: {
				filePath: path.relative(rootResolved, targetResolved),
				content,
			},
		};
	},
};

const traefikAcmeStatus: Tool<
	{
		serverId?: string;
		domainFilter?: string;
		maxItems?: number;
	},
	{
		items: Array<{
			resolver: string;
			domain: string;
			sans: string[];
			issuer?: string;
			serialNumber?: string;
			validFrom?: string;
			validTo?: string;
			expiresInDays?: number;
			status: "valid" | "expired" | "unknown";
			parseError?: string;
		}>;
	}
> = {
	name: "traefik_acme_status",
	description:
		"Get a redacted summary of ACME certificates from Traefik acme.json (no private keys/accounts/raw certs)",
	category: "server",
	aliases: [
		"acme status",
		"traefik certificate status",
		"letsencrypt status",
		"证书状态",
		"ACME状态",
		"续签状态",
	],
	tags: [
		"traefik",
		"acme",
		"certificate",
		"status",
		"letsencrypt",
		"证书",
		"状态",
		"续签",
	],
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (defaults to current context)"),
		domainFilter: z
			.string()
			.optional()
			.describe(
				"Optional domain substring filter (matches main domain and SANs)",
			),
		maxItems: z
			.number()
			.int()
			.min(1)
			.max(200)
			.optional()
			.default(50)
			.describe("Maximum number of certificates to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		const traefikDynamic = paths(!!serverId).DYNAMIC_TRAEFIK_PATH;
		const acmeJsonPath = path.join(traefikDynamic, "acme.json");

		const raw = await readConfigInPath(acmeJsonPath, serverId);
		if (!raw) {
			return {
				success: false,
				message: "acme.json not found or empty",
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				message: `Failed to parse acme.json: ${msg}`,
			};
		}

		const data = parsed as Record<string, any>;
		const items: Array<{
			resolver: string;
			domain: string;
			sans: string[];
			issuer?: string;
			serialNumber?: string;
			validFrom?: string;
			validTo?: string;
			expiresInDays?: number;
			status: "valid" | "expired" | "unknown";
			parseError?: string;
		}> = [];

		const filter = (params.domainFilter ?? "").toLowerCase();
		const maxItems = params.maxItems ?? 50;
		const now = Date.now();

		for (const [resolver, resolverData] of Object.entries(data)) {
			const certs = (resolverData as any)?.Certificates;
			if (!Array.isArray(certs)) continue;

			for (const entry of certs) {
				if (items.length >= maxItems) break;

				const main = String(entry?.domain?.main ?? "");
				const sansRaw = Array.isArray(entry?.domain?.sans)
					? (entry.domain.sans as unknown[])
					: [];
				const sans = sansRaw.map((s) => String(s));
				const allDomains = [main, ...sans].filter((d) => d.trim() !== "");

				if (filter) {
					const match = allDomains.some((d) =>
						d.toLowerCase().includes(filter),
					);
					if (!match) continue;
				}

				const certB64 =
					typeof entry?.certificate === "string" ? entry.certificate : "";
				if (!certB64) {
					items.push({
						resolver,
						domain: main || "(unknown)",
						sans,
						status: "unknown",
						parseError: "Missing certificate field",
					});
					continue;
				}

				try {
					const certBuf = Buffer.from(certB64, "base64");
					const x509 = new X509Certificate(certBuf);

					const validToMs = Date.parse(x509.validTo);
					const expiresInDays = Number.isFinite(validToMs)
						? Math.ceil((validToMs - now) / (1000 * 60 * 60 * 24))
						: undefined;

					items.push({
						resolver,
						domain: main || "(unknown)",
						sans,
						issuer: x509.issuer,
						serialNumber: x509.serialNumber,
						validFrom: x509.validFrom,
						validTo: x509.validTo,
						expiresInDays,
						status:
							expiresInDays === undefined
								? "unknown"
								: expiresInDays >= 0
									? "valid"
									: "expired",
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					items.push({
						resolver,
						domain: main || "(unknown)",
						sans,
						status: "unknown",
						parseError: msg,
					});
				}
			}
		}

		return {
			success: true,
			message: `Found ${items.length} ACME certificate(s)`,
			data: { items },
		};
	},
};

const traefikAcmeRetry: Tool<
	{ serverId?: string; confirm: "RETRY_ACME" },
	{ reloaded: boolean }
> = {
	name: "traefik_acme_retry",
	description:
		"Force reload Traefik (dokploy-traefik) to trigger an ACME retry (requires approval)",
	category: "server",
	aliases: [
		"retry acme",
		"force renew certificate",
		"acme retry",
		"重试ACME",
		"强制续签",
		"重试续签",
	],
	tags: [
		"traefik",
		"acme",
		"retry",
		"renew",
		"certificate",
		"重试",
		"续签",
		"证书",
	],
	parameters: z.object({
		serverId: z
			.string()
			.optional()
			.describe("Server ID (defaults to current context)"),
		confirm: z.literal("RETRY_ACME").describe("Confirmation token: RETRY_ACME"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const serverId = params.serverId ?? ctx.serverId;
		const hasAccess = await canAccessToTraefikFiles(
			ctx.userId,
			ctx.organizationId,
		);
		if (!hasAccess) {
			return { success: false, message: "Permission denied" };
		}

		if (serverId) {
			const server = await findServerById(serverId);
			if (server.organizationId !== ctx.organizationId) {
				return { success: false, message: "Server access denied" };
			}
		}

		await reloadDockerResource("dokploy-traefik", serverId);
		return {
			success: true,
			message:
				"Traefik reload triggered (ACME retry should happen automatically)",
			data: { reloaded: true },
		};
	},
};

export function registerTraefikTools() {
	toolRegistry.register(listTraefikFiles);
	toolRegistry.register(readTraefikConfig);
	toolRegistry.register(readTraefikMiddlewares);
	toolRegistry.register(traefikAcmeStatus);
	toolRegistry.register(writeMainTraefikConfig);
	toolRegistry.register(writeTraefikDynamicConfig);
	toolRegistry.register(reloadTraefik);
	toolRegistry.register(traefikAcmeRetry);
	toolRegistry.register(traefikAcmeLogTail);
}
