import DokployRestartEmail from "@dokploy/server/emails/emails/dokploy-restart";
import { renderAsync } from "@react-email/components";
import { format } from "date-fns";
import { getDokployRestartEmailContent } from "../i18n/backend";
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

export const sendDokployRestartNotifications = async () => {
	const date = new Date();
	const unixDate = ~~(Number(date) / 1000);
	await dispatchNotifications({
		eventFlag: "dokployRestart",
		send: async (notification) => {
			const { email, discord, telegram, slack, gotify, ntfy, lark } =
				notification;
			if (email) {
				const emailContent = getDokployRestartEmailContent({
					date: date.toLocaleString(),
					notificationName: notification.name,
				});
				const template = await renderAsync(
					DokployRestartEmail({
						date: date.toLocaleString(),
						notificationName: notification.name,
					}),
				).catch();

				await sendEmailNotification(email, emailContent.subject, template);
			}

			if (discord) {
				const decorate = (decoration: string, text: string) =>
					`${discord.decoration ? decoration : ""} ${text}`.trim();

				await sendDiscordNotification(discord, {
					title: decorate(">", "Dokploy Server Restarted"),
					color: 0x57f287,
					fields: [
						{
							name: decorate("DATE", "Date"),
							value: `<t:${unixDate}:D>`,
							inline: true,
						},
						{
							name: decorate("TIME", "Time"),
							value: `<t:${unixDate}:t>`,
							inline: true,
						},
						{
							name: decorate("TYPE", "Type"),
							value: "Successful",
							inline: true,
						},
					],
					timestamp: date.toISOString(),
					footer: {
						text: "Dokploy Restart Notification",
					},
				});
			}

			if (gotify) {
				const decorate = (decoration: string, text: string) =>
					`${gotify.decoration ? decoration : ""} ${text}\n`;
				await sendGotifyNotification(
					gotify,
					decorate("OK", "Dokploy Server Restarted"),
					`${decorate("DATE", `Date: ${date.toLocaleString()}`)}`,
				);
			}

			if (ntfy) {
				await sendNtfyNotification(
					ntfy,
					"Dokploy Server Restarted",
					"white_check_mark",
					"",
					`Date: ${date.toLocaleString()}`,
				);
			}

			if (telegram) {
				await sendTelegramNotification(
					telegram,
					`<b>Dokploy Server Restarted</b>\n\n<b>Date:</b> ${format(
						date,
						"PP",
					)}\n<b>Time:</b> ${format(date, "pp")}`,
				);
			}

			if (slack) {
				const { channel } = slack;
				await sendSlackNotification(slack, {
					channel,
					attachments: [
						{
							color: "#00FF00",
							pretext: ":white_check_mark: *Dokploy Server Restarted*",
							fields: [
								{
									title: "Time",
									value: date.toLocaleString(),
									short: true,
								},
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
						config: {
							update_multi: true,
							style: {
								text_size: {
									normal_v2: {
										default: "normal",
										pc: "normal",
										mobile: "heading",
									},
								},
							},
						},
						header: {
							title: {
								tag: "plain_text",
								content: "Dokploy Server Restarted",
							},
							subtitle: {
								tag: "plain_text",
								content: "",
							},
							template: "green",
							padding: "12px 12px 12px 12px",
						},
						body: {
							direction: "vertical",
							padding: "12px 12px 12px 12px",
							elements: [
								{
									tag: "column_set",
									columns: [
										{
											tag: "column",
											width: "weighted",
											elements: [
												{
													tag: "markdown",
													content: "**Status:**\nSuccessful",
													text_align: "left",
													text_size: "normal_v2",
												},
											],
											vertical_align: "top",
											weight: 1,
										},
										{
											tag: "column",
											width: "weighted",
											elements: [
												{
													tag: "markdown",
													content: `**Restart Time:**\n${format(
														date,
														"PP pp",
													)}`,
													text_align: "left",
													text_size: "normal_v2",
												},
											],
											vertical_align: "top",
											weight: 1,
										},
									],
								},
							],
						},
					},
				});
			}
		},
	});
};
