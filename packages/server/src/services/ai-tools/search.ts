import { toolRegistry } from "./registry";

export function tokenizeToolSearchQuery(query: string): string[] {
	const q = query.trim().toLowerCase();
	const tokens: string[] = q.split(/[\s/_.-]+/g).filter(Boolean);

	const add = (...arr: string[]) => {
		for (const t of arr) tokens.push(t);
	};

	// Keep this minimal: the tool catalog is intentionally small (tRPC bridge),
	// but we still want Chinese queries to match English tool names.
	if (/(trpc|t\s*rpc|t-rpc)/i.test(query)) add("trpc");
	if (/(api|接口)/i.test(query)) add("api");
	if (/(router|routers|路由|路由器)/i.test(query)) add("router");
	if (/(procedure|procedures|方法|函数|过程)/i.test(query)) add("procedure");
	if (/(search|搜索|查找)/i.test(query)) add("search");
	if (/(describe|schema|描述|定义|参数|字段|输入)/i.test(query))
		add("describe");
	if (/(call|invoke|execute|run|调用|执行)/i.test(query)) add("call");
	if (
		/(\bsql\b|\bdatabase\b|\bdb\b|\btable\b|\bschema\b|\bddl\b|\bdml\b|\bpostgres\b|\bpostgresql\b|\bmysql\b|\bmariadb\b|\bsqlite\b|\bmongodb\b|\bmongo\b|\bredis\b|数据库|数据表|表|查询|结构)/i.test(
			query,
		)
	) {
		add(
			"sql",
			"database",
			"db",
			"table",
			"schema",
			"ddl",
			"dml",
			"postgres",
			"postgresql",
			"pg",
			"mysql",
			"mariadb",
			"mongo",
			"mongodb",
			"redis",
		);
	}
	if (/(项目|project)/i.test(query)) add("project", "projects");
	if (/(环境|environment|env)/i.test(query)) add("environment");
	if (/(应用|application|app)/i.test(query)) add("application", "app");
	if (/(容器|container|docker)/i.test(query)) add("container", "docker");
	if (/(日志|log|logs)/i.test(query)) add("logs", "log");
	if (/(服务器|主机|server|host)/i.test(query)) add("server");

	return Array.from(new Set(tokens.filter(Boolean)));
}

export function deriveDefaultToolTags(t: {
	name: string;
	category: string;
}): string[] {
	const parts = t.name.split(/[_-]/g).filter(Boolean);
	const isNonEmptyString = (v: unknown): v is string =>
		typeof v === "string" && v.trim().length > 0;
	return Array.from(new Set([t.category, ...parts].filter(isNonEmptyString)));
}

function deriveToolSearchTerms(t: {
	name: string;
	description: string;
	category: string;
	aliases?: string[];
	tags?: string[];
}): string[] {
	const derivedTags = deriveDefaultToolTags({
		name: t.name,
		category: t.category,
	});
	const nameParts = t.name.split(/[_-]/g).filter(Boolean);
	const actionSynonyms: Record<string, string[]> = {
		create: ["create", "add", "new"],
		add: ["create", "add", "new"],
		new: ["create", "add", "new"],
		update: ["update", "edit", "set"],
		edit: ["update", "edit", "set"],
		set: ["update", "edit", "set"],
		delete: ["delete", "remove", "destroy"],
		remove: ["delete", "remove", "destroy"],
		destroy: ["delete", "remove", "destroy"],
		list: ["list", "get", "show", "all"],
		get: ["list", "get", "show", "all"],
		show: ["list", "get", "show", "all"],
		all: ["list", "get", "show", "all"],
		info: ["info", "detail", "inspect"],
		detail: ["info", "detail", "inspect"],
		inspect: ["info", "detail", "inspect"],
	};
	const actionTerms = nameParts.flatMap((p) => actionSynonyms[p] ?? []);
	return Array.from(
		new Set(
			[
				...(t.aliases ?? []),
				...(t.tags ?? []),
				...derivedTags,
				...nameParts,
				...actionTerms,
			].filter(Boolean),
		),
	);
}

export type ToolSearchIndexItem = {
	t: ReturnType<typeof toolRegistry.getAll>[number];
	nameLower: string;
	extraTermsLower: string[];
	hayLower: string;
};

let toolSearchIndexCache:
	| {
			revision: number;
			items: ToolSearchIndexItem[];
	  }
	| undefined;

export function getToolSearchIndex(): ToolSearchIndexItem[] {
	const revision = toolRegistry.getRevision();
	if (toolSearchIndexCache?.revision === revision) {
		return toolSearchIndexCache.items;
	}

	const all = toolRegistry.getAll();
	const items: ToolSearchIndexItem[] = all.map((t) => {
		const extraTerms = deriveToolSearchTerms(t);
		return {
			t,
			nameLower: t.name.toLowerCase(),
			extraTermsLower: extraTerms.map((x) => x.toLowerCase()),
			hayLower:
				`${t.name} ${t.description} ${t.category} ${extraTerms.join(" ")}`.toLowerCase(),
		};
	});

	toolSearchIndexCache = { revision, items };
	return items;
}
