import {
	createDiscordNotification,
	createEmailNotification,
	createGotifyNotification,
	createLarkNotification,
	createNtfyNotification,
	createSlackNotification,
	createTelegramNotification,
	findNotificationById,
	getTestNotificationContent,
	IS_CLOUD,
	removeNotificationById,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendNtfyNotification,
	sendServerThresholdNotifications,
	sendSlackNotification,
	sendTelegramNotification,
	updateDiscordNotification,
	updateEmailNotification,
	updateGotifyNotification,
	updateLarkNotification,
	updateNtfyNotification,
	updateSlackNotification,
	updateTelegramNotification,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	createTRPCRouter,
	publicProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { db } from "@/server/db";
import {
	apiCreateDiscord,
	apiCreateEmail,
	apiCreateGotify,
	apiCreateLark,
	apiCreateNtfy,
	apiCreateSlack,
	apiCreateTelegram,
	apiFindOneNotification,
	apiTestDiscordConnection,
	apiTestEmailConnection,
	apiTestGotifyConnection,
	apiTestLarkConnection,
	apiTestNtfyConnection,
	apiTestSlackConnection,
	apiTestTelegramConnection,
	apiUpdateDiscord,
	apiUpdateEmail,
	apiUpdateGotify,
	apiUpdateLark,
	apiUpdateNtfy,
	apiUpdateSlack,
	apiUpdateTelegram,
	notifications,
	server,
	user,
} from "@/server/db/schema";

export const notificationRouter = createTRPCRouter({
	createSlack: withPermission("notification", "create")
		.input(apiCreateSlack)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createSlackNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateSlack: withPermission("notification", "update")
		.input(apiUpdateSlack)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this notification",
				});
			}
			const result = await updateSlackNotification({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),
	testSlackConnection: withPermission("notification", "create")
		.input(apiTestSlackConnection)
		.mutation(async ({ input }) => {
			try {
				const { testMessage } = getTestNotificationContent();
				await sendSlackNotification(input, {
					channel: input.channel,
					text: testMessage,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createTelegram: withPermission("notification", "create")
		.input(apiCreateTelegram)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createTelegramNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateTelegram: withPermission("notification", "update")
		.input(apiUpdateTelegram)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this notification",
				});
			}
			const result = await updateTelegramNotification({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),
	testTelegramConnection: withPermission("notification", "create")
		.input(apiTestTelegramConnection)
		.mutation(async ({ input }) => {
			try {
				const { testMessage } = getTestNotificationContent();
				await sendTelegramNotification(input, testMessage);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createDiscord: withPermission("notification", "create")
		.input(apiCreateDiscord)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createDiscordNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateDiscord: withPermission("notification", "update")
		.input(apiUpdateDiscord)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this notification",
				});
			}
			const result = await updateDiscordNotification({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),
	testDiscordConnection: withPermission("notification", "create")
		.input(apiTestDiscordConnection)
		.mutation(async ({ input }) => {
			try {
				const decorate = (decoration: string, text: string) =>
					`${input.decoration ? decoration : ""} ${text}`.trim();
				const { discordTitle, testMessage } = getTestNotificationContent();
				await sendDiscordNotification(input, {
					title: decorate(">", discordTitle),
					description: decorate(">", testMessage),
					color: 0xF3F7F4,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	createEmail: withPermission("notification", "create")
		.input(apiCreateEmail)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createEmailNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateEmail: withPermission("notification", "update")
		.input(apiUpdateEmail)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this notification",
				});
			}
			const result = await updateEmailNotification({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),
	testEmailConnection: withPermission("notification", "create")
		.input(apiTestEmailConnection)
		.mutation(async ({ input }) => {
			try {
				const { emailSubject, emailHtml } = getTestNotificationContent();
				await sendEmailNotification(input, emailSubject, emailHtml);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `${error instanceof Error ? error.message : "Unknown error"}`,
					cause: error,
				});
			}
		}),
	remove: withPermission("notification", "delete")
		.input(apiFindOneNotification)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to delete this notification",
				});
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return await removeNotificationById(input.notificationId);
		}),
	one: withPermission("notification", "read")
		.input(apiFindOneNotification)
		.query(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this notification",
				});
			}
			return notification;
		}),
	all: withPermission("notification", "read").query(async ({ ctx }) => {
		return await db.query.notifications.findMany({
			with: {
				slack: true,
				telegram: true,
				discord: true,
				email: true,
				gotify: true,
				ntfy: true,
				lark: true,
			},
			orderBy: desc(notifications.createdAt),
			where: eq(notifications.organizationId, ctx.session.activeOrganizationId),
		});
	}),
	receiveNotification: publicProcedure
		.input(
			z.object({
				ServerType: z.enum(["Dokploy", "Remote"]).default("Dokploy"),
				Type: z.enum(["Memory", "CPU"]),
				Value: z.number(),
				Threshold: z.number(),
				Message: z.string(),
				Timestamp: z.string(),
				Token: z.string(),
			}),
		)
		.mutation(async ({ input }) => {
			try {
				let organizationId = "";
				let ServerName = "";

				if (input.ServerType === "Dokploy") {
					const result = await db
						.select()
						.from(user)
						.where(
							sql`${user.metricsConfig}::jsonb -> 'server' ->> 'token' = ${input.Token}`,
						);

					if (!result?.[0]?.id) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Token not found",
						});
					}

					organizationId = result[0].id;
					ServerName = "Dokploy";
				} else {
					const result = await db
						.select()
						.from(server)
						.where(
							sql`${server.metricsConfig}::jsonb -> 'server' ->> 'token' = ${input.Token}`,
						);

					if (!result?.[0]?.organizationId) {
						throw new TRPCError({
							code: "BAD_REQUEST",
							message: "Token not found",
						});
					}

					organizationId = result[0].organizationId;
					ServerName = "Remote";
				}

				await sendServerThresholdNotifications(organizationId, {
					...input,
					ServerName,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error sending the notification",
					cause: error,
				});
			}
		}),
	createGotify: withPermission("notification", "create")
		.input(apiCreateGotify)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createGotifyNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateGotify: withPermission("notification", "update")
		.input(apiUpdateGotify)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (IS_CLOUD && notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this notification",
				});
			}
			const result = await updateGotifyNotification({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),
	testGotifyConnection: withPermission("notification", "create")
		.input(apiTestGotifyConnection)
		.mutation(async ({ input }) => {
			try {
				const { notificationTitle, testMessage } = getTestNotificationContent();
				await sendGotifyNotification(input, notificationTitle, testMessage);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createNtfy: withPermission("notification", "create")
		.input(apiCreateNtfy)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createNtfyNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateNtfy: withPermission("notification", "update")
		.input(apiUpdateNtfy)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (IS_CLOUD && notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this notification",
				});
			}
			const result = await updateNtfyNotification({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),
	testNtfyConnection: withPermission("notification", "create")
		.input(apiTestNtfyConnection)
		.mutation(async ({ input }) => {
			try {
				const { notificationTitle, ntfyActions, testMessage } = getTestNotificationContent();
				await sendNtfyNotification(input, notificationTitle, "", ntfyActions, testMessage);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	createLark: withPermission("notification", "create")
		.input(apiCreateLark)
		.mutation(async ({ input, ctx }) => {
			try {
				const result = await createLarkNotification(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "notification",
					resourceName: input.name,
				});
				return result;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the notification",
					cause: error,
				});
			}
		}),
	updateLark: withPermission("notification", "update")
		.input(apiUpdateLark)
		.mutation(async ({ input, ctx }) => {
			const notification = await findNotificationById(input.notificationId);
			if (IS_CLOUD && notification.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to update this notification",
				});
			}
			const result = await updateLarkNotification({
				...input,
				organizationId: ctx.session.activeOrganizationId,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "notification",
				resourceId: input.notificationId,
				resourceName: notification.name,
			});
			return result;
		}),
	testLarkConnection: withPermission("notification", "create")
		.input(apiTestLarkConnection)
		.mutation(async ({ input }) => {
			try {
				const { larkText } = getTestNotificationContent();
				await sendLarkNotification(input, {
					msg_type: "text",
					content: {
						text: larkText,
					},
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error testing the notification",
					cause: error,
				});
			}
		}),
	getEmailProviders: withPermission("notification", "read").query(async ({ ctx }) => {
		return await db.query.notifications.findMany({
			where: eq(notifications.organizationId, ctx.session.activeOrganizationId),
			with: {
				email: true,
			},
		});
	}),
});
