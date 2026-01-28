import { db } from "@dokploy/server/db";
import { member as memberTable } from "@dokploy/server/db/schema";
import { getDokployUrl } from "@dokploy/server/services/admin";
import {
	getTrpcBridge,
	setTrpcBridge,
	type TrpcBridge,
	TrpcBridgeSubscriptionError,
	type TrpcProcedureDescription,
	type TrpcProcedureType,
	type TrpcRouterSummary,
} from "@dokploy/server/services/ai/trpc-bridge";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

let cachedCallerHeaders: Record<string, string> | null = null;
let cachedCallerHeadersAt = 0;
const CALLER_HEADERS_TTL_MS = 60_000;

const TRPC_SUBSCRIPTION_MAX_EVENTS = Math.min(
	10_000,
	Math.max(
		100,
		Number(process.env.DOKPLOY_TRPC_SUBSCRIPTION_MAX_EVENTS ?? "2000") || 2000,
	),
);
const TRPC_SUBSCRIPTION_MAX_CHARS = Math.min(
	2_000_000,
	Math.max(
		10_000,
		Number(process.env.DOKPLOY_TRPC_SUBSCRIPTION_MAX_CHARS ?? "200000") || 200000,
	),
);
const TRPC_SUBSCRIPTION_TIMEOUT_MS = Math.min(
	6 * 60 * 60 * 1000,
	Math.max(
		10 * 1000,
		Number(process.env.DOKPLOY_TRPC_SUBSCRIPTION_TIMEOUT_MS ?? "1800000") ||
			1800000,
	),
);

function isObservableLike(value: unknown): value is {
	subscribe: (observer: {
		next?: (value: unknown) => void;
		error?: (error: unknown) => void;
		complete?: () => void;
	}) => { unsubscribe: () => void };
} {
	return (
		typeof value === "object" &&
		value !== null &&
		"subscribe" in value &&
		typeof (value as { subscribe?: unknown }).subscribe === "function"
	);
}

async function getCallerHeaders(): Promise<Record<string, string>> {
	const now = Date.now();
	if (cachedCallerHeaders && now - cachedCallerHeadersAt < CALLER_HEADERS_TTL_MS) {
		return cachedCallerHeaders;
	}

	try {
		const url = new URL(await getDokployUrl());
		const host = url.host;
		const proto = url.protocol.replace(":", "");
		cachedCallerHeaders = {
			host,
			"x-forwarded-host": host,
			"x-forwarded-proto": proto,
		};
	} catch {
		cachedCallerHeaders = {};
	}

	cachedCallerHeadersAt = now;
	return cachedCallerHeaders;
}

function unwrapSchema(schema: z.ZodTypeAny): {
	schema: z.ZodTypeAny;
	optional: boolean;
	nullable: boolean;
	hasDefault: boolean;
} {
	let optional = false;
	let nullable = false;
	let hasDefault = false;
	let current: z.ZodTypeAny = schema;

	while (true) {
		if (current instanceof z.ZodOptional) {
			optional = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodNullable) {
			nullable = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodDefault) {
			hasDefault = true;
			current = current._def.innerType;
			continue;
		}
		if (current instanceof z.ZodEffects) {
			current = current._def.schema;
			continue;
		}
		if (current instanceof z.ZodBranded) {
			current = current._def.type;
			continue;
		}
		if (current instanceof z.ZodReadonly) {
			current = current._def.innerType;
			continue;
		}
		break;
	}

	return { schema: current, optional, nullable, hasDefault };
}

