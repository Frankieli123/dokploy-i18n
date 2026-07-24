import type { IncomingMessage } from "node:http";
import { apiKey } from "@better-auth/api-key";
import { sso } from "@better-auth/sso";
import * as bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, isAPIError } from "better-auth/api";
import { admin, organization, twoFactor } from "better-auth/plugins";
import { and, desc, eq } from "drizzle-orm";
import { BETTER_AUTH_SECRET, IS_CLOUD } from "../constants";
import { db } from "../db";
import * as schema from "../db/schema";
import {
	findAdmin,
	getTrustedOrigins,
	getTrustedProviders,
	getUserByToken,
} from "../services/admin";
import { createAuditLog } from "../services/proprietary/audit-log";
import { updateUser } from "../services/user";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "../services/web-server-settings";
import {
	getInvitationEmailContent,
	getResetPasswordEmailContent,
	getVerifyEmailContent,
} from "../utils/i18n/backend";
import { buildPanelTrustedOrigins } from "../utils/panel-domains";
import { getHubSpotUTK, submitToHubSpot } from "../utils/tracking/hubspot";
import { sendEmail } from "../verification/send-verification-email";
import { getPublicIpWithFallback } from "../wss/utils";
import { ac, adminRole, memberRole, ownerRole } from "./access-control";
import {
	getAuthCookieOptions,
	resolveSelfHostedServerIp,
} from "./auth-options";

export {
	getInvitationEmailContent,
	getResetPasswordEmailContent,
	getVerifyEmailContent,
};

