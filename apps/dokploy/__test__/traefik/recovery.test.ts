import { db } from "@dokploy/server/db";
import {
	ensureTraefik,
	reloadTraefik,
	writeTraefikSetup,
} from "@dokploy/server/services/settings";
import * as traefikSetup from "@dokploy/server/setup/traefik-setup";
import * as execProcess from "@dokploy/server/utils/process/execAsync";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			compose: {
				findMany: vi.fn(),
			},
		},
	},
}));

vi.mock("@dokploy/server/setup/traefik-setup", () => ({
	initializeStandaloneTraefik: vi.fn(),
	initializeTraefikService: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
	execAsyncRemote: vi.fn(),
}));

describe("Traefik recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(db.query.compose.findMany).mockResolvedValue([]);
		vi.mocked(traefikSetup.initializeStandaloneTraefik).mockResolvedValue();
		vi.mocked(traefikSetup.initializeTraefikService).mockResolvedValue();
	});

	it("creates standalone Traefik when the resource is missing", async () => {
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "unknown\n",
			stderr: "",
		});

		await expect(ensureTraefik()).resolves.toBe(true);

		expect(traefikSetup.initializeStandaloneTraefik).toHaveBeenCalledWith({});
		expect(traefikSetup.initializeTraefikService).not.toHaveBeenCalled();
	});

	it("uses standalone setup as the fallback for missing resources", async () => {
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "unknown\n",
			stderr: "",
		});

		await writeTraefikSetup({
			env: ["TEST=value"],
			additionalPorts: [
				{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
			],
		});

		expect(traefikSetup.initializeStandaloneTraefik).toHaveBeenCalledWith({
			env: ["TEST=value"],
			additionalPorts: [
				{ targetPort: 8080, publishedPort: 8080, protocol: "tcp" },
			],
			serverId: undefined,
		});
	});

	it("reloads an existing Traefik resource without recreating it", async () => {
		vi.mocked(execProcess.execAsync).mockResolvedValue({
			stdout: "service\n",
			stderr: "",
		});

		await reloadTraefik();

		expect(traefikSetup.initializeStandaloneTraefik).not.toHaveBeenCalled();
		expect(execProcess.execAsync).toHaveBeenLastCalledWith(
			expect.stringContaining("docker service update --force dokploy-traefik"),
		);
	});

	it("does not treat Docker execution failures as a missing resource", async () => {
		vi.mocked(execProcess.execAsync).mockRejectedValue(
			new Error("Docker unavailable"),
		);

		await expect(ensureTraefik()).rejects.toThrow("Docker unavailable");
		expect(traefikSetup.initializeStandaloneTraefik).not.toHaveBeenCalled();
	});
});
