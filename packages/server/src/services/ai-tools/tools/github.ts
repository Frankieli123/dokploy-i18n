import { db } from "@dokploy/server/db";
import { findGithubById } from "@dokploy/server/services/github";
import {
	authGithub,
	getGithubBranches,
	getGithubRepositories,
} from "@dokploy/server/utils/providers/github";
import { z } from "zod";
import { toolRegistry } from "../registry";
import type { Tool } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PUBLIC_GITHUB_API_BASE = "https://api.github.com";
const PUBLIC_GITHUB_RAW_HOSTS = new Set(["raw.githubusercontent.com"]);

const buildPublicGithubHeaders = (accept = "application/vnd.github+json") => ({
	Accept: accept,
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "dokploy-ai",
});

async function readResponseTextWithLimit(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const header = response.headers.get("content-length");
	const contentLength = header ? Number(header) : NaN;
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		throw new Error(`Response too large (${contentLength} bytes)`);
	}

	const reader = response.body?.getReader();
	if (!reader) {
		const text = await response.text();
		if (text.length > maxBytes) throw new Error("Response too large");
		return text;
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			try {
				await reader.cancel();
			} catch {}
			throw new Error(`Response too large (> ${maxBytes} bytes)`);
		}
		chunks.push(value);
	}

	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(merged);
}

async function fetchPublicGithubJson(url: string, options?: {
	timeoutMs?: number;
	maxBytes?: number;
}): Promise<unknown> {
	const timeoutMs = options?.timeoutMs ?? 10_000;
	const maxBytes = options?.maxBytes ?? 800_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: buildPublicGithubHeaders(),
			signal: controller.signal,
		});
		const text = await readResponseTextWithLimit(res, maxBytes);
		if (!res.ok) {
			throw new Error(text || `GitHub request failed (${res.status})`);
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new Error("Invalid JSON response from GitHub");
		}
	} finally {
		clearTimeout(timer);
	}
}

async function fetchPublicGithubRawText(url: string, options?: {
	timeoutMs?: number;
	maxBytes?: number;
}): Promise<string> {
	const timeoutMs = options?.timeoutMs ?? 10_000;
	const maxBytes = options?.maxBytes ?? 1_000_000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: buildPublicGithubHeaders("application/vnd.github.raw"),
			signal: controller.signal,
		});
		const text = await readResponseTextWithLimit(res, maxBytes);
		if (!res.ok) {
			throw new Error(text || `GitHub request failed (${res.status})`);
		}
		return text;
	} finally {
		clearTimeout(timer);
	}
}

function normalizeRepoPath(path?: string): string {
	return String(path ?? "").replace(/^\/+|\/+$/g, "");
}

function encodeRepoPath(path: string): string {
	return normalizeRepoPath(path)
		.split("/")
		.filter((p) => p.length > 0)
		.map((p) => encodeURIComponent(p))
		.join("/");
}

const listGithubProviders: Tool<
	Record<string, never>,
	Array<{ githubId: string; name: string; gitProviderId: string }>
