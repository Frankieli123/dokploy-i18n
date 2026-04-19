import { dispatchNotifications } from "./utils";
import {
	sendDiscordNotification,
	sendLarkNotification,
	sendSlackNotification,
	sendTelegramNotification,
} from "./utils";

interface ServerThresholdPayload {
	Type: "CPU" | "Memory";
	Value: number;
	Threshold: number;
	Message: string;
	Timestamp: string;
	Token: string;
	ServerName: string;
}

export const sendServerThresholdNotifications = async (
	organizationId: string,
	payload: ServerThresholdPayload,
) => {
	const date = new Date(payload.Timestamp);
	const unixDate = ~~(Number(date) / 1000);
	const typeEmoji = payload.Type === "CPU" ? "馃敳" : "馃捑";
	const typeColor = 0xff0000;

	await dispatchNotifications({
		eventFlag: "serverThreshold",
		organizationId,
		send: async (notification) => {
			const { discord, telegram, slack, lark } = notification;

			if (discord) {
				const decorate = (decoration: string, text: string) =>
					`${discord.decoration ? decoration : ""} ${text}`.trim();

				await sendDiscordNotification(discord, {
					title: decorate(">", `\`鈿狅笍\` Server ${payload.Type} Alert`),
					color: typeColor,
					fields: [
						{
							name: decorate("`馃彿锔廯", "Server Name"),
							value: payload.ServerName,
							inline: true,
						},
						{
							name: decorate("`馃搮`", "Date"),
							value: `<t:${unixDate}:D>`,
							inline: true,
						},
						{
							name: decorate("`鈱歚", "Time"),
							value: `<t:${unixDate}:t>`,
							inline: true,
						},
						{
							name: decorate(typeEmoji, "Type"),
							value: payload.Type,
							inline: true,
						},
						{
							name: decorate("馃搳", "Current Value"),
							value: `${payload.Value.toFixed(2)}%`,
							inline: true,
						},
						{
							name: decorate("鈿狅笍", "Threshold"),
							value: `${payload.Threshold.toFixed(2)}%`,
							inline: true,
						},
						{
							name: decorate("`馃摐`", "Message"),
							value: `\`\`\`${payload.Message}\`\`\``,
						},
					],
					timestamp: date.toISOString(),
					footer: {
						text: "Dokploy Server Monitoring Alert",
					},
				});
			}

			if (telegram) {
				await sendTelegramNotification(
					telegram,
					`
				<b>鈿狅笍 Server ${payload.Type} Alert</b>
                <b>Server Name:</b> ${payload.ServerName}
				<b>Type:</b> ${payload.Type}
				<b>Current Value:</b> ${payload.Value.toFixed(2)}%
				<b>Threshold:</b> ${payload.Threshold.toFixed(2)}%
				<b>Message:</b> ${payload.Message}
				<b>Time:</b> ${date.toLocaleString()}
			`,
				);
			}

			if (slack) {
				const { channel } = slack;
				await sendSlackNotification(slack, {
					channel: channel,
					attachments: [
						{
							color: "#FF0000",
							pretext: `:warning: *Server ${payload.Type} Alert*`,
							fields: [
								{
									title: "Server Name",
									value: payload.ServerName,
									short: true,
								},
								{
									title: "Type",
									value: payload.Type,
									short: true,
								},
								{
									title: "Current Value",
									value: `${payload.Value.toFixed(2)}%`,
									short: true,
								},
								{
									title: "Threshold",
									value: `${payload.Threshold.toFixed(2)}%`,
									short: true,
								},
								{
									title: "Message",
									value: payload.Message,
								},
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
								content: `鈿狅笍 Server ${payload.Type} Alert`,
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
													content: `**Server Name:**\n${payload.ServerName}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Current Value:**\n${payload.Value.toFixed(2)}%`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Alert Message:**\n${payload.Message}`,
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
													content: `**Type:**\n${payload.Type === "CPU" ? "馃敳" : "馃捑"} ${payload.Type}`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Threshold:**\n${payload.Threshold.toFixed(2)}%`,
													text_align: "left",
													text_size: "normal_v2",
												},
												{
													tag: "markdown",
													content: `**Alert Time:**\n${date.toLocaleString()}`,
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
