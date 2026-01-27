import { toolRegistry } from "./registry";
import type { Tool } from "./types";
import { getToolSearchIndex, tokenizeToolSearchQuery } from "./search";

export type ToolSelectionContext = {
	projectId?: string;
	serverId?: string;
	minTools?: number;
	maxTools?: number;
};

function uniqueByName(tools: Tool[]): Tool[] {
	const seen = new Set<string>();
	const out: Tool[] = [];
	for (const t of tools) {
		if (seen.has(t.name)) continue;
		seen.add(t.name);
		out.push(t);
	}
	return out;
}

export function selectRelevantTools(
	userMessage: string,
	context: ToolSelectionContext = {},
): Tool[] {
	const minTools = context.minTools ?? 0;
	const maxTools = context.maxTools ?? 12;

	const isDestructive = (name: string) =>
		/(delete|remove|destroy|purge|uninstall|reset|rotate|revoke|restore)/i.test(
			name,
		);

	const all = toolRegistry.getAll();
	const desired = Math.max(minTools, maxTools);
	if (all.length === 0 || desired <= 0) return [];

	const coreToolNames = [
		"projects_inventory",
		"trpc_procedure_search",
		"trpc_procedure_describe",
		"trpc_procedure_call",
	];

	const coreTools = coreToolNames
		.map((name) => toolRegistry.get(name))
		.filter((t): t is Tool => !!t);

	const tokens = tokenizeToolSearchQuery(userMessage);
	const tokensLower = tokens.map((t) => t.toLowerCase());

	const scored: Array<{ t: Tool; score: number }> = [];
	const index = getToolSearchIndex();
	for (const x of index) {
		let score = 0;
		for (const tTok of tokensLower) {
			if (x.nameLower.includes(tTok)) score += 6;
			if (x.extraTermsLower.some((term) => term.includes(tTok))) score += 5;
			if (x.hayLower.includes(tTok)) score += 3;
		}
		if (x.t.riskLevel === "low") score += 1;
		if (score > 0) scored.push({ t: x.t, score });
	}
	scored.sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));

	const fallback = () => {
		const safe = all
			.filter((t) => t.riskLevel === "low" && !t.requiresApproval)
			.sort((a, b) => a.name.localeCompare(b.name));
		const writeCapable = all
			.filter((t) => t.requiresApproval || t.riskLevel !== "low")
			.filter((t) => !isDestructive(t.name))
			.sort((a, b) => a.name.localeCompare(b.name));
		return safe.concat(writeCapable);
	};

	const picked =
		scored.length > 0 ? scored.map((x) => x.t) : fallback();

	const selected = uniqueByName([...coreTools, ...picked]);
	return selected.slice(0, desired);
}
