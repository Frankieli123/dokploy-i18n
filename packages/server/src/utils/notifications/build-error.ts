import BuildFailedEmail from "@dokploy/server/emails/emails/build-failed";
import { renderAsync } from "@react-email/components";
import { format } from "date-fns";
import { getBuildFailedEmailContent } from "../i18n/backend";
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
	applicationType: string;
	errorMessage: string;
	buildLink: string;
	organizationId: string;
}

export const sendBuildErrorNotifications = async ({
	projectName,
	applicationName,
	applicationType,
	errorMessage,
	buildLink,
	organizationId,
}: Props) => {
	const date = new Date();
	const unixDate = ~~(Number(date) / 1000);
	await dispatchNotifications({
		eventFlag: "appBuildError",
		organizationId,
		send: async (notification) => {
			const { email, discord, telegram, slack, gotify, ntfy, lark } =
				notification;
			if (email) {
				const emailContent = getBuildFailedEmailContent({
					projectName,
					applicationName,
					applicationType,
					buildLink,
					date: date.toLocaleString(),
					notificationName: notification.name,
				});
				const template = await renderAsync(
					BuildFailedEmail({
						projectName,
						applicationName,
						applicationType,
						errorMessage: errorMessage,
						buildLink,
						date: date.toLocaleString(),
						notificationName: notification.name,
					}),
				).catch();
				await sendEmailNotification(email, emailContent.subject, template);
			}

			if (discord) {
				const decorate = (decoration: string, text: string) =>
					`${discord.decoration ? decoration : ""} ${text}`.trim();

				const limitCharacter = 800;
				const truncatedErrorMessage = errorMessage.substring(0, limitCharacter);
				await sendDiscordNotification(discord, {
					title: decorate(">", "`⚠️` Build Failed"),
					color: 0xed4245,
					fields: [
						{
							name: decorate("`🛠️`", "Project"),
							value: projectName,
							inline: true,
						},
						{
							name: decorate("`⚙️`", "Application"),
							value: applicationName,
							inline: true,
						},
						{
							name: decorate("`❔`", "Type"),
							value: applicationType,
							inline: true,
						},
						{
							name: decorate("`📅`", "Date"),
							value: `<t:${unixDate}:D>`,
							inline: true,
						},
						{
							name: decorate("`⌚`", "Time"),
							value: `<t:${unixDate}:t>`,
							inline: true,
						},
						{
							name: decorate("`❓`", "Type"),
							value: "Failed",
							inline: true,
						},
						{
							name: decorate("`⚠️`", "Error Message"),
							value: `\`\`\`${truncatedErrorMessage}\`\`\``,
						},
						{
							name: decorate("`🧷`", "Build Link"),
							value: `[Click here to access build link](${buildLink})`,
						},
					],
					timestamp: date.toISOString(),
					footer: {
						text: "Dokploy Build Notification",
					},
				});
			}

			if (gotify) {
				const decorate = (decoration: string, text: string) =>
					`${gotify.decoration ? decoration : ""} ${text}\n`;
				await sendGotifyNotification(
					gotify,
					decorate("⚠️", "Build Failed"),
					`${decorate("🛠️", `Project: ${projectName}`)}` +
						`${decorate("⚙️", `Application: ${applicationName}`)}` +
						`${decorate("❔", `Type: ${applicationType}`)}` +
						`${decorate("🕒", `Date: ${date.toLocaleString()}`)}` +
						`${decorate("⚠️", `Error:\n${errorMessage}`)}` +
						`${decorate("🔗", `Build details:\n${buildLink}`)}`,
				);
			}

			if (ntfy) {
				await sendNtfyNotification(
					ntfy,
					"Build Failed",
					"warning",
					`view, Build details, ${buildLink}, clear=true;`,
					`🛠️Project: ${projectName}\n` +
						`⚙️Application: ${applicationName}\n` +
						`❔Type: ${applicationType}\n` +
						`🕒Date: ${date.toLocaleString()}\n` +
						`⚠️Error:\n${errorMessage}`,
				);
			}

			if (telegram) {
				const inlineButton = [
					[
						{
							text: "Deployment Logs",
							url: buildLink,
						},
					],
				];

				await sendTelegramNotification(
					telegram,
					`<b>⚠️ Build Failed</b>\n\n<b>Project:</b> ${projectName}\n<b>Application:</b> ${applicationName}\n<b>Type:</b> ${applicationType}\n<b>Date:</b> ${format(date, "PP")}\n<b>Time:</b> ${format(date, "pp")}\n\n<b>Error:</b>\n<pre>${errorMessage}</pre>`,
					inlineButton,
				);
			}

			if (slack) {
				const { channel } = slack;
				await sendSlackNotification(slack, {
					channel: channel,
					attachments: [
						{
							color: "#FF0000",
							pretext: ":warning: *Build Failed*",
							fields: [
								{
									title: "Project",
									value: projectName,
									short: true,
								},
								{
									title: "Application",
									value: applicationName,
									short: true,
								},
								{
									title: "Type",
									value: applicationType,
									short: true,
								},
								{
									title: "Time",
									value: date.toLocaleString(),
									short: true,
								},
								{
									title: "Error",
									value: `\`\`\`${errorMessage}\`\`\``,
									short: false,
								},
							],
							actions: [
								{
									type: "button",
									text: "View Build Details",
									url: buildLink,
								},
							],
						},
					],
				});
			}

			if (lark) {
				const limitCharacter = 800;
				const truncatedErrorMessage = errorMessage.substring(0, limitCharacter);
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
								content: "⚠️ Build Failed",
							},
							subtitle: {
								tag: "plain_text",
								content: "",
							},
							template: "red",
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
													content: `**Project:**\n${projectName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Type:**\n${applicationType}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Error Message:**\n\`\`\`\n${truncatedErrorMessage}\n\`\`\``,
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
													content: `**Application:**\n${applicationName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Date:**\n${format(date, "PP pp")}`,
													text_align: "left",
													text_size: "normal_v2",
												},
											],
											vertical_align: "top",
											weight: 1,
										},
									],
								},
								{
									tag: "button",
									text: {
										tag: "plain_text",
										content: "View Build Details",
									},
									type: "danger",
									width: "default",
									size: "medium",
									behaviors: [
										{
											type: "open_url",
											default_url: buildLink,
											pc_url: "",
											ios_url: "",
											android_url: "",
										},
									],
									margin: "0px 0px 0px 0px",
								},
							],
						},
					},
				});
			}
		},
	});
};
