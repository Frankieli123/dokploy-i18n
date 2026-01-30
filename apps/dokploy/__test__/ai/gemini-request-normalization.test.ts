import { normalizeGeminiRequestPayload } from "@dokploy/server/utils/ai/select-ai-provider";
import { describe, expect, it } from "vitest";

function hasAdditionalPropertiesKey(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasAdditionalPropertiesKey);
	if ("additionalProperties" in (value as Record<string, unknown>)) return true;
	return Object.values(value as Record<string, unknown>).some(hasAdditionalPropertiesKey);
}

function hasSchemaKey(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasSchemaKey);
	if ("$schema" in (value as Record<string, unknown>)) return true;
	return Object.values(value as Record<string, unknown>).some(hasSchemaKey);
}

describe("Gemini request payload normalization", () => {
	it("strips additionalProperties from tool schemas", () => {
		const payload: any = {
			tools: [
				{
					functionDeclarations: [
						{
							name: "tool_a",
							parameters: {
								$schema: "http://json-schema.org/draft-07/schema#",
								type: "object",
								additionalProperties: false,
								properties: {
									input: {
										type: "object",
										additionalProperties: {
											type: "string",
											additionalProperties: false,
										},
									},
								},
							},
						},
					],
				},
			],
		};

		expect(hasAdditionalPropertiesKey(payload)).toBe(true);
		expect(hasSchemaKey(payload)).toBe(true);
		normalizeGeminiRequestPayload(payload);
		expect(hasAdditionalPropertiesKey(payload)).toBe(false);
		expect(hasSchemaKey(payload)).toBe(false);
	});

	it("strips schema keys from responseSchema", () => {
		const payload: any = {
			generationConfig: {
				responseSchema: {
					$schema: "http://json-schema.org/draft-07/schema#",
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
					},
				},
			},
		};

		expect(hasAdditionalPropertiesKey(payload)).toBe(true);
		expect(hasSchemaKey(payload)).toBe(true);
		normalizeGeminiRequestPayload(payload);
		expect(hasAdditionalPropertiesKey(payload)).toBe(false);
		expect(hasSchemaKey(payload)).toBe(false);
	});

	it("parses stringified tool call args", () => {
		const payload: any = {
			contents: [
				{
					role: "model",
					parts: [
						{
							functionCall: {
								name: "tool_a",
								args: "{\"hello\":\"world\"}",
							},
						},
					],
				},
			],
		};

		normalizeGeminiRequestPayload(payload);
		expect(payload.contents[0].parts[0].functionCall.args).toEqual({
			hello: "world",
		});
	});
});