const { handler, api } = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: schema,
	}),
	secret: BETTER_AUTH_SECRET,
	...getAuthCookieOptions(IS_CLOUD),
	disabledPaths: [
		"/sso/register",
		"/organization/create",
		"/organization/update",
		"/organization/delete",
	],
	account: {
		accountLinking: {
			enabled: true,
			async trustedProviders() {
				const fromDb = await getTrustedProviders();
				return ["github", "google", ...fromDb];
			},
			allowDifferentEmails: true,
		},
	},
	appName: "Dokploy",
	socialProviders: {
		github: {
			clientId: process.env.GITHUB_CLIENT_ID as string,
			clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
		},
		google: {
			clientId: process.env.GOOGLE_CLIENT_ID as string,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
		},
	},
	logger: {
		disabled: process.env.NODE_ENV === "production",
	},
	...(!IS_CLOUD && {
		async trustedOrigins() {
			const [trustedOrigins, settings] = await Promise.all([
				getTrustedOrigins(),
				getWebServerSettings().catch(() => null),
			]);

			if (settings && (settings.serverIp || settings.host || settings.additionalHosts?.length)) {
				return Array.from(new Set([
					...buildPanelTrustedOrigins({
					serverIp: settings.serverIp,
					host: settings.host,
					additionalHosts: settings.additionalHosts,
					https: settings.https,
					}),
					...trustedOrigins,
				]));
			}

			const admin = await findAdmin().catch(() => null);
			if (admin) {
				return Array.from(new Set([
					...buildPanelTrustedOrigins({
					serverIp: admin.user.serverIp,
					host: admin.user.host,
					additionalHosts: admin.user.additionalHosts,
					https: admin.user.https,
					}),
					...trustedOrigins,
				]));
			}
			return trustedOrigins;
		},
	}),
	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user, url }) => {
			if (IS_CLOUD) {
				const { subject, html } = getVerifyEmailContent({
					url,
				});

				await sendEmail({
					email: user.email,
					subject,
					text: html,
				});
			}
		},
	},
	emailAndPassword: {
		enabled: true,
		autoSignIn: !IS_CLOUD,
		requireEmailVerification: IS_CLOUD,
		password: {
			async hash(password) {
				return bcrypt.hashSync(password, 10);
			},
			async verify({ hash, password }) {
				return bcrypt.compareSync(password, hash);
			},
		},
		sendResetPassword: async ({ user, url }) => {
			const { subject, html } = getResetPasswordEmailContent({
				url,
			});

			await sendEmail({
				email: user.email,
				subject,
				text: html,
			});
		},
	},
	databaseHooks: {
		user: {
			create: {
				before: async (_user, context) => {
					if (!IS_CLOUD) {
						const xDokployToken =
							context?.request?.headers?.get("x-dokploy-token");
						if (xDokployToken) {
							const user = await getUserByToken(xDokployToken);
							if (!user) {
								throw new APIError("BAD_REQUEST", {
									message: "User not found",
								});
							}
						} else {
							const isSSORequest = (context as { path?: string } | undefined)?.path?.includes("/sso");
							if (isSSORequest) {
								return;
							}
							const isAdminPresent = await db.query.member.findFirst({
								where: eq(schema.member.role, "owner"),
							});
							if (isAdminPresent) {
								throw new APIError("BAD_REQUEST", {
									message: "Admin is already created",
								});
							}
						}
					}
				},
				after: async (user, context) => {
					const isSSORequest = (context as { path?: string; params?: { providerId?: string } } | undefined)?.path?.includes("/sso");
					const isAdminPresent = await db.query.member.findFirst({
						where: eq(schema.member.role, "owner"),
					});

					if (!IS_CLOUD) {
						const settings = await getWebServerSettings().catch(() => null);
						const serverIp = await resolveSelfHostedServerIp(
							settings?.serverIp,
							getPublicIpWithFallback,
						);

						if (serverIp) {
							await updateUser(user.id, { serverIp });
							if (!settings?.serverIp) {
								await updateWebServerSettings({ serverIp });
							}
						}
					}

					if (IS_CLOUD) {
						try {
							const hutk = getHubSpotUTK(
								context?.request?.headers?.get("cookie") || undefined,
							);
							const hubspotSuccess = await submitToHubSpot(
								{
									email: user.email,
									firstName: user.name,
									lastName: user.name,
								},
								hutk,
							);
							if (!hubspotSuccess) {
								console.error("Failed to submit to HubSpot");
							}
						} catch (error) {
							console.error("Error submitting to HubSpot", error);
						}
					}

					if (IS_CLOUD || !isAdminPresent) {
						await db.transaction(async (tx) => {
							const organization = await tx
								.insert(schema.organization)
								.values({
									name: "My Organization",
									ownerId: user.id,
									createdAt: new Date(),
								})
								.returning()
								.then((res) => res[0]);

							await tx.insert(schema.member).values({
								userId: user.id,
								organizationId: organization?.id || "",
								role: "owner",
								createdAt: new Date(),
								isDefault: true, // Mark first organization as default
							});
						});
					} else if (isSSORequest) {
						const providerId = (context as { params?: { providerId?: string } } | undefined)?.params?.providerId;
						if (!providerId) {
							throw new APIError("BAD_REQUEST", {
								message: "Provider ID is required",
							});
						}

						const provider = await db.query.ssoProvider.findFirst({
							where: eq(schema.ssoProvider.providerId, providerId),
						});

						if (!provider?.organizationId) {
							throw new APIError("BAD_REQUEST", {
								message: "Provider not found",
							});
						}

						await db.insert(schema.member).values({
							userId: user.id,
							organizationId: provider.organizationId,
							role: "member",
							createdAt: new Date(),
							isDefault: true,
						});
					}
				},
			},
		},
		session: {
			create: {
				before: async (session) => {
					// Find the default organization for this user
					// Priority: 1) isDefault=true, 2) most recently created
					const member = await db.query.member.findFirst({
						where: eq(schema.member.userId, session.userId),
						orderBy: [
							desc(schema.member.isDefault),
							desc(schema.member.createdAt),
						],
						with: {
							organization: true,
						},
					});

					return {
						data: {
							...session,
							activeOrganizationId: member?.organization.id,
						},
					};
				},
				after: async (
					session: { userId: string; activeOrganizationId?: string },
				) => {
					const orgId = session.activeOrganizationId;
					if (!orgId) return;

					const memberRecord = await db.query.member.findFirst({
						where: and(
							eq(schema.member.userId, session.userId),
							eq(schema.member.organizationId, orgId),
						),
						with: {
							user: true,
						},
					});

					if (!memberRecord) return;

					await createAuditLog({
						organizationId: orgId,
						userId: session.userId,
						userEmail: memberRecord.user.email,
						userRole: memberRecord.role,
						action: "login",
						resourceType: "session",
					});
				},
			},
			delete: {
				after: async (session: { userId: string; activeOrganizationId?: string }) => {
					const orgId = session.activeOrganizationId;
					if (!orgId) return;

					const memberRecord = await db.query.member.findFirst({
						where: and(
							eq(schema.member.userId, session.userId),
							eq(schema.member.organizationId, orgId),
						),
						with: {
							user: true,
						},
					});

					if (!memberRecord) return;

					await createAuditLog({
						organizationId: orgId,
						userId: session.userId,
						userEmail: memberRecord.user.email,
						userRole: memberRecord.role,
						action: "logout",
						resourceType: "session",
					});
				},
			},
		},
	},
	session: {
		expiresIn: 60 * 60 * 24 * 3,
		updateAge: 60 * 60 * 24,
	},
	user: {
		modelName: "user",
		additionalFields: {
			role: {
				type: "string",
				// required: true,
				input: false,
			},
			ownerId: {
				type: "string",
				// required: true,
				input: false,
			},
			allowImpersonation: {
				fieldName: "allowImpersonation",
				type: "boolean",
				defaultValue: false,
			},
		},
	},
	plugins: [
		apiKey({
			enableMetadata: true,
			references: "user",
		}),
		sso(),
		twoFactor(),
		organization({
			ac,
			roles: {
				owner: ownerRole,
				admin: adminRole,
				member: memberRole,
			},
			dynamicAccessControl: {
				enabled: true,
				maximumRolesPerOrganization: 10,
			},
			async sendInvitationEmail(data, _request) {
				if (IS_CLOUD) {
					const host =
						process.env.NODE_ENV === "development"
							? "http://localhost:3000"
							: "https://app.dokploy.com";
					const inviteLink = `${host}/invitation?token=${data.id}`;
					const { subject, html } = getInvitationEmailContent({
						organizationName: data.organization.name,
						inviteLink,
					});

					await sendEmail({
						email: data.email,
						subject,
						text: html,
					});
				}
			},
		}),
		...(IS_CLOUD
			? [
					admin({
						adminUserIds: [process.env.USER_ADMIN_ID as string],
					}),
				]
			: []),
	],
});