> = {
	name: "github_provider_list",
	description:
		"List GitHub providers (connected GitHub accounts) available in the organization.",
	category: "github",
	aliases: [
		"github providers",
		"list github accounts",
		"github connections",
		"GitHub账号列表",
		"GitHub连接",
		"GitHub提供商",
	],
	tags: ["github", "provider", "connection", "list", "账号", "连接", "列表"],
	parameters: z.object({}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (_params, ctx) => {
		const providers = await db.query.github.findMany({
			with: {
				gitProvider: true,
			},
		});

		const filtered = providers.filter((p) => {
			return p.gitProvider?.organizationId === ctx.organizationId;
		});

		return {
			success: true,
			message: `Found ${filtered.length} GitHub provider(s)`,
			data: filtered.map((p) => ({
				githubId: p.githubId,
				name: p.gitProvider?.name ?? "GitHub",
				gitProviderId: p.gitProviderId,
			})),
		};
	},
};

const listGithubRepositories: Tool<
	{ githubId: string; limit?: number },
	Array<{
		owner: string;
		repository: string;
		fullName: string;
		private: boolean;
		defaultBranch: string;
	}>
> = {
	name: "github_repository_list",
	description:
		"List repositories accessible to a given GitHub provider connection (GitHub App installation).",
	category: "github",
	aliases: [
		"list github repos",
		"repositories",
		"repo list",
		"仓库列表",
		"查看仓库",
		"项目仓库",
	],
	tags: ["github", "repo", "repository", "list", "仓库", "列表"],
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		limit: z
			.number()
			.min(1)
			.max(200)
			.optional()
			.default(50)
			.describe("Maximum number of repositories to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: [],
			};
		}

		const repos = await getGithubRepositories(params.githubId);
		const limit = params.limit ?? 50;
		const picked = repos.slice(0, limit);

		return {
			success: true,
			message: `Found ${picked.length} repositor${picked.length === 1 ? "y" : "ies"}`,
			data: picked
				.map((r) => ({
					owner: r.owner?.login ?? "",
					repository: r.name ?? "",
					fullName: r.full_name ?? "",
					private: Boolean(r.private),
					defaultBranch: r.default_branch ?? "main",
				}))
				.filter((x) => x.owner && x.repository),
		};
	},
};

const listGithubBranches: Tool<
	{ githubId: string; owner: string; repo: string; limit?: number },
	Array<{ name: string; protected: boolean }>
> = {
	name: "github_branch_list",
	description: "List branches for a GitHub repository",
	category: "github",
	aliases: [
		"list branches",
		"github branches",
		"branch list",
		"分支列表",
		"查看分支",
	],
	tags: ["github", "branch", "list", "分支", "列表"],
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		limit: z
			.number()
			.min(1)
			.max(200)
			.optional()
			.default(60)
			.describe("Maximum number of branches to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: [],
			};
		}

		const branches = await getGithubBranches({
			githubId: params.githubId,
			owner: params.owner,
			repo: params.repo,
		});
		const limit = params.limit ?? 60;
		const picked = branches.slice(0, limit);
		return {
			success: true,
			message: `Found ${picked.length} branch(es)`,
			data: picked.map((b) => ({
				name: b.name,
				protected: Boolean(b.protected),
			})),
		};
	},
};

const createRepoBranch: Tool<
	{
		githubId: string;
		owner: string;
		repo: string;
		branch: string;
		fromBranch: string;
	},
	{ branch: string }
> = {
	name: "github_branch_create",
	description: "Create a new branch in a GitHub repository",
	category: "github",
	aliases: [
		"create branch",
		"new branch",
		"git branch",
		"创建分支",
		"新建分支",
	],
	tags: ["github", "branch", "create", "创建", "分支"],
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		branch: z.string().min(1).describe("New branch name"),
		fromBranch: z
			.string()
			.min(1)
			.default("main")
			.describe("Base branch to create from"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { branch: "" },
			};
		}

		const octokit = authGithub(provider);
		const baseRef = await octokit.rest.git.getRef({
			owner: params.owner,
			repo: params.repo,
			ref: `heads/${params.fromBranch}`,
		});
		const sha = baseRef.data.object.sha;

		try {
			await octokit.rest.git.createRef({
				owner: params.owner,
				repo: params.repo,
				ref: `refs/heads/${params.branch}`,
				sha,
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				success: false,
				message: "Failed to create branch",
				error: msg,
				data: { branch: "" },
			};
		}

		return {
			success: true,
			message: `Branch "${params.branch}" created from "${params.fromBranch}"`,
			data: { branch: params.branch },
		};
	},
};

const listRepoPath: Tool<
	{
		githubId: string;
		owner: string;
		repo: string;
		path?: string;
		ref?: string;
		limit?: number;
	},
	Array<{
		name: string;
		path: string;
		type: "file" | "dir" | "symlink" | "submodule" | "unknown";
		sha: string;
		size?: number;
	}>
