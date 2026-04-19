import fs from "node:fs/promises";
import path from "node:path";
import type { ApplicationNested } from "@dokploy/server";
import { unzipDrop } from "@dokploy/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		// @ts-ignore
		...actual,
		paths: () => ({
			BASE_PATH: "./__test__/drop/zips/output-security",
			APPLICATIONS_PATH: "./__test__/drop/zips/output-security",
		}),
	};
});

if (typeof globalThis.File === "undefined") {
	const undici = require("undici");
	globalThis.File = undici.File as any;
	globalThis.FileList = undici.FileList as any;
}

const baseApp = {
	appName: "drop-security",
	serverId: "",
} as ApplicationNested;

describe("unzipDrop security", () => {
	beforeAll(async () => {
		await fs.rm("./__test__/drop/zips/output-security", {
			recursive: true,
			force: true,
		});
	});

	afterAll(async () => {
		await fs.rm("./__test__/drop/zips/output-security", {
			recursive: true,
			force: true,
		});
	});

	it("rejects zip entries that escape the output directory", async () => {
		const zipBuffer = await fs.readFile(
			path.join(process.cwd(), "__test__", "drop", "zips", "path-traversal.zip"),
		);
		const file = new File([zipBuffer], "traversal.zip");

		await expect(unzipDrop(file, baseApp)).rejects.toThrow(
			/Path traversal detected/,
		);
	});
});
