import { db } from "@dokploy/server/db";
import type { z } from "zod";
import {
	type apiCreateDiscord,
	type apiCreateEmail,
	type apiCreateGotify,
	type apiCreateLark,
	type apiCreateNtfy,
	type apiCreateSlack,
	type apiCreateTelegram,
	type apiUpdateDiscord,
	type apiUpdateEmail,
	type apiUpdateGotify,
	type apiUpdateLark,
	type apiUpdateNtfy,
	type apiUpdateSlack,
	type apiUpdateTelegram,
	discord,
	email,
	gotify,
	lark,
	notifications,
	ntfy,
	slack,
	telegram,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

export type Notification = typeof notifications.$inferSelect;

export const createSlackNotification = async (
	input: z.infer<typeof apiCreateSlack>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newSlack = await tx
			.insert(slack)
			.values({
				channel: input.channel,
				webhookUrl: input.webhookUrl,
			})
			.returning()
			.then((value) => value[0]);

		if (!newSlack) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting slack",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				slackId: newSlack.slackId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "slack",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateSlackNotification = async (
	input: z.infer<typeof apiUpdateSlack>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		await tx
			.update(slack)
			.set({
				channel: input.channel,
				webhookUrl: input.webhookUrl,
			})
			.where(eq(slack.slackId, input.slackId))
			.returning()
			.then((value) => value[0]);

		return newDestination;
	});
};

export const createTelegramNotification = async (
	input: z.infer<typeof apiCreateTelegram>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newTelegram = await tx
			.insert(telegram)
			.values({
				botToken: input.botToken,
				chatId: input.chatId,
				messageThreadId: input.messageThreadId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newTelegram) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting telegram",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				telegramId: newTelegram.telegramId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "telegram",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateTelegramNotification = async (
	input: z.infer<typeof apiUpdateTelegram>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		await tx
			.update(telegram)
			.set({
				botToken: input.botToken,
				chatId: input.chatId,
				messageThreadId: input.messageThreadId,
			})
			.where(eq(telegram.telegramId, input.telegramId))
			.returning()
			.then((value) => value[0]);

		return newDestination;
	});
};

export const createDiscordNotification = async (
	input: z.infer<typeof apiCreateDiscord>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newDiscord = await tx
			.insert(discord)
			.values({
				webhookUrl: input.webhookUrl,
				decoration: input.decoration,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDiscord) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting discord",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				discordId: newDiscord.discordId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "discord",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateDiscordNotification = async (
	input: z.infer<typeof apiUpdateDiscord>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		await tx
			.update(discord)
			.set({
				webhookUrl: input.webhookUrl,
				decoration: input.decoration,
			})
			.where(eq(discord.discordId, input.discordId))
			.returning()
			.then((value) => value[0]);

		return newDestination;
	});
};

export const createEmailNotification = async (
	input: z.infer<typeof apiCreateEmail>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newEmail = await tx
			.insert(email)
			.values({
				smtpServer: input.smtpServer,
				smtpPort: input.smtpPort,
				username: input.username,
				password: input.password,
				fromAddress: input.fromAddress,
				toAddresses: input.toAddresses,
			})
			.returning()
			.then((value) => value[0]);

		if (!newEmail) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting email",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				emailId: newEmail.emailId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "email",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateEmailNotification = async (
	input: z.infer<typeof apiUpdateEmail>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		await tx
			.update(email)
			.set({
				smtpServer: input.smtpServer,
				smtpPort: input.smtpPort,
				username: input.username,
				password: input.password,
				fromAddress: input.fromAddress,
				toAddresses: input.toAddresses,
			})
			.where(eq(email.emailId, input.emailId))
			.returning()
			.then((value) => value[0]);

		return newDestination;
	});
};

