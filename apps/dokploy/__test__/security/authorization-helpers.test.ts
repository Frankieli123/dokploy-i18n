import { assertGitProviderAccess } from "@dokploy/server/services/git-provider";
import { redactServerSshKey } from "@dokploy/server/services/server";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({ db: {} }));

describe("authorization helpers", () => {
	it("requires a Git provider to match both organization and user", () => {
		const session = { userId: "user-1", activeOrganizationId: "org-1" };

		expect(() =>
			assertGitProviderAccess(session, {
				organizationId: "org-1",
				userId: "user-1",
			}),
		).not.toThrow();

		for (const provider of [
			{ organizationId: "org-2", userId: "user-1" },
			{ organizationId: "org-1", userId: "user-2" },
		]) {
			try {
				assertGitProviderAccess(session, provider);
				throw new Error("Expected authorization to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(TRPCError);
				expect((error as TRPCError).code).toBe("UNAUTHORIZED");
			}
		}
	});

	it("removes SSH private keys without mutating the original server", () => {
		const server = {
			serverId: "server-1",
			sshKey: { sshKeyId: "key-1", privateKey: "secret" },
		};

		const result = redactServerSshKey(server);

		expect(result).not.toBe(server);
		expect(result.sshKey.privateKey).toBe("");
		expect(result.sshKey.sshKeyId).toBe("key-1");
		expect(server.sshKey.privateKey).toBe("secret");
	});
});