> = {
	name: "github_path_list",
	description:
		"List directory contents for a GitHub repository path at a given ref. Use this to discover file paths before calling github_file_get.",
	category: "github",
	aliases: [
		"list repo files",
		"list files",
		"list directory",
		"github tree",
		"目录列表",
		"列出文件",
		"仓库文件列表",
	],
	tags: ["github", "repo", "path", "directory", "list", "目录", "文件", "列表"],
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		path: z
			.string()
			.optional()
			.default("")
			.describe("Directory path in repository (empty for repo root)"),
		ref: z.string().optional().describe("Branch name or commit SHA"),
		limit: z
			.number()
			.min(1)
			.max(200)
			.optional()
			.default(200)
			.describe("Maximum number of entries to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: [],
			};
		}

		const octokit = authGithub(provider);
		const normalizedPath = (params.path ?? "").replace(/^\/+|\/+$/g, "");

		const res = await octokit.rest.repos.getContent({
			owner: params.owner,
			repo: params.repo,
			path: normalizedPath,
			ref: params.ref,
		});

		if (!Array.isArray(res.data)) {
			const type = res.data.type;
			return {
				success: false,
				message:
					type === "file"
						? "Path is a file; use github_file_get"
						: "Path is not a directory",
				data: [],
			};
		}

		const limit = params.limit ?? 200;
		const items = res.data
			.map((item) => {
				const type = (
					item.type === "file" ||
					item.type === "dir" ||
					item.type === "symlink" ||
					item.type === "submodule"
						? item.type
						: "unknown"
				) as "file" | "dir" | "symlink" | "submodule" | "unknown";
				return {
					name: item.name ?? "",
					path: item.path ?? "",
					type,
					sha: item.sha ?? "",
					size: typeof item.size === "number" ? item.size : undefined,
				};
			})
			.filter((x) => x.path.length > 0)
			.slice(0, limit);

		const label = normalizedPath.length > 0 ? normalizedPath : "/";
		return {
			success: true,
			message: `Found ${items.length} item(s) under "${label}"`,
			data: items,
		};
	},
};

const searchPublicGithubRepositories: Tool<
	{ query: string; limit?: number },
	Array<{
		owner: string;
		repository: string;
		fullName: string;
		description: string | null;
		stars: number;
		defaultBranch: string;
		updatedAt: string;
		htmlUrl: string;
	}>