export const createGotifyNotification = async (
	input: z.infer<typeof apiCreateGotify>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newGotify = await tx
			.insert(gotify)
			.values({
				serverUrl: input.serverUrl,
				appToken: input.appToken,
				priority: input.priority,
				decoration: input.decoration,
			})
			.returning()
			.then((value) => value[0]);

		if (!newGotify) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting gotify",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				gotifyId: newGotify.gotifyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				notificationType: "gotify",
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateGotifyNotification = async (
	input: z.infer<typeof apiUpdateGotify>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				organizationId: input.organizationId,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		await tx
			.update(gotify)
			.set({
				serverUrl: input.serverUrl,
				appToken: input.appToken,
				priority: input.priority,
				decoration: input.decoration,
			})
			.where(eq(gotify.gotifyId, input.gotifyId));

		return newDestination;
	});
};

export const createNtfyNotification = async (
	input: z.infer<typeof apiCreateNtfy>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newNtfy = await tx
			.insert(ntfy)
			.values({
				serverUrl: input.serverUrl,
				topic: input.topic,
				accessToken: input.accessToken ?? null,
				priority: input.priority,
			})
			.returning()
			.then((value) => value[0]);

		if (!newNtfy) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting ntfy",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				ntfyId: newNtfy.ntfyId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				notificationType: "ntfy",
				organizationId: organizationId,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateNtfyNotification = async (
	input: z.infer<typeof apiUpdateNtfy>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				serverThreshold: input.serverThreshold,
				organizationId: input.organizationId,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		await tx
			.update(ntfy)
			.set({
				serverUrl: input.serverUrl,
				topic: input.topic,
				accessToken: input.accessToken ?? null,
				priority: input.priority,
			})
			.where(eq(ntfy.ntfyId, input.ntfyId));

		return newDestination;
	});
};

export const findNotificationById = async (notificationId: string) => {
	const notification = await db.query.notifications.findFirst({
		where: eq(notifications.notificationId, notificationId),
		with: {
			slack: true,
			telegram: true,
			discord: true,
			email: true,
			gotify: true,
			ntfy: true,
			lark: true,
		},
	});
	if (!notification) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Notification not found",
		});
	}
	return notification;
};

export const removeNotificationById = async (notificationId: string) => {
	const result = await db
		.delete(notifications)
		.where(eq(notifications.notificationId, notificationId))
		.returning();

	return result[0];
};

export const createLarkNotification = async (
	input: z.infer<typeof apiCreateLark>,
	organizationId: string,
) => {
	await db.transaction(async (tx) => {
		const newLark = await tx
			.insert(lark)
			.values({
				webhookUrl: input.webhookUrl,
			})
			.returning()
			.then((value) => value[0]);

		if (!newLark) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting lark",
			});
		}

		const newDestination = await tx
			.insert(notifications)
			.values({
				larkId: newLark.larkId,
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				notificationType: "lark",
				organizationId: organizationId,
				serverThreshold: input.serverThreshold,
			})
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error input: Inserting notification",
			});
		}

		return newDestination;
	});
};

export const updateLarkNotification = async (
	input: z.infer<typeof apiUpdateLark>,
) => {
	await db.transaction(async (tx) => {
		const newDestination = await tx
			.update(notifications)
			.set({
				name: input.name,
				appDeploy: input.appDeploy,
				appBuildError: input.appBuildError,
				databaseBackup: input.databaseBackup,
				volumeBackup: input.volumeBackup,
				dokployRestart: input.dokployRestart,
				dockerCleanup: input.dockerCleanup,
				organizationId: input.organizationId,
				serverThreshold: input.serverThreshold,
			})
			.where(eq(notifications.notificationId, input.notificationId))
			.returning()
			.then((value) => value[0]);

		if (!newDestination) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error Updating notification",
			});
		}

		await tx
			.update(lark)
			.set({
				webhookUrl: input.webhookUrl,
			})
			.where(eq(lark.larkId, input.larkId))
			.returning()
			.then((value) => value[0]);

		return newDestination;
	});
};

export const updateNotificationById = async (
	notificationId: string,
	notificationData: Partial<Notification>,
) => {
	const result = await db
		.update(notifications)
		.set({
			...notificationData,
		})
		.where(eq(notifications.notificationId, notificationId))
		.returning();

	return result[0];
};
