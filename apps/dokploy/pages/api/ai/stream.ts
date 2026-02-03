import { validateRequest } from "@dokploy/server";
import { apiSendMessage } from "@dokploy/server/db/schema/ai";
import { chatStream, getConversationById } from "@dokploy/server/services/ai";
import type { NextApiRequest, NextApiResponse } from "next";

const bodySchema = apiSendMessage;

function writeSseEvent(
	res: NextApiResponse,
	event: string,
	data: Record<string, unknown>,
) {
	const payload = (() => {
		const seen = new WeakSet<object>();
		const replacer = (_key: string, value: unknown) => {
			if (typeof value === "bigint") return value.toString();
			if (value instanceof Error) {
				return {
					name: value.name,
					message: value.message,
					stack: value.stack,
				};
			}
			if (value instanceof Map) return Array.from(value.entries());
			if (value instanceof Set) return Array.from(value.values());
			if (typeof value === "object" && value !== null) {
				const obj = value as object;
				if (seen.has(obj)) return "[Circular]";
				seen.add(obj);
			}
			return value;
		};

		try {
			return JSON.stringify(data, replacer);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				return JSON.stringify({
					error: "UNSERIALIZABLE",
					message,
				});
			} catch {
				return "{\"error\":\"UNSERIALIZABLE\"}";
			}
		}
	})();

	res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		res.status(405).end("Method Not Allowed");
		return;
	}

	const { session, user } = await validateRequest(req);
	if (!user || !session) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}

	let rawBody: unknown = req.body;
	if (typeof rawBody === "string") {
		try {
			rawBody = JSON.parse(rawBody);
		} catch {
			res.status(400).json({ message: "Invalid JSON body" });
			return;
		}
	}

	const parsed = bodySchema.safeParse(rawBody);
	if (!parsed.success) {
		res
			.status(400)
			.json({ message: "Invalid request", issues: parsed.error.issues });
		return;
	}

	try {
		const conversation = await getConversationById(parsed.data.conversationId);
		if (conversation.organizationId !== session.activeOrganizationId) {
			res.status(403).json({ message: "Forbidden" });
			return;
		}
	} catch {
		res.status(404).json({ message: "Conversation not found" });
		return;
	}

	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});

	const abortController = new AbortController();
	const handleClose = () => abortController.abort();
	req.on("close", handleClose);
	req.on("aborted", handleClose);

	const safeWrite = (
		event: string,
		data: Record<string, unknown>,
	): void => {
		if (abortController.signal.aborted || res.writableEnded || res.finished)
			return;
		try {
			writeSseEvent(res, event, data);
		} catch {
			abortController.abort();
		}
	};

	const pingInterval = setInterval(() => {
		safeWrite("ping", { ts: Date.now() });
	}, 15000);

	safeWrite("start", { conversationId: parsed.data.conversationId });

	let textChunks = 0;
	let reasoningChunks = 0;
	let toolCalls = 0;

	try {
		const result = await chatStream(
			{
				conversationId: parsed.data.conversationId,
				message: parsed.data.message,
				aiId: parsed.data.aiId,
				attachments: parsed.data.attachments,
				organizationId: session.activeOrganizationId,
				userId: user.id,
				uiLocale: req.cookies.DOKPLOY_LOCALE,
			},
			{
				abortSignal: abortController.signal,
				onTextDelta: (delta) => {
					if (typeof delta !== "string" || delta.length === 0) return;
					textChunks++;
					safeWrite("delta", { delta });
				},
				onReasoningDelta: (delta) => {
					if (typeof delta !== "string" || delta.length === 0) return;
					reasoningChunks++;
					safeWrite("reasoning-delta", { delta });
				},
				onToolCall: (toolCallId, toolName, args) => {
					toolCalls++;
					safeWrite("tool-call", {
						toolCallId,
						toolName,
						arguments: args,
					});
				},
				onToolResult: (toolCallId, toolName, result) => {
					safeWrite("tool-result", { toolCallId, toolName, result });
				},
				onError: (error) => {
					safeWrite("stream-error", { error });
				},
			},
		);

		const messageId = result?.message?.messageId;
		console.log(
			`[AI Stream] Completed: ${textChunks} text chunks, ${reasoningChunks} reasoning chunks, ${toolCalls} tool calls, message: ${messageId ?? ""}`,
		);

		safeWrite("done", {
			conversationId: parsed.data.conversationId,
			messageId: messageId ?? "",
			usage: result.usage,
		});
	} catch (error) {
		if (!abortController.signal.aborted) {
			safeWrite("error", {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	} finally {
		clearInterval(pingInterval);
		res.end();
	}
}

export const config = {
	api: {
		responseLimit: false,
	},
};
