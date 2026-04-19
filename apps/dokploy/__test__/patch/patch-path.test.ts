import { normalizePatchFilePath } from "@dokploy/server";
import { describe, expect, it } from "vitest";

describe("patch file path normalization", () => {
	it("accepts valid relative paths", () => {
		expect(normalizePatchFilePath("src/index.ts")).toBe("src/index.ts");
		expect(normalizePatchFilePath("./config/.env.example")).toBe(
			"config/.env.example",
		);
		expect(normalizePatchFilePath("nested\\dir\\file.txt")).toBe(
			"nested/dir/file.txt",
		);
	});

	it("rejects escaping paths", () => {
		expect(() => normalizePatchFilePath("../secret.txt")).toThrow();
		expect(() => normalizePatchFilePath("/etc/passwd")).toThrow();
		expect(() => normalizePatchFilePath("..\\evil.txt")).toThrow();
	});
});
