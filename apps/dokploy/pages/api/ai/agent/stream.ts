import { validateRequest } from "@dokploy/server";
import { apiStartAgent } from "@dokploy/server/db/schema/ai";
import { db } from "@dokploy/server/db";
import { aiMessages } from "@dokploy/server/db/schema";
import {
	getConversationById,
	startAgentRun,
} from "@dokploy/server/services/ai";
import { and, asc, eq, gte } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

const bodySchema = apiStartAgent;

function writeSseEvent(res: NextApiResponse, event: string, data: unknown) {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("aborted"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
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

	const conversationId = parsed.data.conversationId;
	try {
		const conversation = await getConversationById(conversationId);
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

	const pingInterval = setInterval(() => {
		try {
			writeSseEvent(res, "ping", { ts: Date.now() });
		} catch {
			abortController.abort();
		}
	}, 15000);

	const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
	let cursorCreatedAt = startedAt;
	const seenMessageIds = new Set<string>();

	let runId = "";
	let runFinishedAtMs: number | null = null;
	let pollDelay = 800;

	try {
		const run = await startAgentRun({
			conversationId,
			goal: parsed.data.goal,
			aiId: parsed.data.aiId,
			attachments: parsed.data.attachments,
			organizationId: session.activeOrganizationId,
			userId: user.id,
			uiLocale: req.cookies.DOKPLOY_LOCALE,
		});
		runId = typeof run?.runId === "string" ? run.runId : "";

		while (!abortController.signal.aborted) {
			const messages = await db.query.aiMessages.findMany({
				where: and(
					eq(aiMessages.conversationId, conversationId),
					gte(aiMessages.createdAt, cursorCreatedAt),
				),
				orderBy: [asc(aiMessages.createdAt)],
				limit: 50,
			});

			let sawNewMessage = false;
			for (const msg of messages) {
				if (seenMessageIds.has(msg.messageId)) continue;
				seenMessageIds.add(msg.messageId);
				cursorCreatedAt = msg.createdAt;
				sawNewMessage = true;

				const rawContent = typeof msg.content === "string" ? msg.content : "";
				let payload: unknown = null;
				try {
					payload = JSON.parse(rawContent);
				} catch {
					continue;
				}

				if (!isRecord(payload)) continue;
				const type = typeof payload.type === "string" ? payload.type : "";
				if (!type.startsWith("agent.")) continue;

				const payloadRunId =
					type === "agent.run.start" && typeof payload.runId === "string"
						? payload.runId
						: typeof payload.runId === "string"
							? payload.runId
							: "";
				if (!runId && payloadRunId) runId = payloadRunId;
				if (runId && payloadRunId && payloadRunId !== runId) continue;

				writeSseEvent(res, type, {
					messageId: msg.messageId,
					createdAt: msg.createdAt,
					payload,
				});

				if (type === "agent.run.finish") {
					runFinishedAtMs = Date.now();
				}
				if (type === "agent.run.summary") {
					writeSseEvent(res, "done", { conversationId, runId });
					return;
				}
			}

			pollDelay = sawNewMessage ? 800 : Math.min(Math.round(pollDelay * 1.5), 4000);

			if (runFinishedAtMs && Date.now() - runFinishedAtMs > 5000) {
				writeSseEvent(res, "done", { conversationId, runId });
				return;
			}

			await sleep(pollDelay, abortController.signal);
		}
	} catch (error) {
		writeSseEvent(res, "error", {
			message: error instanceof Error ? error.message : String(error),
		});
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
