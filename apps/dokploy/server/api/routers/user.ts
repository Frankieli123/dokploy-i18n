import {
	createApiKey,
	findNotificationById,
	findOrganizationById,
	findUserById,
	getDokployUrl,
	getInvitationEmailContent,
	getUserByToken,
	getWebServerSettings,
	IS_CLOUD,
	removeUserById,
	sendEmailNotification,
	updateUser,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	account,
	apiAssignPermissions,
	apiFindOneToken,
	apikey,
	organizationRole,
	apiUpdateUser,
	invitation,
	member,
} from "@dokploy/server/db/schema";
import {
	hasPermission,
	resolvePermissions,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import * as bcrypt from "bcrypt";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
	withPermission,
} from "../trpc";
import { statements } from "@dokploy/server/lib/access-control";

const apiCreateApiKey = z.object({
	name: z.string().min(1),
	prefix: z.string().optional(),
	expiresIn: z.number().optional(),
	metadata: z.object({
		organizationId: z.string(),
	}),
	// Rate limiting
	rateLimitEnabled: z.boolean().optional(),
	rateLimitTimeWindow: z.number().optional(),
	rateLimitMax: z.number().optional(),
	// Request limiting
	remaining: z.number().optional(),
	refillAmount: z.number().optional(),
	refillInterval: z.number().optional(),
});

const staticRoles = new Set(["owner", "admin", "member"]);

const customRoleSchema = z.object({
	role: z
		.string()
		.min(1)
		.regex(/^[a-zA-Z0-9:_-]+$/),
	permissions: z.record(z.string(), z.array(z.string())),
});

type Resource = keyof typeof statements;

const normalizeRolePermissions = (permissions: Record<string, string[]>) => {
	const normalized: Partial<Record<Resource, string[]>> = {};

	for (const [resource, actions] of Object.entries(permissions)) {
		if (!(resource in statements)) continue;
		const allowedActions = statements[resource as Resource] as readonly string[];
		const validActions = Array.from(
			new Set(actions.filter((action) => allowedActions.includes(action))),
		);
		if (validActions.length > 0) {
			normalized[resource as Resource] = validActions;
		}
	}

	return normalized;
};

const mergeRolePermissions = (
	rows: Array<{ role: string; permission: string; createdAt: Date }>,
) => {
	const grouped = new Map<
		string,
		{ role: string; permissions: Record<string, string[]>; createdAt: Date }
	>();

	for (const row of rows) {
		let parsed: Record<string, string[]>;
		try {
			parsed = JSON.parse(row.permission) as Record<string, string[]>;
		} catch {
			continue;
		}

		const current = grouped.get(row.role) ?? {
			role: row.role,
			permissions: {},
			createdAt: row.createdAt,
		};

		for (const [resource, actions] of Object.entries(parsed)) {
			current.permissions[resource] = Array.from(
				new Set([...(current.permissions[resource] ?? []), ...actions]),
			);
		}

		grouped.set(row.role, current);
	}

	return Array.from(grouped.values()).sort((left, right) =>
		left.role.localeCompare(right.role),
	);
};

