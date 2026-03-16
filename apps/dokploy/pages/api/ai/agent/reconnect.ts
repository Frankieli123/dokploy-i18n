import { validateRequest } from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { aiMessages, aiRuns } from "@dokploy/server/db/schema";
import { getConversationById } from "@dokploy/server/services/ai";
import { and, asc, eq, gte } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";

const bodySchema = z.object({
	conversationId: z.string().min(1),
	runId: z.string().min(1),
});

function writeSseEvent(res: NextApiResponse, event: string, data: unknown) {
	if (res.writableEnded || res.finished) return;
	try {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
		try {
			(res as any).flush?.();
		} catch {}
	} catch {
		// ignore
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
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

	const conversationId = parsed.data.conversationId;
	const runId = parsed.data.runId.trim();

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

	const run = await db.query.aiRuns.findFirst({
		where: eq(aiRuns.runId, runId),
		columns: {
			runId: true,
			conversationId: true,
			status: true,
			createdAt: true,
			startedAt: true,
			completedAt: true,
		},
	});
	if (!run || run.conversationId !== conversationId) {
		res.status(404).json({ message: "Run not found" });
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
		// Helps bypass proxy buffering so agent events are visible during streaming.
		res.write(`:${" ".repeat(2048)}\n\n`);
	} catch {}

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

	const assistantMessageId = `agent-run-${runId}`;
	const runStartMs = Date.parse(run.startedAt ?? run.createdAt ?? "");
	const baseStartMs = Number.isFinite(runStartMs) ? runStartMs : Date.now();
	const cursorStartMs = Math.max(baseStartMs - 5 * 60 * 1000, Date.now() - 30 * 60 * 1000);

	let cursorCreatedAt = new Date(cursorStartMs).toISOString();
	const seenMessageIds = new Set<string>();
	let pollDelay = 800;

	try {
		writeSseEvent(res, "start", { conversationId, runId, assistantMessageId });

		if (
			run.completedAt ||
			run.status === "completed" ||
			run.status === "failed" ||
			run.status === "cancelled"
		) {
			writeSseEvent(res, "done", { conversationId, runId });
			return;
		}

		while (!abortController.signal.aborted) {
			let sawRunFinish = false;
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

				const payloadRunId = typeof payload.runId === "string" ? payload.runId : "";
				if (payloadRunId.trim().length > 0 && payloadRunId.trim() !== runId) continue;

				writeSseEvent(res, type, {
					messageId: msg.messageId,
					createdAt: msg.createdAt,
					payload,
				});

				if (type === "agent.run.finish") {
					sawRunFinish = true;
				}
			}

			if (sawRunFinish) {
				writeSseEvent(res, "done", { conversationId, runId });
				return;
			}

			pollDelay = sawNewMessage ? 800 : Math.min(Math.round(pollDelay * 1.5), 4000);
			await sleep(pollDelay, abortController.signal);
		}
	} catch (error) {
		if (!abortController.signal.aborted) {
			writeSseEvent(res, "error", {
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
