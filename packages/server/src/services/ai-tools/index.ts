export * from "./categories";
export * from "./registry";
export * from "./types";

import { registerContainerTools } from "./tools/container";
import { registerInventoryTools } from "./tools/inventory";
import { registerMcpTools } from "./tools/mcp";
import { registerServerFileTools } from "./tools/server-files";
import { registerSqlTools } from "./tools/sql";
import { registerTrpcTools } from "./tools/trpc";

let toolsInitialized = false;

export function initializeTools() {
	if (toolsInitialized) return;

	registerTrpcTools();
	registerInventoryTools();
	registerMcpTools();
	registerServerFileTools();
	registerSqlTools();
	registerContainerTools();

	toolsInitialized = true;
}
