import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createCohere } from "@ai-sdk/cohere";
import { createDeepInfra } from "@ai-sdk/deepinfra";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { logger } from "@dokploy/server/lib/logger";
import { createOllama } from "ai-sdk-ollama";
import { randomUUID } from "node:crypto";

const LOG_STRING_PREVIEW_CHARS = 240;
const LOG_ARRAY_SAMPLE_SIZE = 4;
const LOG_OBJECT_KEY_LIMIT = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
	return /(authorization|api[-_]?key|token|secret|password|private[-_]?key|certificateData|contentbase64|pem|cookie|set-cookie)/i.test(
		key,
	);
}

function getRequestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return String(input);
	return input.url;
}

function previewString(value: string, maxChars = LOG_STRING_PREVIEW_CHARS): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= maxChars) return compact;
	return `${compact.slice(0, maxChars)}... (${compact.length} chars)`;
}

function redactForLog(
	value: unknown,
	options?: {
		depth?: number;
		key?: string;
	},
): unknown {
	const depth = options?.depth ?? 0;
	const key = options?.key ?? "";

	if (value == null) return value;
	if (depth >= 4) return "[Truncated]";

	if (
		isSensitiveKey(key) ||
		(typeof value === "string" &&
			/^Bearer\s+/i.test(value.trim()) &&
			value.trim().length > 16)
	) {
		return typeof value === "string"
			? `[REDACTED ${value.length} chars]`
			: "[REDACTED]";
	}

	if (typeof value === "string") return previewString(value);
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return value;
	}

	if (Array.isArray(value)) {
		if (value.length <= LOG_ARRAY_SAMPLE_SIZE) {
			return value.map((item) =>
				redactForLog(item, {
					depth: depth + 1,
					key,
				}),
			);
		}
		return {
			count: value.length,
			sample: value.slice(0, LOG_ARRAY_SAMPLE_SIZE).map((item) =>
				redactForLog(item, {
					depth: depth + 1,
					key,
				}),
			),
			truncated: true,
		};
	}

	if (!isRecord(value)) return String(value);

	const out: Record<string, unknown> = {};
	let kept = 0;
	for (const [entryKey, entryValue] of Object.entries(value)) {
		if (kept >= LOG_OBJECT_KEY_LIMIT) {
			out._truncatedKeys = true;
			break;
		}
		out[entryKey] = redactForLog(entryValue, {
			depth: depth + 1,
			key: key ? `${key}.${entryKey}` : entryKey,
		});
		kept++;
	}
	return out;
}

function estimateContentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;

	let total = 0;
	for (const item of content) {
		if (typeof item === "string") {
			total += item.length;
			continue;
		}
		if (!isRecord(item)) continue;
		if (typeof item.text === "string") total += item.text.length;
		if (typeof item.input_text === "string") total += item.input_text.length;
	}
	return total;
}

function extractToolName(value: unknown): string | null {
	if (!isRecord(value)) return null;
	if (typeof value.name === "string" && value.name.trim().length > 0) {
		return value.name.trim();
	}
	const fn = value.function;
	if (isRecord(fn) && typeof fn.name === "string" && fn.name.trim().length > 0) {
		return fn.name.trim();
	}
	return null;
}

function summarizeAssistantToolCall(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return { type: typeof value };

	const fn = isRecord(value.function) ? value.function : value;
	const args = fn.arguments;
	const summary: Record<string, unknown> = {
		name:
			typeof fn.name === "string" && fn.name.trim().length > 0
				? fn.name.trim()
				: "(unknown)",
	};

	if (typeof args === "string") {
		summary.argumentsType = "string";
		summary.argumentsChars = args.length;
		try {
			JSON.parse(args);
			summary.argumentsJson = true;
		} catch {
			summary.argumentsJson = false;
		}
		try {
			summary.argumentsPreview = redactForLog(JSON.parse(args), {
				key: "arguments",
			});
		} catch {
			summary.argumentsPreview = previewString(args);
		}
		return summary;
	}

	summary.argumentsType = typeof args;
	if (typeof args !== "undefined") {
		summary.argumentsPreview = redactForLog(args, { key: "arguments" });
	}
	return summary;
}