export const userRouter = createTRPCRouter({
	all: adminProcedure.query(async ({ ctx }) => {
		return await db.query.member.findMany({
			where: eq(member.organizationId, ctx.session.activeOrganizationId),
			with: {
				user: true,
			},
			orderBy: [asc(member.createdAt)],
		});
	}),
	session: publicProcedure.query(async ({ ctx }) => {
		if (!ctx.user || !ctx.session || !ctx.session.activeOrganizationId) {
			return null;
		}
		return {
			user: {
				id: ctx.user.id,
			},
			session: {
				activeOrganizationId: ctx.session.activeOrganizationId,
			},
		};
	}),
	one: protectedProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const memberResult = await db.query.member.findFirst({
				where: and(
					eq(member.userId, input.userId),
					eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
				),
				with: {
					user: true,
				},
			});

			// If user not found in the organization, deny access
			if (!memberResult) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "User not found in this organization",
				});
			}

			// Allow access if:
			// 1. User is requesting their own information
			// 2. User has owner role (admin permissions) AND user is in the same organization
			if (memberResult.userId !== ctx.user.id && ctx.user.role !== "owner") {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this user",
				});
			}

			return memberResult;
		}),
	get: protectedProcedure.query(async ({ ctx }) => {
		const memberResult = await db.query.member.findFirst({
			where: and(
				eq(member.userId, ctx.user.id),
				eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
			),
			with: {
				user: {
					with: {
						apiKeys: true,
					},
				},
			},
		});

		return memberResult;
	}),
	getPermissions: protectedProcedure.query(async ({ ctx }) => {
		return resolvePermissions(ctx);
	}),
	listCustomRoles: adminProcedure.query(async ({ ctx }) => {
		const roles = await db.query.organizationRole.findMany({
			where: eq(organizationRole.organizationId, ctx.session.activeOrganizationId),
			columns: {
				role: true,
				permission: true,
				createdAt: true,
			},
			orderBy: [asc(organizationRole.createdAt)],
		});

		return mergeRolePermissions(
			roles as Array<{ role: string; permission: string; createdAt: Date }>,
		);
	}),
	listAssignableRoles: adminProcedure.query(async ({ ctx }) => {
		const customRoles = await db.query.organizationRole.findMany({
			where: eq(organizationRole.organizationId, ctx.session.activeOrganizationId),
			columns: {
				role: true,
			},
			orderBy: [asc(organizationRole.role)],
		});

		return Array.from(
			new Set(["admin", "member", ...customRoles.map((role) => role.role)]),
		);
	}),
	membersByRole: adminProcedure
		.input(z.object({ role: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			return db.query.member.findMany({
				where: and(
					eq(member.organizationId, ctx.session.activeOrganizationId),
					eq(member.role, input.role),
				),
				with: {
					user: true,
				},
			});
		}),
	permissionCatalog: adminProcedure.query(() => statements),
	upsertCustomRole: adminProcedure
		.input(customRoleSchema)
		.mutation(async ({ input, ctx }) => {
			if (staticRoles.has(input.role)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Built-in roles cannot be modified",
				});
			}

			const organizationResult = await findOrganizationById(
				ctx.session.activeOrganizationId,
			);
			if (organizationResult?.ownerId !== ctx.user.ownerId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to manage custom roles",
				});
			}

			const normalized = normalizeRolePermissions(input.permissions);
			if (Object.keys(normalized).length === 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "At least one valid permission is required",
				});
			}

			await db
				.delete(organizationRole)
				.where(
					and(
						eq(organizationRole.organizationId, ctx.session.activeOrganizationId),
						eq(organizationRole.role, input.role),
					),
				);

			await db.insert(organizationRole).values({
				organizationId: ctx.session.activeOrganizationId,
				role: input.role,
				permission: JSON.stringify(normalized),
			});

			await audit(ctx, {
				action: "update",
				resourceType: "organization",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: input.role,
				metadata: { type: "organization-role", permissions: normalized },
			});

			return { success: true };
		}),
	deleteCustomRole: adminProcedure
		.input(z.object({ role: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			if (staticRoles.has(input.role)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Built-in roles cannot be deleted",
				});
			}

			const organizationResult = await findOrganizationById(
				ctx.session.activeOrganizationId,
			);
			if (organizationResult?.ownerId !== ctx.user.ownerId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to delete custom roles",
				});
			}

			const assignedMembers = await db.query.member.findMany({
				where: and(
					eq(member.organizationId, ctx.session.activeOrganizationId),
					eq(member.role, input.role),
				),
				columns: { id: true },
			});

			if (assignedMembers.length > 0) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This role is still assigned to users",
				});
			}

			await db
				.delete(organizationRole)
				.where(
					and(
						eq(organizationRole.organizationId, ctx.session.activeOrganizationId),
						eq(organizationRole.role, input.role),
					),
				);

			await audit(ctx, {
				action: "delete",
				resourceType: "organization",
				resourceId: ctx.session.activeOrganizationId,
				resourceName: input.role,
				metadata: { type: "organization-role" },
			});

			return { success: true };
		}),
	haveRootAccess: protectedProcedure.query(async ({ ctx }) => {
		if (!IS_CLOUD) {
			return false;
		}
		if (
			process.env.USER_ADMIN_ID === ctx.user.id ||
			ctx.session?.impersonatedBy === process.env.USER_ADMIN_ID
		) {
			return true;
		}
		return false;
	}),
	getBackups: adminProcedure.query(async ({ ctx }) => {
		const memberResult = await db.query.member.findFirst({
			where: and(
				eq(member.userId, ctx.user.id),
				eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
			),
			with: {
				user: {
					with: {
						backups: {
							with: {
								destination: true,
								deployments: true,
							},
						},
						apiKeys: true,
					},
				},
			},
		});

		return memberResult?.user;
	}),
	getServerMetrics: protectedProcedure.query(async ({ ctx }) => {
		const memberResult = await db.query.member.findFirst({
			where: and(
				eq(member.userId, ctx.user.id),
				eq(member.organizationId, ctx.session?.activeOrganizationId || ""),
			),
			with: {
				user: true,
			},
		});

		return memberResult?.user;
	}),
	update: protectedProcedure
		.input(apiUpdateUser)
		.mutation(async ({ input, ctx }) => {
			if (input.password || input.currentPassword) {
				const currentAuth = await db.query.account.findFirst({
					where: eq(account.userId, ctx.user.id),
				});
				const correctPassword = bcrypt.compareSync(
					input.currentPassword || "",
					currentAuth?.password || "",
				);

				if (!correctPassword) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Current password is incorrect",
					});
				}

				if (!input.password) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "New password is required",
					});
				}
				await db
					.update(account)
					.set({
						password: bcrypt.hashSync(input.password, 10),
					})
					.where(eq(account.userId, ctx.user.id));
			}

			try {
				const result = await updateUser(ctx.user.id, input);
				await audit(ctx, {
					action: "update",
					resourceType: "user",
					resourceId: ctx.user.id,
					resourceName: ctx.user.email,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error ? error.message : "Failed to update user",
				});
			}
		}),
	getUserByToken: publicProcedure
		.input(apiFindOneToken)
		.query(async ({ input }) => {
			return await getUserByToken(input.token);
		}),
	getMetricsToken: protectedProcedure.query(async ({ ctx }) => {
		const user = await findUserById(ctx.user.ownerId);
		const webServerSettings = await getWebServerSettings().catch(() => null);
		return {
			serverIp: webServerSettings?.serverIp ?? user.serverIp,
			enabledFeatures: user.enablePaidFeatures,
			metricsConfig: webServerSettings?.metricsConfig ?? user?.metricsConfig,
		};
	}),
	remove: protectedProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return true;
			}
			const result = await removeUserById(input.userId);
			await audit(ctx, {
				action: "delete",
				resourceType: "user",
				resourceId: input.userId,
			});
			return result;
		}),
	assignPermissions: adminProcedure
		.input(apiAssignPermissions)
		.mutation(async ({ input, ctx }) => {
			try {
				const organization = await findOrganizationById(
					ctx.session?.activeOrganizationId || "",
				);

				if (organization?.ownerId !== ctx.user.ownerId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to assign permissions",
					});
				}

				const { id, role, ...rest } = input;
				const nextRole = role ?? "member";

				if (
					!staticRoles.has(nextRole) &&
					!(await db.query.organizationRole.findFirst({
						where: and(
							eq(organizationRole.organizationId, ctx.session.activeOrganizationId),
							eq(organizationRole.role, nextRole),
						),
						columns: { id: true },
					}))
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Selected custom role does not exist",
					});
				}

				await db
					.update(member)
					.set({
						role: nextRole,
						...rest,
					})
					.where(
						and(
							eq(member.userId, input.id),
							eq(
								member.organizationId,
								ctx.session?.activeOrganizationId || "",
							),
						),
					);
				await audit(ctx, {
					action: "update",
					resourceType: "user",
					resourceId: input.id,
					metadata: { role: nextRole, permissions: rest },
				});
			} catch (error) {
				throw error;
			}
		}),
	getInvitations: protectedProcedure.query(async ({ ctx }) => {
		return await db.query.invitation.findMany({
			where: and(
				eq(invitation.email, ctx.user.email),
				gt(invitation.expiresAt, new Date()),
				eq(invitation.status, "pending"),
			),
			with: {
				organization: true,
			},
		});
	}),

	getContainerMetrics: protectedProcedure
		.input(
			z.object({
				url: z.string(),
				token: z.string(),
				appName: z.string(),
				dataPoints: z.string(),
			}),
		)
		.query(async ({ input }) => {
			try {
				if (!input.appName) {
					throw new Error(
						[
							"No Application Selected:",
							"",
							"Make Sure to select an application to monitor.",
						].join("\n"),
					);
				}
				const url = new URL(`${input.url}/metrics/containers`);
				url.searchParams.append("limit", input.dataPoints);
				url.searchParams.append("appName", input.appName);
				const response = await fetch(url.toString(), {
					headers: {
						Authorization: `Bearer ${input.token}`,
					},
				});
				if (!response.ok) {
					throw new Error(
						`Error ${response.status}: ${response.statusText}. Please verify that the application "${input.appName}" is running and this service is included in the monitoring configuration.`,
					);
				}

				const data = await response.json();
				if (!Array.isArray(data) || data.length === 0) {
					throw new Error(
						[
							`No monitoring data available for "${input.appName}". This could be because:`,
							"",
							"1. The container was recently started - wait a few minutes for data to be collected",
							"2. The container is not running - verify its status",
							"3. The service is not included in your monitoring configuration",
						].join("\n"),
					);
				}
				return data as {
					containerId: string;
					containerName: string;
					containerImage: string;
					containerLabels: string;
					containerCommand: string;
					containerCreated: string;
				}[];
			} catch (error) {
				throw error;
			}
		}),

	generateToken: protectedProcedure.mutation(async () => {
		return "token";
	}),

	deleteApiKey: protectedProcedure
		.input(
			z.object({
				apiKeyId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				const apiKeyToDelete = await db.query.apikey.findFirst({
					where: eq(apikey.id, input.apiKeyId),
				});

				if (!apiKeyToDelete) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "API key not found",
					});
				}

				if (apiKeyToDelete.referenceId !== ctx.user.id) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to delete this API key",
					});
				}

				await db.delete(apikey).where(eq(apikey.id, input.apiKeyId));
				await audit(ctx, {
					action: "delete",
					resourceType: "user",
					resourceId: input.apiKeyId,
					resourceName: apiKeyToDelete.name || undefined,
				});
				return true;
			} catch (error) {
				throw error;
			}
		}),

	createApiKey: protectedProcedure
		.input(apiCreateApiKey)
		.mutation(async ({ input, ctx }) => {
			if (input.metadata?.organizationId) {
				const userMember = await db.query.member.findFirst({
					where: and(
						eq(member.organizationId, input.metadata.organizationId),
						eq(member.userId, ctx.user.id),
					),
				});

				if (!userMember) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "You are not a member of this organization",
					});
				}
			}
			const apiKey = await createApiKey(ctx.user.id, input);
			await audit(ctx, {
				action: "create",
				resourceType: "user",
				resourceId: apiKey.id,
				resourceName: input.name,
			});
			return apiKey;
		}),

	checkUserOrganizations: protectedProcedure
		.input(
			z.object({
				userId: z.string(),
			}),
		)
		.query(async ({ input }) => {
			const organizations = await db.query.member.findMany({
				where: eq(member.userId, input.userId),
			});

			return organizations.length;
		}),
	sendInvitation: adminProcedure
		.input(
			z.object({
				invitationId: z.string().min(1),
				notificationId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				return;
			}

			const notification = await findNotificationById(input.notificationId);

			const email = notification.email;

			const currentInvitation = await db.query.invitation.findFirst({
				where: eq(invitation.id, input.invitationId),
			});

			if (!email) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Email notification not found",
				});
			}

			const host =
				process.env.NODE_ENV === "development"
					? "http://localhost:3000"
					: await getDokployUrl();
			const inviteLink = `${host}/invitation?token=${input.invitationId}`;

			const organization = await findOrganizationById(
				ctx.session.activeOrganizationId,
			);

			try {
				const { subject, html } = getInvitationEmailContent({
					organizationName: organization?.name || "organization",
					inviteLink,
				});

				await sendEmailNotification(
					{
						...email,
						toAddresses: [currentInvitation?.email || ""],
					},
					subject,
					html,
				);
			} catch (error) {
				console.log(error);
				throw error;
			}
			return inviteLink;
		}),
});
