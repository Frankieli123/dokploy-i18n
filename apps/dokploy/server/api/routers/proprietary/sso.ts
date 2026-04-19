import { IS_CLOUD } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { ssoProvider, ssoProviderBodySchema, user } from "@dokploy/server/db/schema";
import { auth } from "@dokploy/server/lib/auth";
import {
	getOrganizationOwnerId,
	normalizeTrustedOrigin,
	requestToHeaders,
} from "@dokploy/server/services/proprietary/sso";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	adminProcedure,
	createTRPCRouter,
	publicProcedure,
} from "../../trpc";

export const ssoRouter = createTRPCRouter({
	showSignInWithSSO: publicProcedure.query(async () => {
		if (IS_CLOUD) return true;
		const provider = await db.query.ssoProvider.findFirst({
			columns: { id: true },
		});
		return !!provider;
	}),
	listProviders: adminProcedure.query(async ({ ctx }) => {
		return db.query.ssoProvider.findMany({
			where: eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
			columns: {
				id: true,
				providerId: true,
				issuer: true,
				domain: true,
				oidcConfig: true,
				samlConfig: true,
				organizationId: true,
			},
			orderBy: [asc(ssoProvider.createdAt)],
		});
	}),
	getTrustedOrigins: adminProcedure.query(async ({ ctx }) => {
		const ownerId = await getOrganizationOwnerId(ctx.session.activeOrganizationId);
		if (!ownerId) return [];
		const ownerUser = await db.query.user.findFirst({
			where: eq(user.id, ownerId),
			columns: {
				trustedOrigins: true,
			},
		});
		return ownerUser?.trustedOrigins ?? [];
	}),
	one: adminProcedure
		.input(z.object({ providerId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const provider = await db.query.ssoProvider.findFirst({
				where: and(
					eq(ssoProvider.providerId, input.providerId),
					eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
				),
				columns: {
					id: true,
					providerId: true,
					issuer: true,
					domain: true,
					oidcConfig: true,
					samlConfig: true,
					organizationId: true,
				},
			});

			if (!provider) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "SSO provider not found",
				});
			}

			return provider;
		}),
	register: adminProcedure
		.input(ssoProviderBodySchema)
		.mutation(async ({ ctx, input }) => {
			const providers = await db.query.ssoProvider.findMany({
				columns: {
					domain: true,
				},
			});

			for (const provider of providers) {
				const providerDomains = provider.domain
					.split(",")
					.map((domain: string) => domain.trim().toLowerCase());
				for (const domain of input.domains) {
					if (providerDomains.includes(domain)) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Domain ${domain} is already registered for another provider`,
						});
					}
				}
			}

			await auth.registerSSOProvider({
				body: {
					...input,
					organizationId: ctx.session.activeOrganizationId,
					domain: input.domains.join(","),
				},
				headers: requestToHeaders(ctx.req),
			});

			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceId: input.providerId,
				resourceName: input.providerId,
				metadata: { type: "sso-provider" },
			});

			return { success: true };
		}),
	update: adminProcedure
		.input(ssoProviderBodySchema)
		.mutation(async ({ ctx, input }) => {
			const existing = await db.query.ssoProvider.findFirst({
				where: and(
					eq(ssoProvider.providerId, input.providerId),
					eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
				),
				columns: {
					issuer: true,
					domain: true,
				},
			});

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "SSO provider not found",
				});
			}

			const providers = await db.query.ssoProvider.findMany({
				where: eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
				columns: {
					providerId: true,
					domain: true,
				},
			});

			for (const provider of providers) {
				if (provider.providerId === input.providerId) continue;
				const providerDomains = provider.domain
					.split(",")
					.map((domain: string) => domain.trim().toLowerCase());
				for (const domain of input.domains) {
					if (providerDomains.includes(domain)) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: `Domain ${domain} is already registered for another provider`,
						});
					}
				}
			}

			const issuerChanged =
				normalizeTrustedOrigin(existing.issuer) !==
				normalizeTrustedOrigin(input.issuer);
			if (issuerChanged) {
				const ownerId = await getOrganizationOwnerId(ctx.session.activeOrganizationId);
				if (!ownerId) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Organization owner not found",
					});
				}

				const ownerUser = await db.query.user.findFirst({
					where: eq(user.id, ownerId),
					columns: { trustedOrigins: true },
				});
				const trustedOrigins = ownerUser?.trustedOrigins ?? [];
				const nextOrigin = normalizeTrustedOrigin(input.issuer);
				const included = trustedOrigins.some(
					(origin: string) => origin.toLowerCase() === nextOrigin.toLowerCase(),
				);
				if (!included) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Issuer URL is not in trusted origins",
					});
				}
			}

			await auth.updateSSOProvider({
				params: { providerId: input.providerId },
				body: {
					providerId: input.providerId,
					issuer: input.issuer,
					domain: input.domains.join(","),
					...(input.oidcConfig ? { oidcConfig: input.oidcConfig } : {}),
					...(input.samlConfig ? { samlConfig: input.samlConfig } : {}),
				},
				headers: requestToHeaders(ctx.req),
			});

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: input.providerId,
				resourceName: input.providerId,
				metadata: { type: "sso-provider" },
			});

			return { success: true };
		}),
	deleteProvider: adminProcedure
		.input(z.object({ providerId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const existing = await db.query.ssoProvider.findFirst({
				where: and(
					eq(ssoProvider.providerId, input.providerId),
					eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
				),
				columns: {
					id: true,
				},
			});

			if (!existing) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "SSO provider not found",
				});
			}

			await db
				.delete(ssoProvider)
				.where(
					and(
						eq(ssoProvider.providerId, input.providerId),
						eq(ssoProvider.organizationId, ctx.session.activeOrganizationId),
					),
				);

			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.providerId,
				resourceName: input.providerId,
				metadata: { type: "sso-provider" },
			});

			return { success: true };
		}),
	addTrustedOrigin: adminProcedure
		.input(z.object({ origin: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const ownerId = await getOrganizationOwnerId(ctx.session.activeOrganizationId);
			if (!ownerId) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Organization owner not found",
				});
			}

			const normalized = normalizeTrustedOrigin(input.origin);
			const ownerUser = await db.query.user.findFirst({
				where: eq(user.id, ownerId),
				columns: { trustedOrigins: true },
			});
			const existing = ownerUser?.trustedOrigins ?? [];
			if (existing.some((origin: string) => origin.toLowerCase() === normalized.toLowerCase())) {
				return { success: true };
			}

			await db
				.update(user)
				.set({ trustedOrigins: Array.from(new Set([...existing, normalized])) })
				.where(eq(user.id, ownerId));

			return { success: true };
		}),
	updateTrustedOrigin: adminProcedure
		.input(
			z.object({
				oldOrigin: z.string().min(1),
				newOrigin: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const ownerId = await getOrganizationOwnerId(ctx.session.activeOrganizationId);
			if (!ownerId) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Organization owner not found",
				});
			}

			const oldOrigin = normalizeTrustedOrigin(input.oldOrigin);
			const newOrigin = normalizeTrustedOrigin(input.newOrigin);
			const ownerUser = await db.query.user.findFirst({
				where: eq(user.id, ownerId),
				columns: { trustedOrigins: true },
			});
			const existing = ownerUser?.trustedOrigins ?? [];

			await db
				.update(user)
				.set({
					trustedOrigins: existing.map((origin: string) =>
						origin.toLowerCase() === oldOrigin.toLowerCase() ? newOrigin : origin,
					),
				})
				.where(eq(user.id, ownerId));

			return { success: true };
		}),
	removeTrustedOrigin: adminProcedure
		.input(z.object({ origin: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const ownerId = await getOrganizationOwnerId(ctx.session.activeOrganizationId);
			if (!ownerId) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Organization owner not found",
				});
			}

			const normalized = normalizeTrustedOrigin(input.origin);
			const ownerUser = await db.query.user.findFirst({
				where: eq(user.id, ownerId),
				columns: { trustedOrigins: true },
			});
			const existing = ownerUser?.trustedOrigins ?? [];

			await db
				.update(user)
				.set({
					trustedOrigins: existing.filter(
						(origin: string) => origin.toLowerCase() !== normalized.toLowerCase(),
					),
				})
				.where(eq(user.id, ownerId));

			return { success: true };
		}),
});