function summarizeAiRequest(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload)) return {};

	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	const roleCounts: Record<string, number> = {};
	let lastUserChars = 0;
	let lastAssistantToolCalls: Record<string, unknown>[] = [];

	for (const message of messages) {
		if (!isRecord(message)) continue;
		const role =
			typeof message.role === "string" && message.role.trim().length > 0
				? message.role.trim()
				: "unknown";
		roleCounts[role] = (roleCounts[role] ?? 0) + 1;

		if (role === "user") {
			lastUserChars = estimateContentChars(message.content);
		}
		if (role === "assistant" && Array.isArray(message.tool_calls)) {
			lastAssistantToolCalls = message.tool_calls
				.slice(-3)
				.map((toolCall) => summarizeAssistantToolCall(toolCall));
		}
	}

	return {
		model: typeof payload.model === "string" ? payload.model : undefined,
		stream: typeof payload.stream === "boolean" ? payload.stream : undefined,
		messageCount: messages.length,
		roleCounts,
		lastUserChars,
		toolsCount: tools.length,
		toolNames: tools
			.map((tool) => extractToolName(tool))
			.filter((name): name is string => Boolean(name))
			.slice(0, 10),
		lastAssistantToolCalls,
		toolChoice: redactForLog(payload.tool_choice ?? payload.toolChoice, {
			key: "toolChoice",
		}),
		maxTokens:
			typeof payload.max_tokens === "number"
				? payload.max_tokens
				: typeof payload.max_completion_tokens === "number"
					? payload.max_completion_tokens
					: typeof payload.maxOutputTokens === "number"
						? payload.maxOutputTokens
						: undefined,
	};
}

function summarizeAiResponse(response: Response, durationMs: number) {
	const upstreamRequestId =
		response.headers.get("x-request-id") ??
		response.headers.get("request-id") ??
		response.headers.get("anthropic-request-id") ??
		undefined;

	return {
		ok: response.ok,
		status: response.status,
		statusText: response.statusText || undefined,
		durationMs,
		contentType: response.headers.get("content-type") ?? undefined,
		upstreamRequestId,
	};
}

async function getResponseBodyPreview(response: Response): Promise<unknown> {
	try {
		const text = await response.clone().text();
		if (!text) return undefined;
		try {
			return redactForLog(JSON.parse(text), { key: "responseBody" });
		} catch {
			return previewString(text, 1000);
		}
	} catch {
		return undefined;
	}
}

async function parseJsonRequestBody(body: unknown): Promise<unknown | null> {
	if (typeof body === "string") {
		try {
			return JSON.parse(body) as unknown;
		} catch {
			return null;
		}
	}

	if (body instanceof Uint8Array) {
		try {
			const text = new TextDecoder().decode(body);
			return JSON.parse(text) as unknown;
		} catch {
			return null;
		}
	}

	if (body instanceof ArrayBuffer) {
		try {
			const text = new TextDecoder().decode(new Uint8Array(body));
			return JSON.parse(text) as unknown;
		} catch {
			return null;
		}
	}

	return null;
}

function normalizeOpenAiAssistantToolArguments(payload: unknown): {
	mutated: boolean;
	issues: string[];
} {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { mutated: false, issues: [] };
	}

	const obj = payload as Record<string, unknown>;
	const messages = obj.messages;
	if (!Array.isArray(messages)) return { mutated: false, issues: [] };

	let mutated = false;
	const issues: string[] = [];

	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;

		const msg = message as Record<string, unknown>;
		if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

		for (let toolIndex = 0; toolIndex < msg.tool_calls.length; toolIndex++) {
			const toolCall = msg.tool_calls[toolIndex];
			if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
				continue;
			}

			const fn = (toolCall as Record<string, unknown>).function;
			if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;

			const fnRecord = fn as Record<string, unknown>;
			const toolName =
				typeof fnRecord.name === "string" && fnRecord.name.trim().length > 0
					? fnRecord.name.trim()
					: "(unknown)";
			const args = fnRecord.arguments;

			if (typeof args === "string") {
				try {
					JSON.parse(args);
				} catch {
					issues.push(
						`messages[${messageIndex}].tool_calls[${toolIndex}] ${toolName}: arguments is not valid JSON string`,
					);
				}
				continue;
			}

			if (typeof args === "undefined") {
				issues.push(
					`messages[${messageIndex}].tool_calls[${toolIndex}] ${toolName}: arguments is missing`,
				);
				continue;
			}

			try {
				fnRecord.arguments = JSON.stringify(args);
				mutated = true;
			} catch {
				issues.push(
					`messages[${messageIndex}].tool_calls[${toolIndex}] ${toolName}: arguments is not serializable`,
				);
			}
		}
	}

	return { mutated, issues };
}

