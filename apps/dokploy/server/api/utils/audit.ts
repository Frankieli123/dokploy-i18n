import type { AuditAction, AuditResourceType } from "@dokploy/server/db/schema";
import { createAuditLog } from "@dokploy/server/services/proprietary/audit-log";

interface AuditCtx {
	user: { id: string; email?: string | null; role: string };
	session: { activeOrganizationId: string };
}

interface AuditEvent {
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

export const audit = (ctx: AuditCtx, event: AuditEvent) =>
	createAuditLog({
		organizationId: ctx.session.activeOrganizationId,
		userId: ctx.user.id,
		userEmail: ctx.user.email ?? "",
		userRole: ctx.user.role,
		...event,
	});
