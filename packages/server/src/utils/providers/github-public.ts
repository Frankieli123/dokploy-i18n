import { quote } from "shell-quote";

type RepoRef = { owner: string; repo: string };

type GithubRepoInfo = {
	id: number;
	full_name: string;
	private: boolean;
	fork: boolean;
	description: string | null;
	html_url: string;
	default_branch: string;
	stargazers_count?: number;
	watchers_count?: number;
	forks_count?: number;
	open_issues_count?: number;
	language?: string | null;
	license?: { key: string; name: string } | null;
};

type GithubContentFile = {
	type: "file";
	name: string;
	path: string;
	sha: string;
	size: number;
	html_url?: string;
	download_url?: string | null;
	content?: string;
	encoding?: string;
};

type GithubContentDirEntry = {
	type: "dir" | "file" | "symlink" | "submodule";
	name: string;
	path: string;
	sha: string;
	size?: number;
	html_url?: string;
	download_url?: string | null;
};

function getPublicGithubToken(): string | undefined {
	const raw =
		process.env.GITHUB_PUBLIC_READ_TOKEN?.trim() ||
		process.env.GITHUB_TOKEN?.trim() ||
		"";
	return raw.length > 0 ? raw : undefined;
}

function githubHeaders(extra?: Record<string, string>): HeadersInit {
	const token = getPublicGithubToken();
	return {
		Accept: "application/vnd.github+json",
		"User-Agent": "dokploy",
		"X-GitHub-Api-Version": "2022-11-28",
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		...(extra ?? {}),
	};
}

async function githubApiJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { headers: githubHeaders() });
	if (res.ok) return (await res.json()) as T;

	let detail = "";
	try {
		const body = (await res.json()) as { message?: unknown };
		if (typeof body?.message === "string") detail = body.message;
	} catch {
		try {
			detail = (await res.text()).trim();
		} catch {}
	}

	const rateHint =
		res.status === 403 &&
		(/rate limit/i.test(detail) || res.headers.get("x-ratelimit-remaining") === "0")
			? " (GitHub API rate limit exceeded; set GITHUB_PUBLIC_READ_TOKEN to increase limits)"
			: "";

	throw new Error(
		`GitHub API request failed (${res.status} ${res.statusText})${rateHint}${detail ? `: ${detail}` : ""}`,
	);
}

async function fetchTextWithLimit(url: string, maxBytes: number): Promise<string> {
	const res = await fetch(url, { headers: { "User-Agent": "dokploy" } });
	if (!res.ok) {
		throw new Error(`Failed to fetch raw content (${res.status} ${res.statusText})`);
	}

	const lenHeader = res.headers.get("content-length");
	if (lenHeader) {
		const len = Number.parseInt(lenHeader, 10);
		if (Number.isFinite(len) && len > maxBytes) {
			throw new Error(`File is too large (${len} bytes > ${maxBytes} bytes)`);
		}
	}

	const body = res.body;
	if (!body) return await res.text();

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let out = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		received += value.byteLength;
		if (received > maxBytes) {
			throw new Error(`File is too large (> ${maxBytes} bytes)`);
		}
		out += decoder.decode(value, { stream: true });
	}

	out += decoder.decode();
	return out;
}

