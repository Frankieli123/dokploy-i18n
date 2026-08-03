import { findServerById } from "@dokploy/server";
import {
	findMemberByUserId,
	hasPermission,
} from "@dokploy/server/services/permission";
import { checkServiceAccess } from "@dokploy/server/services/user";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	canAccessDockerOverWss,
	canAccessTerminalOverWss,
} from "../../server/wss/authorize";

vi.mock("@dokploy/server", () => ({
	findServerById: vi.fn(),
}));

vi.mock("@dokploy/server/services/permission", () => ({
	findMemberByUserId: vi.fn(),
	hasPermission: vi.fn(),
}));

vi.mock("@dokploy/server/services/user", () => ({
	checkServiceAccess: vi.fn(),
}));

const user = { id: "user-1" };
const session = { activeOrganizationId: "org-1" };

describe("WebSocket authorization", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("allows Docker access for an assigned service", async () => {
		vi.mocked(checkServiceAccess).mockResolvedValue(undefined);

		await expect(
			canAccessDockerOverWss(user, session, null, "service-1"),
		).resolves.toBe(true);
		expect(checkServiceAccess).toHaveBeenCalledWith(
			"user-1",
			"service-1",
			"org-1",
			"access",
		);
	});

	it("rejects Docker access when the service is not assigned", async () => {
		vi.mocked(checkServiceAccess).mockRejectedValue(new Error("denied"));

		await expect(
			canAccessDockerOverWss(user, session, null, "service-1"),
		).resolves.toBe(false);
	});

	it("requires Docker permission when no service is supplied", async () => {
		vi.mocked(hasPermission).mockResolvedValue(false);

		await expect(canAccessDockerOverWss(user, session)).resolves.toBe(false);
		expect(hasPermission).toHaveBeenCalledWith(
			{
				user: { id: "user-1" },
				session: { activeOrganizationId: "org-1" },
			},
			{ docker: ["read"] },
		);
	});

	it("rejects Docker access to a server from another organization", async () => {
		vi.mocked(hasPermission).mockResolvedValue(true);
		vi.mocked(findServerById).mockResolvedValue({
			organizationId: "org-2",
		} as Awaited<ReturnType<typeof findServerById>>);

		await expect(
			canAccessDockerOverWss(user, session, "server-1"),
		).resolves.toBe(false);
	});

	it("limits local host terminal access to owners and admins", async () => {
		vi.mocked(findMemberByUserId).mockResolvedValue({
			role: "member",
		} as Awaited<ReturnType<typeof findMemberByUserId>>);

		await expect(canAccessTerminalOverWss(user, session)).resolves.toBe(false);

		vi.mocked(findMemberByUserId).mockResolvedValue({
			role: "admin",
		} as Awaited<ReturnType<typeof findMemberByUserId>>);

		await expect(canAccessTerminalOverWss(user, session)).resolves.toBe(true);
	});

	it("requires permission and organization ownership for remote terminals", async () => {
		vi.mocked(hasPermission).mockResolvedValue(true);
		vi.mocked(findServerById).mockResolvedValue({
			organizationId: "org-1",
		} as Awaited<ReturnType<typeof findServerById>>);

		await expect(
			canAccessTerminalOverWss(user, session, "server-1"),
		).resolves.toBe(true);

		vi.mocked(findServerById).mockResolvedValue({
			organizationId: "org-2",
		} as Awaited<ReturnType<typeof findServerById>>);

		await expect(
			canAccessTerminalOverWss(user, session, "server-1"),
		).resolves.toBe(false);
	});
});
