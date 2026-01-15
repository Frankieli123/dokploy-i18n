import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { findGithubById } from "@dokploy/server/services/github";

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(),
}));

vi.mock("octokit", () => ({
	Octokit: class {
		constructor(_options?: any) {}
		auth = vi.fn().mockRejectedValue(new Error("network error"));
	},
}));

describe("cloneGithubRepository - token fetch failure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("falls back to unauthenticated clone when token fetch fails", async () => {
		vi.mocked(findGithubById).mockResolvedValue({
			githubMirrorPrefixUrl: null,
			githubMirrorForwardAuth: false,
			githubApiProxyUrl: null,
			githubAppId: 1,
			githubPrivateKey: "key",
			githubInstallationId: "1",
		} as any);

		const command = await cloneGithubRepository({
			appName: "test-app",
			owner: "owner",
			repository: "repo",
			branch: "main",
			githubId: "github-id",
			enableSubmodules: false,
			serverId: null,
		});

		expect(command).toContain("https://github.com/owner/repo.git");
		expect(command).not.toContain("http.extraheader");
	});
});

