import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama } from "ai-sdk-ollama";

export function getProviderName(apiUrl: string) {
	if (apiUrl.includes("api.openai.com")) return "openai";
	if (apiUrl.includes("azure.com")) return "azure";
	if (apiUrl.includes("api.anthropic.com")) return "anthropic";
	if (apiUrl.includes("api.cohere.ai")) return "cohere";
	if (apiUrl.includes("api.perplexity.ai")) return "perplexity";
	if (apiUrl.includes("api.mistral.ai")) return "mistral";
	if (apiUrl.includes(":11434") || apiUrl.includes("ollama")) return "ollama";
	if (apiUrl.includes("api.deepinfra.com")) return "deepinfra";
	if (apiUrl.includes("api.deepseek.com")) return "deepseek";
	if (apiUrl.includes("generativelanguage.googleapis.com")) return "gemini";
	return "custom";
}

function normalizeGeminiApiUrl(url: string): string {
	const trimmed = stripTrailingSlashes(url);
	return trimmed.replace(/\/v1beta\/v1$/, "/v1beta");
}

function normalizeDeepSeekApiUrl(url: string): string {
	const trimmed = stripTrailingSlashes(url);
	return trimmed.replace(/\/beta\/v1$/, "/beta").replace(/\/v1\/v1$/, "/v1");
}

function stripTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function ensureSuffix(url: string, suffix: string): string {
	const base = stripTrailingSlashes(url);
	if (base.endsWith(suffix)) return base;
	return `${base}${suffix}`;
}

function stripOpenAiEndpointPath(url: string): string {
	// Users sometimes paste full endpoints (e.g. /v1/chat/completions). We need a base URL.
	const trimmed = stripTrailingSlashes(url);
	return trimmed
		.replace(/\/chat\/completions$/i, "")
		.replace(/\/completions$/i, "");
}

function stripGeminiEndpointPath(url: string): string {
	// Users sometimes paste a concrete endpoint instead of the API base.
	// Expected base for Gemini provider is typically: <host>/v1beta
	let trimmed = stripTrailingSlashes(url);
	trimmed = stripOpenAiEndpointPath(trimmed);
	trimmed = trimmed
		.replace(/\/(v1beta|v1)\/models$/i, "/$1")
		.replace(/\/(v1beta|v1)\/models\/[^/]+(?::[a-zA-Z]+)?$/i, "/$1");
	return trimmed;
}

function fixGeminiFunctionCallArgs(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) fixGeminiFunctionCallArgs(item);
		return;
	}

	const obj = value as Record<string, unknown>;
	const functionCall = obj.function_call ?? obj.functionCall;
	if (
		functionCall &&
		typeof functionCall === "object" &&
		!Array.isArray(functionCall)
	) {
		const fc = functionCall as Record<string, unknown>;
		const args = fc.args ?? fc.arguments;
		if (typeof args === "string") {
			const trimmed = args.trim();
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
				try {
					fc.args = JSON.parse(trimmed);
					if ("arguments" in fc) {
						fc.arguments = fc.args;
					}
				} catch {}
			}
		}
	}

	for (const key of Object.keys(obj)) {
		fixGeminiFunctionCallArgs(obj[key]);
	}
}

function stripAdditionalPropertiesFromSchema(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) stripAdditionalPropertiesFromSchema(item);
		return;
	}

	const obj = value as Record<string, unknown>;
	if ("additionalProperties" in obj) {
		delete obj.additionalProperties;
	}
	for (const key of Object.keys(obj)) {
		stripAdditionalPropertiesFromSchema(obj[key]);
	}
}