> = {
	name: "github_public_repository_search",
	description:
		"Search public GitHub repositories by keyword. Useful for finding other people's open-source repos.",
	category: "github",
	aliases: [
		"search github repos",
		"find repo",
		"search public repo",
		"搜索公开仓库",
		"搜索开源仓库",
	],
	tags: ["github", "public", "search", "repo", "开源", "公开", "搜索", "仓库"],
	parameters: z.object({
		query: z.string().min(1).describe("Search query (GitHub search syntax)"),
		limit: z
			.number()
			.min(1)
			.max(30)
			.optional()
			.default(10)
			.describe("Maximum number of repositories to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const limit = params.limit ?? 10;
		const perPage = Math.min(30, Math.max(1, limit));
		const url = `${PUBLIC_GITHUB_API_BASE}/search/repositories?${new URLSearchParams({
			q: params.query,
			per_page: String(perPage),
		}).toString()}`;

		let json: unknown;
		try {
			json = await fetchPublicGithubJson(url, { maxBytes: 1_200_000 });
		} catch (e) {
			return {
				success: false,
				message: "Failed to search public GitHub repositories",
				error: e instanceof Error ? e.message : String(e),
				data: [],
			};
		}

		const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
		const mapped = items
			.slice(0, limit)
			.map((r) => {
				const owner =
					isRecord(r) && isRecord(r.owner) && typeof r.owner.login === "string"
						? r.owner.login
						: "";
				const repository = isRecord(r) && typeof r.name === "string" ? r.name : "";
				return {
					owner,
					repository,
					fullName:
						isRecord(r) && typeof r.full_name === "string" ? r.full_name : "",
					description:
						isRecord(r) && typeof r.description === "string"
							? r.description
							: null,
					stars:
						isRecord(r) && typeof r.stargazers_count === "number"
							? r.stargazers_count
							: 0,
					defaultBranch:
						isRecord(r) && typeof r.default_branch === "string"
							? r.default_branch
							: "main",
					updatedAt:
						isRecord(r) && typeof r.updated_at === "string" ? r.updated_at : "",
					htmlUrl:
						isRecord(r) && typeof r.html_url === "string" ? r.html_url : "",
				};
			})
			.filter((x) => x.owner && x.repository);

		return {
			success: true,
			message: `Found ${mapped.length} public repositor${mapped.length === 1 ? "y" : "ies"}`,
			data: mapped,
		};
	},
};

const getPublicGithubRepository: Tool<
	{ owner: string; repo: string },
	{
		owner: string;
		repository: string;
		fullName: string;
		description: string | null;
		private: boolean;
		defaultBranch: string;
		htmlUrl: string;
	}
> = {
	name: "github_public_repository_get",
	description:
		"Get basic information for a public GitHub repository (no provider required).",
	category: "github",
	aliases: ["repo info", "github repo info", "公开仓库信息", "仓库详情"],
	tags: ["github", "public", "repo", "get", "info", "公开", "仓库", "详情"],
	parameters: z.object({
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const url = `${PUBLIC_GITHUB_API_BASE}/repos/${encodeURIComponent(
			params.owner,
		)}/${encodeURIComponent(params.repo)}`;

		let json: unknown;
		try {
			json = await fetchPublicGithubJson(url, { maxBytes: 500_000 });
		} catch (e) {
			return {
				success: false,
				message: "Failed to fetch public GitHub repository info",
				error: e instanceof Error ? e.message : String(e),
				data: {
					owner: "",
					repository: "",
					fullName: "",
					description: null,
					private: false,
					defaultBranch: "main",
					htmlUrl: "",
				},
			};
		}

		const ownerLogin =
			isRecord(json) &&
			isRecord(json.owner) &&
			typeof json.owner.login === "string"
				? json.owner.login
				: params.owner;
		const repoName =
			isRecord(json) && typeof json.name === "string" ? json.name : params.repo;

		return {
			success: true,
			message: `Repository "${ownerLogin}/${repoName}" fetched`,
			data: {
				owner: ownerLogin,
				repository: repoName,
				fullName:
					isRecord(json) && typeof json.full_name === "string"
						? json.full_name
						: `${ownerLogin}/${repoName}`,
				description:
					isRecord(json) && typeof json.description === "string"
						? json.description
						: null,
				private: Boolean(isRecord(json) ? json.private : false),
				defaultBranch:
					isRecord(json) && typeof json.default_branch === "string"
						? json.default_branch
						: "main",
				htmlUrl:
					isRecord(json) && typeof json.html_url === "string" ? json.html_url : "",
			},
		};
	},
};

const listPublicGithubRepoPath: Tool<
	{ owner: string; repo: string; path?: string; ref?: string; limit?: number },
	Array<{
		name: string;
		path: string;
		type: "file" | "dir" | "symlink" | "submodule" | "unknown";
		sha: string;
		size?: number;
	}>
> = {
	name: "github_public_path_list",
	description:
		"List directory contents for a public GitHub repository path at a given ref.",
	category: "github",
	aliases: [
		"list public repo files",
		"public repo directory",
		"公开仓库目录列表",
		"公开仓库文件列表",
	],
	tags: ["github", "public", "path", "directory", "list", "公开", "目录", "文件"],
	parameters: z.object({
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		path: z
			.string()
			.optional()
			.default("")
			.describe("Directory path (empty for repo root)"),
		ref: z.string().optional().describe("Branch name or commit SHA"),
		limit: z
			.number()
			.min(1)
			.max(200)
			.optional()
			.default(200)
			.describe("Maximum number of entries to return"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const normalizedPath = normalizeRepoPath(params.path);
		const encodedPath = normalizedPath ? `/${encodeRepoPath(normalizedPath)}` : "";
		const qs = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : "";
		const url = `${PUBLIC_GITHUB_API_BASE}/repos/${encodeURIComponent(
			params.owner,
		)}/${encodeURIComponent(params.repo)}/contents${encodedPath}${qs}`;

		let json: unknown;
		try {
			json = await fetchPublicGithubJson(url, { maxBytes: 2_000_000 });
		} catch (e) {
			return {
				success: false,
				message: "Failed to list public GitHub repository path",
				error: e instanceof Error ? e.message : String(e),
				data: [],
			};
		}

		if (!Array.isArray(json)) {
			const type = isRecord(json) && typeof json.type === "string" ? json.type : "";
			return {
				success: false,
				message:
					type === "file"
						? "Path is a file; use github_public_file_get"
						: "Path is not a directory",
				data: [],
			};
		}

		const limit = params.limit ?? 200;
		const items = json
			.map((item) => {
				const type = (
					isRecord(item) &&
					(item.type === "file" ||
						item.type === "dir" ||
						item.type === "symlink" ||
						item.type === "submodule")
						? item.type
						: "unknown"
				) as "file" | "dir" | "symlink" | "submodule" | "unknown";
				return {
					name: isRecord(item) && typeof item.name === "string" ? item.name : "",
					path: isRecord(item) && typeof item.path === "string" ? item.path : "",
					type,
					sha: isRecord(item) && typeof item.sha === "string" ? item.sha : "",
					size:
						isRecord(item) && typeof item.size === "number" ? item.size : undefined,
				};
			})
			.filter((x) => x.path.length > 0)
			.slice(0, limit);

		const label = normalizedPath.length > 0 ? normalizedPath : "/";
		return {
			success: true,
			message: `Found ${items.length} item(s) under "${label}"`,
			data: items,
		};
	},
};

const getPublicGithubRepoFile: Tool<
	{
		owner: string;
		repo: string;
		path: string;
		ref?: string;
		maxBytes?: number;
	},
	{ path: string; content: string; sha: string }
> = {
	name: "github_public_file_get",
	description:
		"Get a file's content from a public GitHub repository at a given ref (no provider required).",
	category: "github",
	aliases: ["read public github file", "公开仓库读取文件", "开源仓库读取文件"],
	tags: ["github", "public", "file", "read", "get", "公开", "文件", "读取"],
	parameters: z.object({
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		path: z.string().min(1).describe("File path in repository"),
		ref: z.string().optional().describe("Branch name or commit SHA"),
		maxBytes: z
			.number()
			.min(1_000)
			.max(1_000_000)
			.optional()
			.default(400_000)
			.describe("Maximum bytes to read from the file"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params) => {
		const normalizedPath = normalizeRepoPath(params.path);
		const qs = params.ref ? `?ref=${encodeURIComponent(params.ref)}` : "";
		const url = `${PUBLIC_GITHUB_API_BASE}/repos/${encodeURIComponent(
			params.owner,
		)}/${encodeURIComponent(params.repo)}/contents/${encodeRepoPath(
			normalizedPath,
		)}${qs}`;

		let json: unknown;
		try {
			json = await fetchPublicGithubJson(url, { maxBytes: 2_500_000 });
		} catch (e) {
			return {
				success: false,
				message: "Failed to fetch public GitHub file",
				error: e instanceof Error ? e.message : String(e),
				data: { path: normalizedPath, content: "", sha: "" },
			};
		}

		if (Array.isArray(json)) {
			return {
				success: false,
				message: "Path is a directory; use github_public_path_list",
				data: { path: normalizedPath, content: "", sha: "" },
			};
		}

		const type = isRecord(json) && typeof json.type === "string" ? json.type : "";
		if (type !== "file") {
			return {
				success: false,
				message: "Path is not a file",
				data: { path: normalizedPath, content: "", sha: "" },
			};
		}

		const sha = isRecord(json) && typeof json.sha === "string" ? json.sha : "";
		const maxBytes = params.maxBytes ?? 400_000;

		const downloadUrl =
			isRecord(json) && typeof json.download_url === "string"
				? json.download_url
				: "";
		if (downloadUrl) {
			try {
				const u = new URL(downloadUrl);
				if (!PUBLIC_GITHUB_RAW_HOSTS.has(u.hostname)) {
					throw new Error("download_url host not allowed");
				}
				const content = await fetchPublicGithubRawText(downloadUrl, {
					maxBytes,
					timeoutMs: 15_000,
				});
				return {
					success: true,
					message: `File "${normalizedPath}" fetched`,
					data: { path: normalizedPath, content, sha },
				};
			} catch (e) {
				return {
					success: false,
					message: "Failed to download public GitHub file content",
					error: e instanceof Error ? e.message : String(e),
					data: { path: normalizedPath, content: "", sha },
				};
			}
		}

		const encoded = isRecord(json) && typeof json.content === "string" ? json.content : "";
		const encoding =
			isRecord(json) && typeof json.encoding === "string" ? json.encoding : "";
		if (!encoded || encoding !== "base64") {
			return {
				success: false,
				message: "File content is not available via GitHub API",
				data: { path: normalizedPath, content: "", sha },
			};
		}

		const decoded = Buffer.from(encoded, "base64").toString("utf8");
		if (decoded.length > maxBytes) {
			return {
				success: false,
				message: `File too large (> ${maxBytes} bytes)`,
				data: { path: normalizedPath, content: "", sha },
			};
		}

		return {
			success: true,
			message: `File "${normalizedPath}" fetched`,
			data: { path: normalizedPath, content: decoded, sha },
		};
	},
};

const getRepoFile: Tool<
	{ githubId: string; owner: string; repo: string; path: string; ref?: string },
	{ path: string; content: string; sha: string }
> = {
	name: "github_file_get",
	description: "Get a file's content from a GitHub repository at a given ref",
	category: "github",
	aliases: ["get file", "read file", "github file", "读取文件", "查看文件"],
	tags: ["github", "file", "read", "get", "文件", "读取"],
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		path: z.string().min(1).describe("File path in repository"),
		ref: z.string().optional().describe("Branch name or commit SHA"),
	}),
	riskLevel: "low",
	requiresApproval: false,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { path: "", content: "", sha: "" },
			};
		}

		const octokit = authGithub(provider);
		const res = await octokit.rest.repos.getContent({
			owner: params.owner,
			repo: params.repo,
			path: params.path,
			ref: params.ref,
		});

		if (Array.isArray(res.data) || res.data.type !== "file") {
			return {
				success: false,
				message: "Path is not a file",
				data: { path: params.path, content: "", sha: "" },
			};
		}

		const encoded = res.data.content ?? "";
		const content = Buffer.from(encoded, "base64").toString("utf8");
		return {
			success: true,
			message: `File "${params.path}" fetched`,
			data: {
				path: params.path,
				content,
				sha: res.data.sha,
			},
		};
	},
};

const upsertRepoFile: Tool<
	{
		githubId: string;
		owner: string;
		repo: string;
		branch: string;
		path: string;
		content: string;
		message: string;
		sha?: string;
	},
	{ path: string; commitSha: string }
> = {
	name: "github_file_upsert",
	description:
		"Create or update a file in a GitHub repository branch (createOrUpdateFileContents)",
	category: "github",
	aliases: [
		"update file",
		"write file",
		"commit file",
		"更新文件",
		"写入文件",
		"提交文件",
	],
	tags: [
		"github",
		"file",
		"update",
		"write",
		"commit",
		"文件",
		"更新",
		"写入",
		"提交",
	],
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		branch: z.string().min(1).describe("Branch to commit to"),
		path: z.string().min(1).describe("File path in repository"),
		content: z.string().describe("New file content (raw string, not base64)"),
		message: z.string().min(1).describe("Commit message"),
		sha: z
			.string()
			.optional()
			.describe("Existing file SHA. If omitted, tool will try to detect it."),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { path: "", commitSha: "" },
			};
		}

		const octokit = authGithub(provider);

		let sha = params.sha;
		if (!sha) {
			try {
				const current = await octokit.rest.repos.getContent({
					owner: params.owner,
					repo: params.repo,
					path: params.path,
					ref: params.branch,
				});
				if (!Array.isArray(current.data) && current.data.type === "file") {
					sha = current.data.sha;
				}
			} catch {}
		}

		const res = await octokit.rest.repos.createOrUpdateFileContents({
			owner: params.owner,
			repo: params.repo,
			path: params.path,
			branch: params.branch,
			message: params.message,
			content: Buffer.from(params.content, "utf8").toString("base64"),
			...(sha ? { sha } : {}),
		});

		const commitSha = res.data.commit?.sha;
		if (!commitSha) {
			return {
				success: false,
				message: "File commit succeeded but commit SHA was missing in response",
				error: "Missing commit SHA",
				data: { path: params.path, commitSha: "" },
			};
		}

		return {
			success: true,
			message: `File "${params.path}" committed to "${params.branch}"`,
			data: {
				path: params.path,
				commitSha,
			},
		};
	},
};