function normalizeGithubRepo(input: string): RepoRef {
	const raw = input.trim();
	if (!raw) throw new Error("Repository is required");

	const fromOwnerRepo = (owner: string, repo: string): RepoRef => {
		const o = owner.trim();
		const r = repo.trim().replace(/\.git$/i, "");
		if (!o || !r) throw new Error("Invalid repository reference");
		if (!/^[A-Za-z0-9_.-]+$/.test(o) || !/^[A-Za-z0-9_.-]+$/.test(r)) {
			throw new Error("Invalid owner/repo format");
		}
		return { owner: o, repo: r };
	};

	const sshMatch = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
	if (sshMatch) {
		const owner = sshMatch[1];
		const repo = sshMatch[2];
		if (owner && repo) return fromOwnerRepo(owner, repo);
	}

	if (raw.includes("://")) {
		const u = new URL(raw);
		const host = u.hostname.toLowerCase();
		if (host === "github.com") {
			const parts = u.pathname.replace(/^\/+/, "").split("/");
			const owner = parts[0];
			const repo = parts[1];
			if (owner && repo) return fromOwnerRepo(owner, repo);
		}
		if (host === "raw.githubusercontent.com") {
			const parts = u.pathname.replace(/^\/+/, "").split("/");
			const owner = parts[0];
			const repo = parts[1];
			if (owner && repo) return fromOwnerRepo(owner, repo);
		}
	}

	const m = raw.match(/^([^/]+)\/([^/]+)$/);
	if (m) {
		const owner = m[1];
		const repo = m[2];
		if (owner && repo) return fromOwnerRepo(owner, repo);
	}

	throw new Error("Repository must be in the form owner/repo or a GitHub URL");
}

function encodeGithubPath(path: string): string {
	const clean = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
	if (!clean) return "";
	return clean
		.split("/")
		.filter(Boolean)
		.map((seg) => encodeURIComponent(seg))
		.join("/");
}

export async function githubPublicRepoInfo(input: {
	repo: string;
}): Promise<GithubRepoInfo> {
	const { owner, repo } = normalizeGithubRepo(input.repo);
	const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
	return githubApiJson<GithubRepoInfo>(url);
}

export async function githubPublicRepoListPath(input: {
	repo: string;
	path?: string;
	ref?: string;
}): Promise<
	| { kind: "file"; file: GithubContentFile }
	| { kind: "dir"; entries: GithubContentDirEntry[] }
> {
	const { owner, repo } = normalizeGithubRepo(input.repo);
	const encPath = encodeGithubPath(input.path ?? "");
	const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${
		encPath ? `/${encPath}` : ""
	}`;
	const url =
		typeof input.ref === "string" && input.ref.trim().length > 0
			? `${base}?ref=${encodeURIComponent(input.ref.trim())}`
			: base;

	const payload = await githubApiJson<unknown>(url);
	if (Array.isArray(payload)) {
		return {
			kind: "dir",
			entries: payload as GithubContentDirEntry[],
		};
	}
	return {
		kind: "file",
		file: payload as GithubContentFile,
	};
}

export async function githubPublicRepoReadFile(input: {
	repo: string;
	path: string;
	ref?: string;
	maxBytes?: number;
}): Promise<{
	repo: string;
	path: string;
	ref?: string;
	size?: number;
	truncated: boolean;
	content: string;
}> {
	const maxBytes = Math.min(
		Math.max(1, input.maxBytes ?? 250_000),
		1_000_000,
	);
	const listed = await githubPublicRepoListPath({
		repo: input.repo,
		path: input.path,
		ref: input.ref,
	});
	if (listed.kind !== "file" || listed.file.type !== "file") {
		throw new Error("Path is not a file");
	}

	const file = listed.file;
	if (typeof file.size === "number" && file.size > maxBytes) {
		throw new Error(`File is too large (${file.size} bytes > ${maxBytes} bytes)`);
	}

	if (
		typeof file.content === "string" &&
		typeof file.encoding === "string" &&
		file.encoding.toLowerCase() === "base64"
	) {
		const decoded = Buffer.from(file.content.replaceAll("\n", ""), "base64").toString(
			"utf8",
		);
		return {
			repo: input.repo,
			path: input.path,
			ref: input.ref,
			size: file.size,
			truncated: false,
			content: decoded,
		};
	}

	if (typeof file.download_url === "string" && file.download_url.trim().length > 0) {
		const content = await fetchTextWithLimit(file.download_url, maxBytes);
		return {
			repo: input.repo,
			path: input.path,
			ref: input.ref,
			size: file.size,
			truncated: false,
			content,
		};
	}

	throw new Error(
		`Unable to read file content (GitHub API did not return content/download_url). Troubleshooting: ${quote(
			[input.repo],
		)}`,
	);
}