function stripGeminiToolSchemaAdditionalProperties(payload: unknown): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const obj = payload as Record<string, unknown>;
	const tools = obj.tools;
	if (!Array.isArray(tools)) return;

	for (const tool of tools) {
		if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
		const toolObj = tool as Record<string, unknown>;
		const decls = toolObj.function_declarations ?? toolObj.functionDeclarations;
		if (!Array.isArray(decls)) continue;
		for (const decl of decls) {
			if (!decl || typeof decl !== "object" || Array.isArray(decl)) continue;
			const declObj = decl as Record<string, unknown>;
			if ("parameters" in declObj) {
				stripAdditionalPropertiesFromSchema(declObj.parameters);
			}
		}
	}
}

function createGeminiFetchWithArgsNormalization(
	baseFetch: typeof fetch,
): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.body && typeof init.body === "string") {
			try {
				const parsed = JSON.parse(init.body) as unknown;
				fixGeminiFunctionCallArgs(parsed);
				stripGeminiToolSchemaAdditionalProperties(parsed);
				return baseFetch(input, { ...init, body: JSON.stringify(parsed) });
			} catch {}
		}
		return baseFetch(input, init);
	};
}

function fixDeepSeekReasoningContent(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) fixDeepSeekReasoningContent(item);
		return;
	}

	const obj = value as Record<string, unknown>;
	const messages = obj.messages;
	if (Array.isArray(messages)) {
		for (const msg of messages) {
			if (!msg || typeof msg !== "object" || Array.isArray(msg)) continue;
			const m = msg as Record<string, unknown>;
			if (m.role === "assistant" && !("reasoning_content" in m)) {
				m.reasoning_content = null;
			}
		}
	}

	for (const key of Object.keys(obj)) {
		fixDeepSeekReasoningContent(obj[key]);
	}
}

function createDeepSeekFetchWithReasoningNormalization(
	baseFetch: typeof fetch,
): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.body && typeof init.body === "string") {
			try {
				const parsed = JSON.parse(init.body) as unknown;
				fixDeepSeekReasoningContent(parsed);
				return baseFetch(input, { ...init, body: JSON.stringify(parsed) });
			} catch {}
		}
		return baseFetch(input, init);
	};
}

export function normalizeAiApiUrl(config: {
	apiUrl: string;
	providerType?: string | null;
}): string {
	const raw = (config.apiUrl ?? "").trim();
	if (raw.length === 0) return raw;

	const providerType = config.providerType ?? "openai_compatible";
	let url = stripTrailingSlashes(raw);

	if (providerType === "gemini") {
		url = stripGeminiEndpointPath(url);
		url = normalizeGeminiApiUrl(url);
		// Canonicalize to /v1beta for Gemini, even if a user mistakenly pasted an OpenAI-style /v1 URL.
		url = url.replace(/\/v1$/, "");
		if (url.endsWith("/v1beta")) return url;
		return ensureSuffix(url, "/v1beta");
	}

	if (providerType === "deepseek") {
		url = normalizeDeepSeekApiUrl(url);
		if (url.endsWith("/v1") || url.endsWith("/beta")) return url;
		return ensureSuffix(url, "/v1");
	}

	if (providerType === "anthropic") {
		url = url.replace(/\/v1\/v1$/, "/v1");
		if (url.endsWith("/v1")) return url;
		return ensureSuffix(url, "/v1");
	}

	if (providerType === "mistral") {
		url = url.replace(/\/v1\/v1$/, "/v1");
		if (url.endsWith("/v1")) return url;
		return ensureSuffix(url, "/v1");
	}

	if (providerType === "deepinfra") {
		url = url.replace(/\/v1\/v1$/, "/v1");
		if (url.endsWith("/v1")) return url;
		return ensureSuffix(url, "/v1");
	}

	if (providerType === "cohere") {
		url = url.replace(/\/v2\/v2$/, "/v2");
		if (url.endsWith("/v2")) return url;
		return ensureSuffix(url, "/v2");
	}

	if (providerType === "openai" || providerType === "openai_compatible") {
		// OpenAI compatible servers normally expose the API under /v1.
		// Some compatible providers may use alternative prefixes like /beta; preserve them if explicitly provided.
		url = stripOpenAiEndpointPath(url);
		url = url.replace(/\/v1beta\/v1$/, "").replace(/\/v1beta$/, "");
		url = url.replace(/\/v1\/v1$/, "/v1");
		if (url.endsWith("/v1") || url.endsWith("/beta")) return url;
		return ensureSuffix(url, "/v1");
	}

	return url;
}

