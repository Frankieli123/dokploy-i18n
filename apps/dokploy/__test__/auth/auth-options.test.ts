import {
	getAuthCookieOptions,
	resolveSelfHostedServerIp,
} from "@dokploy/server/lib/auth-options";
import { describe, expect, it, vi } from "vitest";

describe("getAuthCookieOptions", () => {
	it("allows the self-hosted HTTP bootstrap flow", () => {
		expect(getAuthCookieOptions(false)).toEqual({
			advanced: {
				useSecureCookies: false,
				defaultCookieAttributes: {
					sameSite: "lax",
					secure: false,
					httpOnly: true,
					path: "/",
				},
			},
		});
	});

	it("keeps Better Auth defaults in cloud mode", () => {
		expect(getAuthCookieOptions(true)).toEqual({});
	});
});

describe("resolveSelfHostedServerIp", () => {
	it("reuses the configured server IP without an external lookup", async () => {
		const lookupPublicIp = vi.fn();

		await expect(
			resolveSelfHostedServerIp("203.0.113.20", lookupPublicIp),
		).resolves.toBe("203.0.113.20");
		expect(lookupPublicIp).not.toHaveBeenCalled();
	});

	it("uses the bounded lookup when no server IP is configured", async () => {
		const lookupPublicIp = vi.fn().mockResolvedValue("203.0.113.21");

		await expect(resolveSelfHostedServerIp(null, lookupPublicIp)).resolves.toBe(
			"203.0.113.21",
		);
		expect(lookupPublicIp).toHaveBeenCalledOnce();
	});
});
