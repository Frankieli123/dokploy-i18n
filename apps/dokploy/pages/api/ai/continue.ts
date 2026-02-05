import { validateRequest } from "@dokploy/server";
import { chatStream, getConversationById, getMessages } from "@dokploy/server/services/ai";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const bodySchema = z.object({
	conversationId: z.string().min(1),
	aiId: z.string().min(1),
});

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
				return { name: value.name, message: value.message, stack: value.stack };
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
				return JSON.stringify({ error: "UNSERIALIZABLE", message });
			} catch {
				return "{\"error\":\"UNSERIALIZABLE\"}";
			}
		}
	})();

	res.write(`event: ${event}\ndata: ${payload}\n\n`);
	try {
		(res as any).flush?.();
	} catch {}
}

function buildContinuePrompt(userRequest: string): string {
	const clipped = userRequest.trim().slice(0, 500);
	return [
		"Continue the task based on the conversation so far.",
		`User request: ${clipped || "(empty)"}`,
		"",
		"Rules:",
		"- Use the recent tool execution context to avoid repeating completed work.",
		"- If more actions are required, call tools.",
		"- If the task is complete, provide a concise final confirmation and DO NOT call any tools.",
		'- Never ask the user to "wait" or say you are still "processing".',
	].join("\n");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
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

	let lastUserMessage = "";
	try {
		const conversation = await getConversationById(parsed.data.conversationId);
		if (conversation.organizationId !== session.activeOrganizationId) {
			res.status(403).json({ message: "Forbidden" });
			return;
		}

		const history = await getMessages({
			conversationId: parsed.data.conversationId,
			limit: 50,
		});
		for (let i = history.length - 1; i >= 0; i--) {
			const msg = history[i];
			if (!msg) continue;
			if (msg.role !== "user") continue;
			const content = typeof msg.content === "string" ? msg.content.trim() : "";
			if (content) {
				lastUserMessage = content;
				break;
			}
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
	try {
		(res as any).flushHeaders?.();
	} catch {}
	try {
		// Helps bypass proxy buffering so deltas/tool events are visible during streaming.
		res.write(`:${" ".repeat(2048)}\n\n`);
	} catch {}

	const abortController = new AbortController();
	const handleClose = () => abortController.abort();
	req.on("close", handleClose);
	req.on("aborted", handleClose);

	const safeWrite = (event: string, data: Record<string, unknown>): void => {
		if (abortController.signal.aborted || res.writableEnded || res.finished) return;
		try {
			writeSseEvent(res, event, data);
		} catch {
			abortController.abort();
		}
	};

	const pingInterval = setInterval(() => {
		safeWrite("ping", { ts: Date.now() });
	}, 15000);

	safeWrite("start", {
		conversationId: parsed.data.conversationId,
		continuation: true,
	});

	let textChunks = 0;
	let reasoningChunks = 0;
	let toolCalls = 0;

	try {
		const result = await chatStream(
			{
				conversationId: parsed.data.conversationId,
				message: buildContinuePrompt(lastUserMessage),
				aiId: parsed.data.aiId,
				attachments: [],
				organizationId: session.activeOrganizationId,
				userId: user.id,
				uiLocale: req.cookies.DOKPLOY_LOCALE,
				persistUserMessage: false,
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
					safeWrite("tool-call", { toolCallId, toolName, arguments: args });
				},
				onToolResult: (toolCallId, toolName, resultPayload) => {
					safeWrite("tool-result", {
						toolCallId,
						toolName,
						result: resultPayload,
					});
				},
				onError: (error) => {
					safeWrite("stream-error", { error });
				},
			},
		);

		const messageId = result?.message?.messageId;
		console.log(
			`[AI Continue] Completed: ${textChunks} text chunks, ${reasoningChunks} reasoning chunks, ${toolCalls} tool calls, message: ${messageId ?? ""}`,
		);

		safeWrite("done", {
			conversationId: parsed.data.conversationId,
			messageId: messageId ?? "",
			usage: result.usage,
			needsContinue: (result as any)?.needsContinue === true,
			finishReason: (result as any)?.finishReason ?? "",
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