function createValidatedJsonFetch(
	baseFetch: typeof fetch,
	options: {
		providerName: string;
		debugEnabled?: boolean;
		transform?: (payload: unknown) => void;
	},
): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		const requestId = randomUUID();
		const startedAt = Date.now();
		const body = init?.body;
		if (!body) return baseFetch(input, init);

		const parsed = await parseJsonRequestBody(body);
		if (parsed == null) return baseFetch(input, init);
		const requestSummary = summarizeAiRequest(parsed);
		const url = getRequestUrl(input);
		const requestMeta = {
			requestId,
			provider: options.providerName,
			method: init?.method ?? "POST",
			url,
			request: requestSummary,
		};

		if (options.debugEnabled) {
			logger.info(requestMeta, "[AI] request");
		}

		const { mutated, issues } = normalizeOpenAiAssistantToolArguments(parsed);
		if (issues.length > 0) {
			logger.error(
				{
					...requestMeta,
					issues,
				},
				"[AI] invalid outbound assistant tool arguments",
			);
			throw new Error(`Invalid outbound assistant tool arguments: ${issues[0]}`);
		}

		options.transform?.(parsed);
		const nextInit =
			!mutated && !options.transform
				? init
				: {
						...init,
						body: JSON.stringify(parsed),
					};

		try {
			const response = await baseFetch(input, nextInit);
			const responseMeta = summarizeAiResponse(response, Date.now() - startedAt);

			if (!response.ok) {
				logger.error(
					{
						...requestMeta,
						response: responseMeta,
						responseBodyPreview: await getResponseBodyPreview(response),
					},
					"[AI] upstream error response",
				);
			} else if (options.debugEnabled) {
				logger.info(
					{
						requestId,
						provider: options.providerName,
						method: init?.method ?? "POST",
						url,
						response: responseMeta,
					},
					"[AI] response",
				);
			}

			return response;
		} catch (error) {
			logger.error(
				{
					...requestMeta,
					durationMs: Date.now() - startedAt,
					error:
						error instanceof Error
							? {
									name: error.name,
									message: error.message,
								}
							: String(error),
				},
				"[AI] request failed",
			);
			throw error;
		}
	};
}

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

export function normalizeGeminiRequestPayload(payload: unknown): void {
	fixGeminiFunctionCallArgs(payload);
	stripGeminiToolSchemaAdditionalProperties(payload);
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
	if ("$schema" in obj) {
		delete obj.$schema;
	}
	for (const key of Object.keys(obj)) {
		stripAdditionalPropertiesFromSchema(obj[key]);
	}
}

function stripGeminiToolSchemaAdditionalProperties(payload: unknown): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const obj = payload as Record<string, unknown>;

	if (
		"generationConfig" in obj &&
		typeof obj.generationConfig === "object" &&
		obj.generationConfig &&
		!Array.isArray(obj.generationConfig)
	) {
		const genConfig = obj.generationConfig as Record<string, unknown>;
		if ("responseSchema" in genConfig) {
			stripAdditionalPropertiesFromSchema(genConfig.responseSchema);
		}
	}

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
	options?: {
		debugEnabled?: boolean;
	},
): typeof fetch {
	return createValidatedJsonFetch(baseFetch, {
		providerName: "gemini",
		debugEnabled: options?.debugEnabled,
		transform: normalizeGeminiRequestPayload,
	});
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
	options?: {
		debugEnabled?: boolean;
	},
): typeof fetch {
	return createValidatedJsonFetch(baseFetch, {
		providerName: "deepseek",
		debugEnabled: options?.debugEnabled,
		transform: fixDeepSeekReasoningContent,
	});
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
	requestDebugLogs?: boolean | null;
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
				fetch: createValidatedJsonFetch(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
					providerName: "openai",
				}),
			});
		case "azure":
			if (normalizedApiUrl.includes("/v1")) {
				return createOpenAICompatible({
					name: "azure",
					baseURL: normalizedApiUrl,
					headers: {
						"api-key": config.apiKey,
						Authorization: `Bearer ${config.apiKey}`,
					},
					fetch: createValidatedJsonFetch(globalThis.fetch, {
						debugEnabled: config.requestDebugLogs === true,
						providerName: "azure",
					}),
				});
			}
			return createAzure({
				apiKey: config.apiKey,
				baseURL: normalizedApiUrl,
				fetch: createValidatedJsonFetch(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
					providerName: "azure",
				}),
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
				fetch: createValidatedJsonFetch(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
					providerName: "cohere",
				}),
			});
		case "perplexity":
			return createOpenAICompatible({
				name: "perplexity",
				baseURL: normalizedApiUrl,
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
				fetch: createValidatedJsonFetch(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
					providerName: "perplexity",
				}),
			});
		case "mistral":
			return createMistral({
				baseURL: normalizedApiUrl,
				apiKey: config.apiKey,
				fetch: createValidatedJsonFetch(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
					providerName: "mistral",
				}),
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
				fetch: createValidatedJsonFetch(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
					providerName: "deepinfra",
				}),
			});
		case "deepseek":
			return createOpenAICompatible({
				name: "deepseek",
				baseURL: normalizedApiUrl,
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
				fetch: createDeepSeekFetchWithReasoningNormalization(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
				}),
			});
		case "gemini":
			return createGoogleGenerativeAI({
				apiKey: config.apiKey,
				baseURL: normalizedApiUrl,
				fetch: createGeminiFetchWithArgsNormalization(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
				}),
			});
		case "openai_compatible":
		case "custom":
			return createOpenAICompatible({
				name: "custom",
				baseURL: normalizedApiUrl,
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
				},
				fetch: createValidatedJsonFetch(globalThis.fetch, {
					debugEnabled: config.requestDebugLogs === true,
					providerName: "openai_compatible",
				}),
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
