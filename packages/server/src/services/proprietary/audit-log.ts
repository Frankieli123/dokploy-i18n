import { db } from "@dokploy/server/db";
import { auditLog } from "@dokploy/server/db/schema";
import type { AuditAction, AuditResourceType } from "@dokploy/server/db/schema";

export type { AuditAction, AuditResourceType };

export interface CreateAuditLogInput {
	organizationId: string;
	userId: string;
	userEmail: string;
	userRole: string;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

export const createAuditLog = async (input: CreateAuditLogInput) => {
	try {
		await db.insert(auditLog).values({
			organizationId: input.organizationId,
			userId: input.userId,
			userEmail: input.userEmail,
			userRole: input.userRole,
			action: input.action,
			resourceType: input.resourceType,
			resourceId: input.resourceId,
			resourceName: input.resourceName,
			metadata: input.metadata ? JSON.stringify(input.metadata) : undefined,
		});
	} catch (err) {
		console.error("[audit-log] Failed to create audit log entry:", err);
	}
};
