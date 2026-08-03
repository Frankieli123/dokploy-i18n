import { describe, expect, it, vi } from "vitest";
import {
	LEGACY_BETTER_AUTH_SECRET,
	resolveBetterAuthSecret,
} from "@dokploy/server/lib/auth-secret";

describe("auth secret resolution", () => {
	it("prefers the environment secret", () => {
		const readSecret = vi.fn();
		expect(
			resolveBetterAuthSecret(
				{
					BETTER_AUTH_SECRET: "environment-secret",
					BETTER_AUTH_SECRET_FILE: "/run/secrets/auth",
					NODE_ENV: "production",
				},
				readSecret,
			),
		).toBe("environment-secret");
		expect(readSecret).not.toHaveBeenCalled();
	});

	it("reads a Docker secret file when configured", () => {
		const readSecret = vi.fn(() => "file-secret");
		expect(
			resolveBetterAuthSecret(
				{
					BETTER_AUTH_SECRET_FILE: "/run/secrets/auth",
					NODE_ENV: "production",
				},
				readSecret,
			),
		).toBe("file-secret");
		expect(readSecret).toHaveBeenCalledWith("/run/secrets/auth");
	});

	it("rejects an empty secret file", () => {
		expect(() =>
			resolveBetterAuthSecret(
				{
					BETTER_AUTH_SECRET_FILE: "/run/secrets/auth",
					NODE_ENV: "production",
				},
				() => "",
			),
		).toThrow("Better Auth secret file is empty");
	});

	it("keeps the legacy secret as an upgrade fallback", () => {
		expect(resolveBetterAuthSecret({ NODE_ENV: "test" })).toBe(
			LEGACY_BETTER_AUTH_SECRET,
		);
	});
});
