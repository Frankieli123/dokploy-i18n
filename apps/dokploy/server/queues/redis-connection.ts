import type { ConnectionOptions } from "bullmq";

function parseRedisUrl(value: string): ConnectionOptions | null {
	const raw = value.trim();
	if (raw.length === 0) return null;

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}

	const protocol = url.protocol.replace(":", "").toLowerCase();
	if (protocol !== "redis" && protocol !== "rediss") return null;

	const host = url.hostname;
	const port = url.port ? Number(url.port) : 6379;
	const username = url.username ? decodeURIComponent(url.username) : undefined;
	const password = url.password ? decodeURIComponent(url.password) : undefined;
	const dbFromPath = (() => {
		const p = url.pathname?.trim() || "";
		if (p === "" || p === "/") return undefined;
		const n = Number(p.replace(/^\//, ""));
		return Number.isFinite(n) ? n : undefined;
	})();

	if (!host || !Number.isFinite(port)) return null;

	const out: ConnectionOptions = { host, port };
	if (username) (out as any).username = username;
	if (password) (out as any).password = password;
	if (protocol === "rediss") (out as any).tls = {};
	if (dbFromPath != null) (out as any).db = dbFromPath;
	return out;
}

export const redisConfig: ConnectionOptions = (() => {
	const fromUrl = parseRedisUrl(process.env.REDIS_URL || "");
	if (fromUrl) return fromUrl;

	const host =
		process.env.REDIS_HOST ||
		(process.env.NODE_ENV === "production" ? "dokploy-redis" : "127.0.0.1");
	const port = process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : undefined;
	const password = process.env.REDIS_PASSWORD || undefined;

	const out: ConnectionOptions = { host };
	if (Number.isFinite(port)) out.port = port as number;
	if (password) (out as any).password = password;
	return out;
})();
