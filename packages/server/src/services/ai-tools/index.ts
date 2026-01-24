export * from "./categories";
export * from "./registry";
export * from "./types";

import { registerTrpcTools } from "./tools/trpc";

let toolsInitialized = false;

export function initializeTools() {
	if (toolsInitialized) return;

	registerTrpcTools();

	toolsInitialized = true;
}