function resolveProviderName(config: {
	apiUrl: string;
	providerType?: string | null;
}): string {
	const providerType = config.providerType;
	if (!providerType) return "openai_compatible";
	if (
		providerType === "openai" ||
		providerType === "azure" ||
		providerType === "anthropic" ||
		providerType === "cohere" ||
		providerType === "perplexity" ||
		providerType === "mistral" ||
		providerType === "ollama" ||
		providerType === "deepinfra" ||
		providerType === "deepseek" ||
		providerType === "gemini" ||
		providerType === "openai_compatible" ||
		providerType === "custom"
	) {
		return providerType;
	}
	return "openai_compatible";
}

export function selectAIProvider(config: {
	apiUrl: string;
	apiKey: string;
	providerType?: string | null;
}) {
	const detectedProvider = getProviderName(config.apiUrl);
	const providerName = config.providerType
		? resolveProviderName(config)
		: detectedProvider === "custom"
			? "openai_compatible"
			: detectedProvider;
	const normalizedApiUrl = normalizeAiApiUrl({
		apiUrl: config.apiUrl,
		providerType: providerName,
	});

	switch (providerName) {
		case "openai":
			return createOpenAI({
				apiKey: config.apiKey,
				baseURL: normalizedApiUrl,
			});
		case "azure":
			return createAzure({
				apiKey: config.apiKey,
				baseURL: normalizedApiUrl,
			});
		case "anthropic":
			return createAnthropic({
				apiKey: config.apiKey,
				baseURL: normalizedApiUrl,
			});
		case "cohere":
			return createCohere({
				baseURL: normalizedApiUrl,
				apiKey: config.apiKey,
			});
		case "perplexity":
			return createOpenAICompatible({
				name: "perplexity",
				baseURL: normalizedApiUrl,
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
			});
		case "mistral":
			return createMistral({
				baseURL: normalizedApiUrl,
				apiKey: config.apiKey,
			});
		case "ollama":
			return createOllama({
				// optional settings, e.g.
				baseURL: normalizedApiUrl,
			});
		case "deepinfra":
			return createDeepInfra({
				baseURL: normalizedApiUrl,
				apiKey: config.apiKey,
			});
		case "deepseek":
			return createOpenAICompatible({
				name: "deepseek",
				baseURL: normalizedApiUrl,
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
				fetch: createDeepSeekFetchWithReasoningNormalization(globalThis.fetch),
			});
		case "gemini":
			return createGoogleGenerativeAI({
				apiKey: config.apiKey,
				baseURL: normalizedApiUrl,
				fetch: createGeminiFetchWithArgsNormalization(globalThis.fetch),
			});
		case "openai_compatible":
		case "custom":
			return createOpenAICompatible({
				name: "custom",
				baseURL: normalizedApiUrl,
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
			});
		default:
			throw new Error(`Unsupported AI provider: ${providerName}`);
	}
}

export const getProviderHeaders = (
	apiUrl: string,
	apiKey: string,
	providerType?: string | null,
): Record<string, string> => {
	const providerName = resolveProviderName({ apiUrl, providerType });

	// Anthropic
	if (providerName === "anthropic" || apiUrl.includes("anthropic")) {
		return {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
		};
	}

	// Mistral
	if (providerName === "mistral" || apiUrl.includes("mistral")) {
		return {
			Authorization: apiKey,
		};
	}

	// Default (OpenAI style)
	return {
		Authorization: `Bearer ${apiKey}`,
	};
};
export interface Model {
	id: string;
	object: string;
	created: number;
	owned_by: string;
}
