export type TrpcProcedureType = "query" | "mutation" | "subscription" | "unknown";

export class TrpcBridgeSubscriptionError extends Error {
	events: unknown[];
	cause?: unknown;

	constructor(message: string, params: { events: unknown[]; cause?: unknown }) {
		super(message);
		this.name = "TrpcBridgeSubscriptionError";
		this.events = Array.isArray(params.events) ? params.events : [];
		this.cause = params.cause;
	}
}

export type TrpcRouterSummary = {
	name: string;
	total: number;
	queries: number;
	mutations: number;
	subscriptions: number;
};

export type TrpcProcedureSummary = {
	name: string;
	type: TrpcProcedureType;
};

export type TrpcProcedureField = {
	name: string;
	type: string;
	required: boolean;
};

export type TrpcProcedureDescription = {
	name: string;
	type: TrpcProcedureType;
	inputExample: Record<string, unknown> | null;
	fields?: TrpcProcedureField[];
};

export interface TrpcBridge {
	listRouters: () =>
		| TrpcRouterSummary[]
		| Promise<TrpcRouterSummary[]>;
	searchProcedures: (params: {
		query: string;
		limit: number;
	}) => TrpcProcedureSummary[] | Promise<TrpcProcedureSummary[]>;
	describeProcedure: (
		procedureName: string,
	) => TrpcProcedureDescription | Promise<TrpcProcedureDescription>;
	callProcedure: (params: {
		procedureName: string;
		input?: unknown;
		ctx: { organizationId: string; userId: string };
	}) => Promise<unknown>;
}

let trpcBridge: TrpcBridge | null = null;

type CacheEntry<T> = { value: T; expiresAt: number };

const TRPC_BRIDGE_CACHE_TTL_MS = Math.min(
	60 * 60 * 1000,
	Math.max(
		5 * 1000,
		Number(process.env.DOKPLOY_TRPC_BRIDGE_CACHE_TTL_MS ?? "300000") || 300000,
	),
);
const TRPC_BRIDGE_CACHE_MAX_ENTRIES = Math.min(
	2000,
	Math.max(
		50,
		Number(process.env.DOKPLOY_TRPC_BRIDGE_CACHE_MAX_ENTRIES ?? "500") || 500,
	),
);

function pruneCache(map: Map<string, CacheEntry<unknown>>) {
	const now = Date.now();
	for (const [key, entry] of map) {
		if (entry.expiresAt <= now) map.delete(key);
	}
	if (map.size <= TRPC_BRIDGE_CACHE_MAX_ENTRIES) return;
	let over = map.size - TRPC_BRIDGE_CACHE_MAX_ENTRIES;
	for (const key of map.keys()) {
		map.delete(key);
		over -= 1;
		if (over <= 0) break;
	}
}

function wrapTrpcBridgeWithCache(bridge: TrpcBridge): TrpcBridge {
	let routersCache: CacheEntry<TrpcRouterSummary[]> | null = null;
	let routersInFlight: Promise<TrpcRouterSummary[]> | null = null;

	const searchCache = new Map<string, CacheEntry<TrpcProcedureSummary[]>>();
	const searchInFlight = new Map<string, Promise<TrpcProcedureSummary[]>>();

	const describeCache = new Map<string, CacheEntry<TrpcProcedureDescription>>();
	const describeInFlight = new Map<string, Promise<TrpcProcedureDescription>>();

	return {
		callProcedure: bridge.callProcedure,
		listRouters: async () => {
			const now = Date.now();
			if (routersCache && routersCache.expiresAt > now) return routersCache.value;
			if (routersInFlight) return routersInFlight;

			routersInFlight = (async () => {
				const value = await bridge.listRouters();
				routersCache = { value, expiresAt: Date.now() + TRPC_BRIDGE_CACHE_TTL_MS };
				return value;
			})().finally(() => {
				routersInFlight = null;
			});

			return routersInFlight;
		},
		searchProcedures: async (params) => {
			const query = typeof params.query === "string" ? params.query.trim() : "";
			const limit = typeof params.limit === "number" ? params.limit : 20;
			const key = `${query}\n${limit}`;

			const now = Date.now();
			const cached = searchCache.get(key);
			if (cached && cached.expiresAt > now) return cached.value;

			const existing = searchInFlight.get(key);
			if (existing) return existing;

			const p = (async () => {
				const value = await bridge.searchProcedures({ query, limit });
				searchCache.set(key, {
					value,
					expiresAt: Date.now() + TRPC_BRIDGE_CACHE_TTL_MS,
				});
				pruneCache(searchCache as unknown as Map<string, CacheEntry<unknown>>);
				return value;
			})().finally(() => {
				searchInFlight.delete(key);
			});

			searchInFlight.set(key, p);
			return p;
		},
		describeProcedure: async (procedureName) => {
			const name =
				typeof procedureName === "string" ? procedureName.trim() : "";
			const key = name;

			const now = Date.now();
			const cached = describeCache.get(key);
			if (cached && cached.expiresAt > now) return cached.value;

			const existing = describeInFlight.get(key);
			if (existing) return existing;

			const p = (async () => {
				const value = await bridge.describeProcedure(name);
				describeCache.set(key, {
					value,
					expiresAt: Date.now() + TRPC_BRIDGE_CACHE_TTL_MS,
				});
				pruneCache(describeCache as unknown as Map<string, CacheEntry<unknown>>);
				return value;
			})().finally(() => {
				describeInFlight.delete(key);
			});

			describeInFlight.set(key, p);
			return p;
		},
	};
}

export function setTrpcBridge(bridge: TrpcBridge | null) {
	trpcBridge = bridge ? wrapTrpcBridgeWithCache(bridge) : null;
}

export function getTrpcBridge(): TrpcBridge | null {
	return trpcBridge;
}
