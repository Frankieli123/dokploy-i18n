import { buildAgentDisplayMessageFromEvents } from "@dokploy/server/services/ai/agent-display-replay";
import { describe, expect, it } from "vitest";

describe("agent display message replay", () => {
	it("rebuilds a pending tool card from approval events", () => {
		const replayed = buildAgentDisplayMessageFromEvents({
			baseMessage: {
				messageId: "agent-run-run_pending",
				runId: "run_pending",
				content: null,
				toolCalls: null,
				status: "sending",
			},
			sourceMessageId: "agent-run-run_pending",
			eventMessages: [
				{
					messageId: "evt-1",
					createdAt: "2026-03-08T10:00:00.000Z",
					payload: {
						type: "agent.step.wait_approval",
						runId: "run_pending",
						stepId: "step-1",
						executionId: "exec-1",
						toolName: "deploy_app",
						parametersPreview: '{"appId":"app-1"}',
					},
				},
			],
		});

		expect(replayed).toMatchObject({
			sourceMessageId: "agent-run-run_pending",
			status: "sending",
			error: null,
		});
		expect(replayed?.toolCalls).toEqual([
			{
				id: "exec-1",
				type: "function",
				executionId: "exec-1",
				status: "pending",
				function: {
					name: "deploy_app",
					arguments: '{"appId":"app-1"}',
				},
			},
		]);
	});

	it("rebuilds completed tool cards and final content from run events", () => {
		const replayed = buildAgentDisplayMessageFromEvents({
			baseMessage: {
				messageId: "agent-run-run_done",
				runId: "run_done",
				content: null,
				reasoning: null,
				toolCalls: null,
				status: "sending",
			},
			sourceMessageId: "agent-run-run_done",
			eventMessages: [
				{
					messageId: "evt-3",
					createdAt: "2026-03-08T10:00:03.000Z",
					payload: {
						type: "agent.step.result",
						runId: "run_done",
						executionId: "exec-2",
						toolName: "fetch_logs",
						success: true,
						summary: "Fetched logs",
						dataPreview: '{"lines":12}',
					},
				},
				{
					messageId: "evt-1",
					createdAt: "2026-03-08T10:00:01.000Z",
					payload: {
						type: "agent.output.delta",
						runId: "run_done",
						delta: "Hello",
					},
				},
				{
					messageId: "evt-4",
					createdAt: "2026-03-08T10:00:04.000Z",
					payload: {
						type: "agent.run.finish",
						runId: "run_done",
						status: "completed",
					},
				},
				{
					messageId: "evt-2",
					createdAt: "2026-03-08T10:00:02.000Z",
					payload: {
						type: "agent.output.delta",
						runId: "run_done",
						delta: "Hello world",
					},
				},
				{
					messageId: "evt-0",
					createdAt: "2026-03-08T10:00:00.000Z",
					payload: {
						type: "agent.output.reasoning",
						runId: "run_done",
						text: "Thinking",
					},
				},
				{
					messageId: "evt-2b",
					createdAt: "2026-03-08T10:00:02.500Z",
					payload: {
						type: "agent.step.start",
						runId: "run_done",
						executionId: "exec-2",
						toolName: "fetch_logs",
						parametersPreview: '{"service":"dokploy"}',
					},
				},
			],
		});

		expect(replayed).toMatchObject({
			content: "Hello world",
			reasoning: "Thinking",
			status: "sent",
			error: null,
		});
		expect(replayed?.toolCalls).toEqual([
			{
				id: "exec-2",
				type: "function",
				executionId: "exec-2",
				status: "completed",
				result: {
					success: true,
					message: "Fetched logs",
					data: { lines: 12 },
				},
				function: {
					name: "fetch_logs",
					arguments: '{"service":"dokploy"}',
				},
			},
		]);
	});

	it("keeps failed tool state and run error", () => {
		const replayed = buildAgentDisplayMessageFromEvents({
			baseMessage: {
				messageId: "agent-run-run_fail",
				runId: "run_fail",
				content: null,
				toolCalls: null,
				status: "sending",
			},
			eventMessages: [
				{
					messageId: "evt-1",
					createdAt: "2026-03-08T10:00:01.000Z",
					payload: {
						type: "agent.step.start",
						runId: "run_fail",
						executionId: "exec-3",
						toolName: "restart_service",
						parametersPreview: '{"name":"dokploy"}',
					},
				},
				{
					messageId: "evt-2",
					createdAt: "2026-03-08T10:00:02.000Z",
					payload: {
						type: "agent.step.result",
						runId: "run_fail",
						executionId: "exec-3",
						toolName: "restart_service",
						success: false,
						summary: "permission denied",
						dataPreview: '"stderr"',
					},
				},
				{
					messageId: "evt-3",
					createdAt: "2026-03-08T10:00:03.000Z",
					payload: {
						type: "agent.run.finish",
						runId: "run_fail",
						status: "failed",
						error: "permission denied",
					},
				},
			],
		});

		expect(replayed).toMatchObject({
			status: "error",
			error: "permission denied",
		});
		expect(replayed?.toolCalls).toEqual([
			{
				id: "exec-3",
				type: "function",
				executionId: "exec-3",
				status: "failed",
				result: {
					success: false,
					message: "permission denied",
					data: "stderr",
					error: "permission denied",
				},
				function: {
					name: "restart_service",
					arguments: '{"name":"dokploy"}',
				},
			},
		]);
	});

	it("returns null when the base message has no runId", () => {
		expect(
			buildAgentDisplayMessageFromEvents({
				baseMessage: {
					messageId: "assistant-1",
					status: "sending",
				},
				eventMessages: [],
			}),
		).toBeNull();
	});
});
