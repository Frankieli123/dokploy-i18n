import { initializeStandaloneTraefik } from "@dokploy/server/setup/traefik-setup";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(),
}));

const originalHostEtcDir = process.env.DOKPLOY_HOST_ETC_DIR;

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	if (originalHostEtcDir === undefined) {
		delete process.env.DOKPLOY_HOST_ETC_DIR;
	} else {
		process.env.DOKPLOY_HOST_ETC_DIR = originalHostEtcDir;
	}
});

it("propagates Traefik container startup failures", async () => {
	const startupError = new Error("Port binding failed");
	const createContainer = vi.fn().mockRejectedValue(startupError);
	const removeContainer = vi
		.fn()
		.mockRejectedValue(new Error("Container not found"));
	vi.mocked(getRemoteDocker).mockResolvedValue({
		pull: vi.fn().mockRejectedValue(new Error("Use cached image")),
		getContainer: vi.fn(() => ({
			remove: removeContainer,
			start: vi.fn(),
		})),
		createContainer,
	} as never);
	process.env.DOKPLOY_HOST_ETC_DIR = "/data/dokploy";

	await expect(initializeStandaloneTraefik()).rejects.toBe(startupError);
	expect(createContainer).toHaveBeenCalledWith(
		expect.objectContaining({
			HostConfig: expect.objectContaining({
				Binds: expect.arrayContaining([
					"/data/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml",
					"/data/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic",
				]),
			}),
		}),
	);
	expect(removeContainer).toHaveBeenCalledTimes(2);
});
