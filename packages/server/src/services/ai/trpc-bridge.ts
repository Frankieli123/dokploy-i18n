export type TrpcProcedureType = "query" | "mutation" | "subscription" | "unknown";

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

export function setTrpcBridge(bridge: TrpcBridge | null) {
	trpcBridge = bridge;
}

export function getTrpcBridge(): TrpcBridge | null {
	return trpcBridge;
}
