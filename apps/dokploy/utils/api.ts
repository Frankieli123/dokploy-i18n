/**
 * This is the client-side entrypoint for your tRPC API. It is used to create the `api` object which
 * contains the Next.js App-wrapper, as well as your type-safe React Query hooks.
 *
 * We also create a few inference helpers for input and output types.
 */

import {
	createWSClient,
	httpBatchLink,
	httpLink,
	splitLink,
	wsLink,
} from "@trpc/client";
import { createTRPCNext } from "@trpc/next";
import superjson from "superjson";

const getBaseUrl = () => {
	if (typeof window !== "undefined") return "";
	return `http://localhost:${process.env.PORT ?? 3000}`;
};

const getWsUrl = () => {
	if (typeof window === "undefined") return null;

	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const host = window.location.host;

	return `${protocol}${host}/drawer-logs`;
};

let wsClientSingleton: ReturnType<typeof createWSClient> | null = null;

const getOrCreateWSClient = () => {
	if (typeof window === "undefined") return null;

	if (!wsClientSingleton) {
		wsClientSingleton = createWSClient({
			url: getWsUrl()!,
			lazy: { enabled: true, closeMs: 3000 },
			retryDelayMs: () => 3000,
		});
	}

	return wsClientSingleton;
};

const wsClient = getOrCreateWSClient();

const links =
	typeof window !== "undefined"
		? [
				splitLink({
					condition: (op) => op.type === "subscription",
					true: wsLink({
						client: wsClient!,
						transformer: superjson,
					}),
					false: splitLink({
						condition: (op) => op.input instanceof FormData,
						true: httpLink({
							url: `${getBaseUrl()}/api/trpc`,
							transformer: superjson,
						}),
						false: httpBatchLink({
							url: `${getBaseUrl()}/api/trpc`,
							transformer: superjson,
						}),
					}),
				}),
			]
		: [
				httpBatchLink({
					url: `${getBaseUrl()}/api/trpc`,
					transformer: superjson,
				}),
			];

const trpcApi = createTRPCNext<any>({
	config() {
		return { links };
	},
	ssr: false,
	transformer: superjson,
});

export const api: any = trpcApi;

export type RouterInputs = Record<string, any>;
export type RouterOutputs = Record<string, any>;
