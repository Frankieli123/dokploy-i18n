import { initializeStandaloneTraefik } from "@dokploy/server/setup/traefik-setup";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

it("propagates Traefik container startup failures", async () => {
	const startupError = new Error("Port binding failed");
	const removeContainer = vi
		.fn()
		.mockRejectedValue(new Error("Container not found"));
	vi.mocked(getRemoteDocker).mockResolvedValue({
		pull: vi.fn().mockRejectedValue(new Error("Use cached image")),
		getContainer: vi.fn(() => ({
			remove: removeContainer,
			start: vi.fn(),
		})),
		createContainer: vi.fn().mockRejectedValue(startupError),
	} as never);

	await expect(initializeStandaloneTraefik()).rejects.toBe(startupError);
	expect(removeContainer).toHaveBeenCalledTimes(2);
});
