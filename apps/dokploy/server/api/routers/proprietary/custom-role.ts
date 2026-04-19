import { member, organizationRole } from "@dokploy/server/db/schema";
import { statements } from "@dokploy/server/lib/access-control";
import { TRPCError } from "@trpc/server";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { db } from "@/server/db";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../../trpc";

const INTERNAL_RESOURCES = ["organization", "invitation", "team", "ac"];
const permissionsSchema = z.record(z.string(), z.array(z.string()));

export const customRoleRouter = createTRPCRouter({
	all: protectedProcedure.query(async ({ ctx }) => {
		const [roles, memberCounts] = await Promise.all([
			db.query.organizationRole.findMany({
				where: eq(
					organizationRole.organizationId,
					ctx.session.activeOrganizationId,
				),
			}),
			db
				.select({ role: member.role, count: count() })
				.from(member)
				.where(eq(member.organizationId, ctx.session.activeOrganizationId))
				.groupBy(member.role),
		]);

		const memberCountByRole = new Map(
			memberCounts.map((row) => [row.role, row.count]),
		);
		const roleMap = new Map<
			string,
			{
				role: string;
				permissions: Record<string, string[]>;
				createdAt: Date;
				memberCount: number;
			}
		>();

		for (const entry of roles) {
			const parsed = JSON.parse(entry.permission) as Record<string, string[]>;
			const current = roleMap.get(entry.role);
			if (current) {
				for (const [resource, actions] of Object.entries(parsed)) {
					current.permissions[resource] = Array.from(
						new Set([...(current.permissions[resource] ?? []), ...actions]),
					);
				}
				continue;
			}

			roleMap.set(entry.role, {
				role: entry.role,
				permissions: parsed,
				createdAt: entry.createdAt,
				memberCount: memberCountByRole.get(entry.role) ?? 0,
			});
		}

		return Array.from(roleMap.values()).sort((left, right) =>
			left.role.localeCompare(right.role),
		);
	}),
	create: adminProcedure
		.input(
			z.object({
				roleName: z
					.string()
					.min(1)
					.max(50)
					.refine(
						(name) => !["owner", "admin", "member"].includes(name),
						"Cannot use reserved role names",
					),
				permissions: permissionsSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const existingRoles = await db.query.organizationRole.findMany({
				where: eq(
					organizationRole.organizationId,
					ctx.session.activeOrganizationId,
				),
			});

			const uniqueRoleNames = new Set(existingRoles.map((row) => row.role));
			if (uniqueRoleNames.size >= 10) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Maximum of 10 custom roles per organization reached",
				});
			}
			if (uniqueRoleNames.has(input.roleName)) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `Role "${input.roleName}" already exists`,
				});
			}

			validatePermissions(input.permissions);

			const [created] = await db
				.insert(organizationRole)
				.values({
					organizationId: ctx.session.activeOrganizationId,
					role: input.roleName,
					permission: JSON.stringify(input.permissions),
				})
				.returning();

			await audit(ctx, {
				action: "create",
				resourceType: "organization",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: input.roleName,
				metadata: { type: "custom-role" },
			});

			return created;
		}),
	update: adminProcedure
		.input(
			z.object({
				roleName: z.string().min(1),
				newRoleName: z
					.string()
					.min(1)
					.max(50)
					.refine(
						(name) => !["owner", "admin", "member"].includes(name),
						"Cannot use reserved role names",
					)
					.optional(),
				permissions: permissionsSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (["owner", "admin", "member"].includes(input.roleName)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Cannot modify built-in roles",
				});
			}

			if (input.newRoleName && input.newRoleName !== input.roleName) {
				const existing = await db.query.organizationRole.findFirst({
					where: and(
						eq(
							organizationRole.organizationId,
							ctx.session.activeOrganizationId,
						),
						eq(organizationRole.role, input.newRoleName),
					),
				});

				if (existing) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `Role "${input.newRoleName}" already exists`,
					});
				}

				await db
					.update(member)
					.set({ role: input.newRoleName })
					.where(
						and(
							eq(member.organizationId, ctx.session.activeOrganizationId),
							eq(member.role, input.roleName),
						),
					);
			}

			validatePermissions(input.permissions);
			const effectiveRoleName = input.newRoleName ?? input.roleName;

			const [updated] = await db
				.update(organizationRole)
				.set({
					role: effectiveRoleName,
					permission: JSON.stringify(input.permissions),
				})
				.where(
					and(
						eq(
							organizationRole.organizationId,
							ctx.session.activeOrganizationId,
						),
						eq(organizationRole.role, input.roleName),
					),
				)
				.returning();

			await audit(ctx, {
				action: "update",
				resourceType: "organization",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: effectiveRoleName,
				metadata: { type: "custom-role" },
			});

			return updated;
		}),
	remove: adminProcedure
		.input(
			z.object({
				roleName: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (["owner", "admin", "member"].includes(input.roleName)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Cannot delete built-in roles",
				});
			}

			const assignedMembers = await db.query.member.findMany({
				where: and(
					eq(member.organizationId, ctx.session.activeOrganizationId),
					eq(member.role, input.roleName),
				),
			});

			if (assignedMembers.length > 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Cannot delete role "${input.roleName}" while members are assigned`,
				});
			}

			const deleted = await db
				.delete(organizationRole)
				.where(
					and(
						eq(
							organizationRole.organizationId,
							ctx.session.activeOrganizationId,
						),
						eq(organizationRole.role, input.roleName),
					),
				)
				.returning();

			if (deleted.length === 0) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: `Role "${input.roleName}" not found`,
				});
			}

			await audit(ctx, {
				action: "delete",
				resourceType: "organization",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: input.roleName,
				metadata: { type: "custom-role" },
			});

			return { deleted: deleted.length };
		}),
	membersByRole: protectedProcedure
		.input(z.object({ roleName: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			return db.query.member.findMany({
				where: and(
					eq(member.organizationId, ctx.session.activeOrganizationId),
					eq(member.role, input.roleName),
				),
				with: {
					user: true,
				},
			});
		}),
	getStatements: protectedProcedure.query(() => statements),
});

function validatePermissions(permissions: Record<string, string[]>) {
	for (const [resource, actions] of Object.entries(permissions)) {
		if (INTERNAL_RESOURCES.includes(resource)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Resource "${resource}" is managed internally`,
			});
		}

		if (!(resource in statements)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Unknown resource: ${resource}`,
			});
		}

		const validActions = statements[resource as keyof typeof statements];
		for (const action of actions) {
			if (!validActions.includes(action as never)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Invalid action "${action}" for resource "${resource}"`,
				});
			}
		}
	}
}