const createPullRequest: Tool<
	{
		githubId: string;
		owner: string;
		repo: string;
		head: string;
		base: string;
		title: string;
		body?: string;
	},
	{ url: string; number: number }
> = {
	name: "github_pull_request_create",
	description: "Create a GitHub pull request",
	category: "github",
	aliases: [
		"create pr",
		"open pr",
		"pull request",
		"创建PR",
		"创建拉取请求",
		"开PR",
	],
	tags: [
		"github",
		"pull",
		"request",
		"pr",
		"create",
		"拉取请求",
		"合并请求",
		"创建",
	],
	parameters: z.object({
		githubId: z.string().min(1).describe("GitHub provider ID"),
		owner: z.string().min(1).describe("Repository owner"),
		repo: z.string().min(1).describe("Repository name"),
		head: z.string().min(1).describe("Head branch (e.g. fix-branch)"),
		base: z.string().min(1).describe("Base branch (e.g. main)"),
		title: z.string().min(1).describe("Pull request title"),
		body: z.string().optional().describe("Pull request description"),
	}),
	riskLevel: "high",
	requiresApproval: true,
	execute: async (params, ctx) => {
		const provider = await findGithubById(params.githubId);
		if (provider.gitProvider?.organizationId !== ctx.organizationId) {
			return {
				success: false,
				message: "GitHub provider access denied",
				data: { url: "", number: 0 },
			};
		}

		const octokit = authGithub(provider);
		const pr = await octokit.rest.pulls.create({
			owner: params.owner,
			repo: params.repo,
			head: params.head,
			base: params.base,
			title: params.title,
			body: params.body ?? "",
			maintainer_can_modify: true,
		});

		return {
			success: true,
			message: `Pull request #${pr.data.number} created`,
			data: {
				url: pr.data.html_url,
				number: pr.data.number,
			},
		};
	},
};

export function registerGithubTools() {
	toolRegistry.register(listGithubProviders);
	toolRegistry.register(listGithubRepositories);
	toolRegistry.register(searchPublicGithubRepositories);
	toolRegistry.register(getPublicGithubRepository);
	toolRegistry.register(listPublicGithubRepoPath);
	toolRegistry.register(getPublicGithubRepoFile);
	toolRegistry.register(listGithubBranches);
	toolRegistry.register(createRepoBranch);
	toolRegistry.register(listRepoPath);
	toolRegistry.register(getRepoFile);
	toolRegistry.register(upsertRepoFile);
	toolRegistry.register(createPullRequest);
}