function getZodObjectShape(schema: z.ZodObject<any>): Record<string, z.ZodTypeAny> {
	const def = schema._def as unknown as { shape?: unknown };
	if (typeof def.shape === "function") {
		return (def.shape as () => Record<string, z.ZodTypeAny>)();
	}
	return (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
}

function getTypeLabel(schema: z.ZodTypeAny): string {
	if (schema instanceof z.ZodString) return "string";
	if (schema instanceof z.ZodNumber) return "number";
	if (schema instanceof z.ZodBoolean) return "boolean";
	if (schema instanceof z.ZodDate) return "date";
	if (schema instanceof z.ZodEnum || schema instanceof z.ZodNativeEnum)
		return "enum";
	if (schema instanceof z.ZodArray) return "array";
	if (schema instanceof z.ZodObject) return "object";
	if (schema instanceof z.ZodLiteral) return "literal";
	if (schema instanceof z.ZodUnion) return "union";
	return "unknown";
}

function extractLiteralStringOptions(schema: z.ZodTypeAny): string[] {
	const unwrapped = unwrapSchema(schema).schema;
	if (unwrapped instanceof z.ZodLiteral) {
		return typeof unwrapped._def.value === "string" ? [unwrapped._def.value] : [];
	}
	if (unwrapped instanceof z.ZodEnum) {
		return Array.isArray(unwrapped._def.values)
			? (unwrapped._def.values as string[])
			: [];
	}
	if (unwrapped instanceof z.ZodNativeEnum) {
		return Object.values(
			(unwrapped._def.values ?? {}) as Record<string, unknown>,
		).filter((v): v is string => typeof v === "string");
	}
	if (unwrapped instanceof z.ZodUnion) {
		const opts = (unwrapped._def.options as z.ZodTypeAny[]).flatMap((opt) =>
			extractLiteralStringOptions(opt),
		);
		return Array.from(new Set(opts));
	}
	return [];
}

function buildExampleInput(schema: z.ZodTypeAny): {
	inputExample: Record<string, unknown> | null;
	fields?: Array<{ name: string; type: string; required: boolean }>;
} {
	const unwrapped = unwrapSchema(schema).schema;
	if (!(unwrapped instanceof z.ZodObject)) return { inputExample: null };

	const shape = getZodObjectShape(unwrapped);
	const fields: Array<{ name: string; type: string; required: boolean }> = [];
	const inputExample: Record<string, unknown> = {};

	for (const [name, fieldSchema] of Object.entries(shape ?? {})) {
		const { schema: base, optional, hasDefault } = unwrapSchema(fieldSchema);
		const required = !optional && !hasDefault;
		const type = getTypeLabel(base);
		fields.push({ name, type, required });

		if (!required) continue;

		if (name.toLowerCase().includes("confirm")) {
			const options = extractLiteralStringOptions(base);
			inputExample[name] = options[0] ?? "<confirm>";
			continue;
		}

		if (type === "string") inputExample[name] = "<string>";
		else if (type === "number") inputExample[name] = 1;
		else if (type === "boolean") inputExample[name] = true;
		else if (type === "date") inputExample[name] = new Date().toISOString();
		else if (type === "enum") {
			const options = extractLiteralStringOptions(base);
			inputExample[name] = options[0] ?? "<value>";
		} else if (type === "array") inputExample[name] = [];
		else if (type === "object") inputExample[name] = {};
		else inputExample[name] = "<value>";
	}

	return { inputExample, fields };
}

async function buildCallerContext(params: {
	organizationId: string;
	userId: string;
}): Promise<{ session: any; user: any }> {
	const membership = await db.query.member.findFirst({
		where: and(
			eq(memberTable.organizationId, params.organizationId),
			eq(memberTable.userId, params.userId),
		),
		with: {
			organization: true,
			user: true,
		},
	});
	if (!membership?.organization || !membership.user) {
		throw new Error("UNAUTHORIZED");
	}

	const u = membership.user;
	return {
		session: {
			userId: u.id,
			activeOrganizationId: params.organizationId,
		},
		user: {
			id: u.id,
			name: u.name,
			email: u.email,
			emailVerified: u.emailVerified,
			image: u.image,
			createdAt: u.createdAt,
			updatedAt: u.updatedAt,
			twoFactorEnabled: u.twoFactorEnabled,
			role: membership.role,
			ownerId: membership.organization.ownerId,
		},
	};
}

function getProcedureType(appRouter: any, procedureName: string): TrpcProcedureType {
	if (appRouter?._def?.queries && procedureName in appRouter._def.queries)
		return "query";
	if (appRouter?._def?.mutations && procedureName in appRouter._def.mutations)
		return "mutation";
	if (
		appRouter?._def?.subscriptions &&
		procedureName in appRouter._def.subscriptions
	)
		return "subscription";
	return "unknown";
}

function listRouters(appRouter: any): TrpcRouterSummary[] {
	const record = (appRouter?._def?.record ?? {}) as Record<string, unknown>;
	const routerNames = Object.keys(record);

	const queries = Object.keys(appRouter?._def?.queries ?? {});
	const mutations = Object.keys(appRouter?._def?.mutations ?? {});
	const subscriptions = Object.keys(appRouter?._def?.subscriptions ?? {});

	const countByPrefix = (keys: string[], prefix: string) => {
		const start = `${prefix}.`;
		let count = 0;
		for (const k of keys) if (k.startsWith(start)) count += 1;
		return count;
	};

	const summaries = routerNames.map((name) => {
		const q = countByPrefix(queries, name);
		const m = countByPrefix(mutations, name);
		const s = countByPrefix(subscriptions, name);
		return { name, total: q + m + s, queries: q, mutations: m, subscriptions: s };
	});

	summaries.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
	return summaries;
}

function searchProcedures(appRouter: any, query: string, limit: number) {
	const q = query.trim().toLowerCase();
	const tokens = q.split(/[\s./_-]+/).filter(Boolean);
	const allNames = Object.keys(appRouter?._def?.procedures ?? {});

	const scored = allNames
		.map((name) => {
			const nameLower = name.toLowerCase();
			let score = 0;
			if (q.length > 0 && nameLower.includes(q)) score += 6;
			for (const t of tokens) if (nameLower.includes(t)) score += 2;
			if (nameLower.startsWith(q)) score += 6;
			return { name, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
		.slice(0, limit);

	return scored.map(({ name }) => ({
		name,
		type: getProcedureType(appRouter, name),
	}));
}

function describeProcedure(appRouter: any, procedureName: string): TrpcProcedureDescription {
	const proc = appRouter?._def?.procedures?.[procedureName];
	if (!proc) {
		throw new Error(`Unknown procedure: ${procedureName}`);
	}

	const type = getProcedureType(appRouter, procedureName);
	const inputs = (proc?._def?.inputs ?? []) as unknown[];
	const input0 = inputs[0] as z.ZodTypeAny | undefined;
	const { inputExample, fields } = input0
		? buildExampleInput(input0)
		: { inputExample: null, fields: undefined };

	return {
		name: procedureName,
		type,
		inputExample,
		...(fields ? { fields } : {}),
	};
}

async function callProcedure(params: {
	appRouter: any;
	procedureName: string;
	input?: unknown;
	ctx: { organizationId: string; userId: string };
}): Promise<unknown> {
	const type = getProcedureType(params.appRouter, params.procedureName);
	const { session, user } = await buildCallerContext(params.ctx);
	const headers = await getCallerHeaders();
	const caller = params.appRouter.createCaller({
		session,
		user,
		db,
		req: { headers },
		res: {},
	});

	const parts = params.procedureName.split(".").filter(Boolean);
	if (parts.length < 2) throw new Error("Invalid procedure name");

	let current: any = caller;
	for (const part of parts.slice(0, -1)) {
		current = current?.[part];
	}
	const fn = current?.[parts.at(-1) as string];
	if (typeof fn !== "function") throw new Error("Procedure not callable");

	const result = await fn(params.input);
	if (type !== "subscription") return result;
	if (!isObservableLike(result)) return result;

	const startedAt = Date.now();
	const events: unknown[] = [];
	let totalChars = 0;
	let truncated = false;
	let truncatedReason: "max_events" | "max_chars" | "timeout" | null = null;

	const output = await new Promise<{
		type: "subscription";
		events: unknown[];
		truncated: boolean;
		truncatedReason?: string;
		durationMs: number;
	}>((resolve, reject) => {
		let finished = false;
		let sub: { unsubscribe: () => void } | null = null;

		const finish = (params: {
			outcome: "completed" | "truncated" | "timeout" | "error";
			error?: unknown;
		}) => {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			try {
				sub?.unsubscribe();
			} catch {}

			const durationMs = Date.now() - startedAt;
			if (params.outcome === "error") {
				const message =
					params.error instanceof Error
						? params.error.message
						: "Subscription failed";
				reject(
					new TrpcBridgeSubscriptionError(message, {
						events,
						cause: params.error,
					}),
				);
				return;
			}

			resolve({
				type: "subscription",
				events,
				truncated,
				...(truncatedReason ? { truncatedReason } : {}),
				durationMs,
			});
		};

		const timer = setTimeout(() => {
			truncated = true;
			truncatedReason = "timeout";
			finish({ outcome: "timeout" });
		}, TRPC_SUBSCRIPTION_TIMEOUT_MS);

		try {
			sub = result.subscribe({
				next(value) {
					if (finished) return;

					if (!truncated) {
						events.push(value);
						if (events.length >= TRPC_SUBSCRIPTION_MAX_EVENTS) {
							truncated = true;
							truncatedReason = "max_events";
							finish({ outcome: "truncated" });
							return;
						}

						if (typeof value === "string") {
							totalChars += value.length;
						} else if (
							typeof value === "number" ||
							typeof value === "boolean" ||
							value == null
						) {
							totalChars += String(value).length;
						} else {
							try {
								totalChars += JSON.stringify(value).length;
							} catch {
								totalChars += 0;
							}
						}

						if (totalChars >= TRPC_SUBSCRIPTION_MAX_CHARS) {
							truncated = true;
							truncatedReason = "max_chars";
							finish({ outcome: "truncated" });
							return;
						}
					}
				},
				error(error) {
					finish({ outcome: "error", error });
				},
				complete() {
					finish({ outcome: "completed" });
				},
			});
		} catch (error) {
			finish({ outcome: "error", error });
		}
	});

	return output;
}

export function registerTrpcBridge(appRouter: any) {
	if (getTrpcBridge()) return;

	const bridge: TrpcBridge = {
		listRouters: () => listRouters(appRouter),
		searchProcedures: (params) =>
			searchProcedures(appRouter, params.query, params.limit),
		describeProcedure: (procedureName) =>
			describeProcedure(appRouter, procedureName),
		callProcedure: (params) =>
			callProcedure({
				appRouter,
				procedureName: params.procedureName,
				input: params.input,
				ctx: params.ctx,
			}),
	};

	setTrpcBridge(bridge);
}
