export * from "./categories";
export * from "./registry";
export * from "./types";

import { registerTrpcTools } from "./tools/trpc";
import { registerInventoryTools } from "./tools/inventory";
import { registerMcpTools } from "./tools/mcp";
import { registerServerFileTools } from "./tools/server-files";

let toolsInitialized = false;

export function initializeTools() {
	if (toolsInitialized) return;

	registerTrpcTools();
	registerInventoryTools();
	registerMcpTools();
	registerServerFileTools();

	toolsInitialized = true;
}
