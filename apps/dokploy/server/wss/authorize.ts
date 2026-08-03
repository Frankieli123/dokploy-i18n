import { findServerById } from "@dokploy/server";
import {
	findMemberByUserId,
	hasPermission,
} from "@dokploy/server/services/permission";
import { checkServiceAccess } from "@dokploy/server/services/user";

type WssUser = { id: string } | null | undefined;
type WssSession = { activeOrganizationId?: string | null } | null | undefined;

const buildCtx = (user: { id: string }, activeOrganizationId: string) => ({
	user: { id: user.id },
	session: { activeOrganizationId },
});

const belongsToOrganization = async (
	serverId: string | null | undefined,
	organizationId: string,
) => {
	if (!serverId || serverId === "local") return true;
	try {
		const server = await findServerById(serverId);
		return server.organizationId === organizationId;
	} catch {
		return false;
	}
};

export const canAccessDockerOverWss = async (
	user: WssUser,
	session: WssSession,
	serverId?: string | null,
	serviceId?: string | null,
) => {
	if (!user || !session?.activeOrganizationId) return false;

	if (serviceId) {
		try {
			await checkServiceAccess(
				user.id,
				serviceId,
				session.activeOrganizationId,
				"access",
			);
			return await belongsToOrganization(
				serverId,
				session.activeOrganizationId,
			);
		} catch {
			return false;
		}
	}

	const ctx = buildCtx(user, session.activeOrganizationId);
	if (!(await hasPermission(ctx, { docker: ["read"] }))) return false;
	return await belongsToOrganization(serverId, session.activeOrganizationId);
};

export const canAccessTerminalOverWss = async (
	user: WssUser,
	session: WssSession,
	serverId?: string | null,
) => {
	if (!user || !session?.activeOrganizationId) return false;

	if (!serverId || serverId === "local") {
		try {
			const member = await findMemberByUserId(
				user.id,
				session.activeOrganizationId,
			);
			return member.role === "owner" || member.role === "admin";
		} catch {
			return false;
		}
	}

	const ctx = buildCtx(user, session.activeOrganizationId);
	if (!(await hasPermission(ctx, { server: ["read"] }))) return false;
	return await belongsToOrganization(serverId, session.activeOrganizationId);
};
