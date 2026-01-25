export * from "./categories";
export * from "./registry";
export * from "./types";

import { registerTrpcTools } from "./tools/trpc";
import { registerInventoryTools } from "./tools/inventory";

let toolsInitialized = false;

export function initializeTools() {
	if (toolsInitialized) return;

	registerTrpcTools();
	registerInventoryTools();

	toolsInitialized = true;
}
