import path from "node:path";
import {
	getPublicIpWithFallback,
	isValidSearch,
	isValidSince,
	isValidTail,
	readValidDirectory,
} from "@dokploy/server/wss/utils";
import { publicIpv4, publicIpv6 } from "public-ip";
import { describe, expect, it, vi } from "vitest";

const basePath = path.join(process.cwd(), "__test__", "wss", "sandbox");

vi.mock("@dokploy/server/constants", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		// @ts-ignore
		...actual,
		paths: () => ({
			BASE_PATH: basePath,
		}),
	};
});

vi.mock("public-ip", () => ({
	publicIpv4: vi.fn(),
	publicIpv6: vi.fn(),
}));

describe("wss utils validators", () => {
	it("validates tail safely", () => {
		expect(isValidTail("0")).toBe(true);
		expect(isValidTail("100")).toBe(true);
		expect(isValidTail("10001")).toBe(false);
		expect(isValidTail("-1")).toBe(false);
		expect(isValidTail("1;rm -rf /")).toBe(false);
	});

	it("validates since safely", () => {
		expect(isValidSince("all")).toBe(true);
		expect(isValidSince("5m")).toBe(true);
		expect(isValidSince("24h")).toBe(true);
		expect(isValidSince("2d")).toBe(true);
		expect(isValidSince("1w")).toBe(false);
		expect(isValidSince("1h;rm -rf /")).toBe(false);
	});

	it("validates search safely", () => {
		expect(isValidSearch("error timeout-1 foo.bar_baz")).toBe(true);
		expect(isValidSearch("quoted'value")).toBe(false);
		expect(isValidSearch("$(whoami)")).toBe(false);
		expect(isValidSearch("multi\nline")).toBe(false);
	});
});

describe("readValidDirectory", () => {
	it("allows directories inside base path", () => {
		expect(readValidDirectory(basePath)).toBe(true);
		expect(
			readValidDirectory(path.join(basePath, "applications", "app-1", "code")),
		).toBe(true);
	});

	it("rejects directories outside base path", () => {
		expect(readValidDirectory(path.join(basePath, "..", "escape"))).toBe(false);
	});
});

describe("getPublicIpWithFallback", () => {
	it("returns IPv4 without querying IPv6", async () => {
		vi.mocked(publicIpv4).mockResolvedValueOnce("203.0.113.10");

		await expect(getPublicIpWithFallback()).resolves.toBe("203.0.113.10");
		expect(publicIpv4).toHaveBeenCalledWith({
			onlyHttps: true,
			timeout: 1500,
		});
		expect(publicIpv6).not.toHaveBeenCalled();
	});

	it("falls back to IPv6 with bounded HTTPS requests", async () => {
		vi.mocked(publicIpv4).mockRejectedValueOnce(new Error("IPv4 unavailable"));
		vi.mocked(publicIpv6).mockResolvedValueOnce("2001:db8::10");

		await expect(getPublicIpWithFallback()).resolves.toBe("2001:db8::10");
		expect(publicIpv6).toHaveBeenCalledWith({
			onlyHttps: true,
			timeout: 1500,
		});
	});

	it("returns null when neither address family is available", async () => {
		vi.mocked(publicIpv4).mockRejectedValueOnce(new Error("IPv4 unavailable"));
		vi.mocked(publicIpv6).mockRejectedValueOnce(new Error("IPv6 unavailable"));

		await expect(getPublicIpWithFallback()).resolves.toBeNull();
	});
});
