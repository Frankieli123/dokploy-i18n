import { embed } from "ai";
import { createHash } from "node:crypto";
import { selectAIProvider } from "@dokploy/server/utils/ai/select-ai-provider";

export const PLAYBOOK_HASH_DIMENSIONS = 256;
export const PLAYBOOK_DEFAULT_TOP_K = 4;
export const PLAYBOOK_RETENTION_DAYS = 180;

function tokenizeForHashing(text: string): string[] {
	const input = text.trim().toLowerCase();
	if (!input) return [];

	const tokens = input.match(/[\p{L}\p{N}]+|\p{Script=Han}/gu);
	if (!tokens) return [];
	return tokens.filter((t) => t.length > 0);
}

function l2Normalize(values: number[]): number[] {
	let sumSq = 0;
	for (const v of values) sumSq += v * v;
	if (!Number.isFinite(sumSq) || sumSq <= 0) {
		const out = new Array(values.length).fill(0);
		if (out.length > 0) out[0] = 1;
		return out;
	}
	const norm = Math.sqrt(sumSq);
	return values.map((v) => v / norm);
}

export function hashTextToUnitVector(
	text: string,
	dimensions = PLAYBOOK_HASH_DIMENSIONS,
): number[] {
	const dim = Math.max(8, Math.min(4096, Number(dimensions) || PLAYBOOK_HASH_DIMENSIONS));
	const vec = new Array(dim).fill(0);
	const tokens = tokenizeForHashing(text);
	if (tokens.length === 0) {
		vec[0] = 1;
		return vec;
	}

	for (const token of tokens) {
		const digest = createHash("blake2b512").update(token).digest();
		const index = digest.readUInt32LE(0) % dim;
		const sign = (digest.readUInt8(4) & 1) === 1 ? 1 : -1;
		vec[index] += sign;
	}

	return l2Normalize(vec);
}

export type EmbeddingProviderConfig = {
	apiUrl: string;
	apiKey: string;
	providerType?: string | null;
	model: string;
};

export async function tryEmbedText(params: {
	embeddingProvider?: EmbeddingProviderConfig | null;
	text: string;
}): Promise<{ vector: number[]; dim: number; model: string } | null> {
	const embeddingProvider = params.embeddingProvider;
	if (!embeddingProvider) return null;

	const modelId = String(embeddingProvider.model ?? "").trim();
	if (!modelId) return null;

	const provider = selectAIProvider(embeddingProvider) as unknown as Record<
		string,
		unknown
	>;
	const embeddingFactory =
		(provider as { textEmbeddingModel?: unknown }).textEmbeddingModel ??
		(provider as { textEmbedding?: unknown }).textEmbedding ??
		(provider as { embedding?: unknown }).embedding;
	if (typeof embeddingFactory !== "function") return null;

	let embeddingModel: unknown;
	try {
		embeddingModel = (embeddingFactory as (id: string) => unknown)(modelId);
	} catch {
		return null;
	}

	try {
		const res = await embed({
			model: embeddingModel as never,
			value: params.text,
		});
		const raw = (res as unknown as { embedding?: unknown }).embedding;
		if (!Array.isArray(raw)) return null;
		const vector = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
		if (vector.length === 0) return null;
		return { vector: l2Normalize(vector), dim: vector.length, model: modelId };
	} catch {
		return null;
	}
}