export const auth = {
	handler,
	createApiKey: api.createApiKey,
	registerSSOProvider: api.registerSSOProvider,
	updateSSOProvider: api.updateSSOProvider,
};

export const validateRequest = async (request: IncomingMessage) => {
	const apiKey = request.headers["x-api-key"] as string;
	if (apiKey) {
		try {
			const { valid, key, error } = await api.verifyApiKey({
				body: {
					key: apiKey,
				},
			});

			if (error) {
				throw new Error(error.message || "Error verifying API key");
			}
			if (!valid || !key) {
				return {
					session: null,
					user: null,
				};
			}

			const apiKeyRecord = await db.query.apikey.findFirst({
				where: eq(schema.apikey.id, key.id),
				with: {
					user: true,
				},
			});

			if (!apiKeyRecord) {
				return {
					session: null,
					user: null,
				};
			}

			const organizationId = JSON.parse(
				apiKeyRecord.metadata || "{}",
			).organizationId;

			if (!organizationId) {
				return {
					session: null,
					user: null,
				};
			}

			const member = await db.query.member.findFirst({
				where: and(
					eq(schema.member.userId, apiKeyRecord.user.id),
					eq(schema.member.organizationId, organizationId),
				),
				with: {
					organization: true,
				},
			});

			const {
				id,
				name,
				email,
				emailVerified,
				image,
				createdAt,
				updatedAt,
				twoFactorEnabled,
			} = apiKeyRecord.user;

			const mockSession = {
				session: {
					userId: apiKeyRecord.user.id,
					activeOrganizationId: organizationId || "",
				},
				user: {
					id,
					name,
					email,
					emailVerified,
					image,
					createdAt,
					updatedAt,
					twoFactorEnabled,
					role: member?.role || "member",
					ownerId: member?.organization.ownerId || apiKeyRecord.user.id,
				},
			};

			return mockSession;
		} catch (error) {
			console.error("Error verifying API key", error);
			return {
				session: null,
				user: null,
			};
		}
	}

	// If no API key, proceed with normal session validation
	let session: Awaited<ReturnType<typeof api.getSession>> | null = null;
	try {
		session = await api.getSession({
			headers: new Headers({
				cookie: request.headers.cookie || "",
			}),
		});
	} catch (error) {
		const err = error as unknown;
		if (isAPIError(err)) {
			const apiError = err as APIError;
			console.error("[auth] getSession failed", {
				status: apiError.status,
				code: apiError.body?.code,
				message: apiError.body?.message ?? apiError.message,
			});
		} else {
			console.error("[auth] getSession unexpected error", err);
		}
		return {
			session: null,
			user: null,
		};
	}

	if (!session?.session || !session.user) {
		return {
			session: null,
			user: null,
		};
	}

	if (session?.user) {
		const member = await db.query.member.findFirst({
			where: and(
				eq(schema.member.userId, session.user.id),
				eq(
					schema.member.organizationId,
					session.session.activeOrganizationId || "",
				),
			),
			with: {
				organization: true,
			},
		});

		session.user.role = member?.role || "member";
		if (member) {
			session.user.ownerId = member.organization.ownerId;
		} else {
			session.user.ownerId = session.user.id;
		}
	}

	return session;
};
