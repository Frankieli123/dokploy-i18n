import { toolRegistry } from "./registry";
import type { Tool } from "./types";

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
	_userMessage: string,
	context: ToolSelectionContext = {},
): Tool[] {
	const minTools = context.minTools ?? 0;
	const maxTools = context.maxTools ?? 12;

	const trpcTools = toolRegistry
		.getAll()
		.filter((t) => t.name.startsWith("trpc_"))
		.sort((a, b) => a.name.localeCompare(b.name));

	const selected = uniqueByName(trpcTools);
	if (selected.length <= maxTools && selected.length >= minTools) return selected;
	return selected.slice(0, Math.max(minTools, maxTools));
}

