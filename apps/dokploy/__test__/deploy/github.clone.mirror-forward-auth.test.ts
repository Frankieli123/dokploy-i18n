import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { findGithubById } from "@dokploy/server/services/github";

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(),
}));

vi.mock("octokit", () => ({
	Octokit: class {
		constructor(_options?: any) {}
		auth = vi.fn().mockResolvedValue({ token: "ghs_test_token" });
	},
}));

describe("cloneGithubRepository - mirror prefix + forward auth", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("clones via mirror prefix without auth when forwardAuth is disabled", async () => {
		vi.mocked(findGithubById).mockResolvedValue({
			githubMirrorPrefixUrl: "https://git.lvli.de",
			githubMirrorForwardAuth: false,
			githubApiProxyUrl: null,
			githubAppId: 1,
			githubPrivateKey: "key",
			githubInstallationId: "1",
		} as any);

		const command = await cloneGithubRepository({
			appName: "test-app",
			owner: "Frankieli123",
			repository: "zhanwen",
			branch: "main",
			githubId: "github-id",
			enableSubmodules: false,
			serverId: null,
		});

		expect(command).toContain(
			"https://git.lvli.de/https://github.com/Frankieli123/zhanwen.git",
		);
		expect(command).not.toContain("http.extraheader");
		expect(command).not.toContain("oauth2:");
	});

	it("adds auth header for mirror prefix and falls back to direct clone", async () => {
		vi.mocked(findGithubById).mockResolvedValue({
			githubMirrorPrefixUrl: "https://git.lvli.de",
			githubMirrorForwardAuth: true,
			githubApiProxyUrl: null,
			githubAppId: 1,
			githubPrivateKey: "key",
			githubInstallationId: "1",
		} as any);

		const command = await cloneGithubRepository({
			appName: "test-app",
			owner: "Frankieli123",
			repository: "zhanwen",
			branch: "main",
			githubId: "github-id",
			enableSubmodules: false,
			serverId: null,
		});

		expect(command).toContain("Authorization: Basic");
		expect(command).toContain(
			"https://git.lvli.de/https://github.com/Frankieli123/zhanwen.git",
		);
		expect(command).toContain("Mirror clone failed, falling back to direct clone");
		expect(command).toContain("https://github.com/Frankieli123/zhanwen.git");
		expect(command).not.toContain("oauth2:");
	});
});

