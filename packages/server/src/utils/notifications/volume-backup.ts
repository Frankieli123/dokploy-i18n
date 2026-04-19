import { format } from "date-fns";
import {
	dispatchNotifications,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendNtfyNotification,
	sendSlackNotification,
	sendTelegramNotification,
} from "./utils";

interface Props {
	projectName: string;
	applicationName: string;
	serviceType: string;
	volumeName: string;
	type: "error" | "success";
	organizationId: string;
	errorMessage?: string;
	backupSize?: string;
}

export const sendVolumeBackupNotifications = async ({
	projectName,
	applicationName,
	serviceType,
	volumeName,
	type,
	organizationId,
	errorMessage,
	backupSize,
}: Props) => {
	const date = new Date();
	const unixDate = ~~(Number(date) / 1000);
	const title =
		type === "success"
			? "Volume Backup Successful"
			: "Volume Backup Failed";
	const status = type === "success" ? "Successful" : "Failed";
	const baseMessage =
		`Project: ${projectName}\n` +
		`Service: ${applicationName}\n` +
		`Service Type: ${serviceType}\n` +
		`Volume: ${volumeName}\n` +
		`${backupSize ? `Backup Size: ${backupSize}\n` : ""}` +
		`Date: ${date.toLocaleString()}`;
	const errorSection =
		type === "error" && errorMessage ? `\nError: ${errorMessage}` : "";

	await dispatchNotifications({
		eventFlag: "volumeBackup",
		organizationId,
		send: async (notification) => {
			const { email, discord, telegram, slack, gotify, ntfy, lark } =
				notification;

			if (email) {
				const html =
					`<h2>${title}</h2>` +
					`<p><strong>Project:</strong> ${projectName}</p>` +
					`<p><strong>Service:</strong> ${applicationName}</p>` +
					`<p><strong>Service Type:</strong> ${serviceType}</p>` +
					`<p><strong>Volume:</strong> ${volumeName}</p>` +
					(backupSize
						? `<p><strong>Backup Size:</strong> ${backupSize}</p>`
						: "") +
					`<p><strong>Date:</strong> ${date.toLocaleString()}</p>` +
					(type === "error" && errorMessage
						? `<p><strong>Error:</strong> ${errorMessage}</p>`
						: "");

				await sendEmailNotification(email, title, html);
			}

			if (discord) {
				await sendDiscordNotification(discord, {
					title,
					color: type === "success" ? 0x57f287 : 0xed4245,
					fields: [
						{ name: "Project", value: projectName, inline: true },
						{ name: "Service", value: applicationName, inline: true },
						{ name: "Service Type", value: serviceType, inline: true },
						{ name: "Volume", value: volumeName, inline: true },
						...(backupSize
							? [{ name: "Backup Size", value: backupSize, inline: true }]
							: []),
						{ name: "Date", value: `<t:${unixDate}:D>`, inline: true },
						{ name: "Time", value: `<t:${unixDate}:t>`, inline: true },
						{ name: "Status", value: status, inline: true },
						...(type === "error" && errorMessage
							? [
									{
										name: "Error",
										value: `\`\`\`${errorMessage.substring(0, 1010)}\`\`\``,
									},
								]
							: []),
					],
					timestamp: date.toISOString(),
					footer: { text: "Dokploy Volume Backup Notification" },
				});
			}

			if (gotify) {
				await sendGotifyNotification(gotify, title, `${baseMessage}${errorSection}`);
			}

			if (ntfy) {
				await sendNtfyNotification(
					ntfy,
					title,
					type === "success" ? "white_check_mark" : "warning",
					"",
					`${baseMessage}${errorSection}`,
				);
			}

			if (telegram) {
				const telegramMessage =
					`<b>${title}</b>\n\n` +
					`<b>Project:</b> ${projectName}\n` +
					`<b>Service:</b> ${applicationName}\n` +
					`<b>Service Type:</b> ${serviceType}\n` +
					`<b>Volume:</b> ${volumeName}\n` +
					(backupSize ? `<b>Backup Size:</b> ${backupSize}\n` : "") +
					`<b>Date:</b> ${format(date, "PP")}\n` +
					`<b>Time:</b> ${format(date, "pp")}` +
					(type === "error" && errorMessage
						? `\n\n<b>Error:</b>\n<pre>${errorMessage}</pre>`
						: "");
				await sendTelegramNotification(telegram, telegramMessage);
			}

			if (slack) {
				await sendSlackNotification(slack, {
					channel: slack.channel,
					attachments: [
						{
							color: type === "success" ? "#00FF00" : "#FF0000",
							pretext:
								type === "success"
									? ":white_check_mark: *Volume Backup Successful*"
									: ":warning: *Volume Backup Failed*",
							fields: [
								{ title: "Project", value: projectName, short: true },
								{ title: "Service", value: applicationName, short: true },
								{ title: "Service Type", value: serviceType, short: true },
								{ title: "Volume", value: volumeName, short: true },
								...(backupSize
									? [{ title: "Backup Size", value: backupSize, short: true }]
									: []),
								{ title: "Time", value: date.toLocaleString(), short: true },
								...(type === "error" && errorMessage
									? [{ title: "Error", value: errorMessage, short: false }]
									: []),
							],
						},
					],
				});
			}

			if (lark) {
				await sendLarkNotification(lark, {
					msg_type: "interactive",
					card: {
						schema: "2.0",
						config: { update_multi: true },
						header: {
							title: {
								tag: "plain_text",
								content: title,
							},
							template: type === "success" ? "green" : "red",
							padding: "12px 12px 12px 12px",
						},
						body: {
							direction: "vertical",
							padding: "12px 12px 12px 12px",
							elements: [
								{
									tag: "markdown",
									content:
										`**Project:** ${projectName}\n` +
										`**Service:** ${applicationName}\n` +
										`**Service Type:** ${serviceType}\n` +
										`**Volume:** ${volumeName}\n` +
										`${backupSize ? `**Backup Size:** ${backupSize}\n` : ""}` +
										`**Status:** ${status}\n` +
										`**Date:** ${format(date, "PP pp")}` +
										(type === "error" && errorMessage
											? `\n**Error:** ${errorMessage}`
											: ""),
								},
							],
						},
					},
				});
			}
		},
	});
};
