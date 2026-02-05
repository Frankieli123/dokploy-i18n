import { describe, expect, it, vi } from "vitest";
import { initializeTools, toolRegistry } from "@dokploy/server/services/ai-tools";
import { setTrpcBridge, type TrpcBridge } from "@dokploy/server/services/ai/trpc-bridge";

describe("ai-tools: project_containers", () => {
	it("does not imply no containers when project has no appName services", async () => {
		const calls: Array<{ procedureName: string; input: unknown }> = [];
		const bridge: TrpcBridge = {
			listRouters: () => [],
			searchProcedures: () => [],
			describeProcedure: () => ({
				name: "noop",
				type: "unknown",
				inputExample: null,
			}),
			callProcedure: vi.fn(async ({ procedureName, input }) => {
				calls.push({ procedureName, input });
				if (procedureName === "project.one") {
					return {
						projectId: "p1",
						name: "Project 1",
						environments: [
							{
								environmentId: "env1",
								name: "production",
								applications: [],
								compose: [],
								postgres: [],
								mysql: [],
								mariadb: [],
								mongo: [],
								redis: [],
							},
						],
					};
				}
				if (procedureName === "docker.getContainers") {
					return [
						{
							containerId: "c1",
							name: "random_container",
							image: "nginx:latest",
							state: "running",
							status: "Up",
							ports: "80/tcp",
						},
					];
				}
				throw new Error(`Unexpected procedure: ${procedureName}`);
			}),
		};

		setTrpcBridge(bridge);
		initializeTools();

		const tool = toolRegistry.get("project_containers");
		expect(tool).toBeTruthy();

		const res = await tool!.execute(
			{ includeUnmatched: false, limitPerServer: 10 },
			{ organizationId: "org", userId: "user", projectId: "p1" },
		);

		expect(res.success).toBe(true);
		expect(res.message.toLowerCase()).toContain("does not mean");
		expect(res.data).toMatchObject({
			project: { projectId: "p1", name: "Project 1" },
			servers: [],
		});

		expect(calls.some((c) => c.procedureName === "docker.getContainers")).toBe(
			false,
		);
	});

	it("can list unmatched containers from server context when includeUnmatched=true", async () => {
		const calls: Array<{ procedureName: string; input: unknown }> = [];
		const bridge: TrpcBridge = {
			listRouters: () => [],
			searchProcedures: () => [],
			describeProcedure: () => ({
				name: "noop",
				type: "unknown",
				inputExample: null,
			}),
			callProcedure: vi.fn(async ({ procedureName, input }) => {
				calls.push({ procedureName, input });
				if (procedureName === "project.one") {
					return {
						projectId: "p1",
						name: "Project 1",
						environments: [{ environmentId: "env1", name: "production" }],
					};
				}
				if (procedureName === "docker.getContainers") {
					return [
						{
							containerId: "c1",
							name: "random_container",
							image: "nginx:latest",
							state: "running",
							status: "Up",
							ports: "80/tcp",
						},
						{
							containerId: "c2",
							name: "another",
							image: "redis:7",
							state: "exited",
							status: "Exited",
							ports: "",
						},
					];
				}
				throw new Error(`Unexpected procedure: ${procedureName}`);
			}),
		};

		setTrpcBridge(bridge);
		initializeTools();

		const tool = toolRegistry.get("project_containers");
		expect(tool).toBeTruthy();

		const res = await tool!.execute(
			{ includeUnmatched: true, limitPerServer: 1 },
			{
				organizationId: "org",
				userId: "user",
				projectId: "p1",
				serverId: "srv1",
			},
		);

		expect(res.success).toBe(true);
		expect(res.data).toMatchObject({
			project: { projectId: "p1", name: "Project 1" },
			servers: [
				{
					serverId: "srv1",
					containers: [
						{
							containerId: "c1",
							name: "random_container",
							matchedService: undefined,
						},
					],
				},
			],
		});

		const dockerCall = calls.find((c) => c.procedureName === "docker.getContainers");
		expect(dockerCall).toBeTruthy();
		expect(dockerCall!.input).toEqual({ serverId: "srv1" });
	});

	it("matches containers by service appName when services exist", async () => {
		const calls: Array<{ procedureName: string; input: unknown }> = [];
		const bridge: TrpcBridge = {
			listRouters: () => [],
			searchProcedures: () => [],
			describeProcedure: () => ({
				name: "noop",
				type: "unknown",
				inputExample: null,
			}),
			callProcedure: vi.fn(async ({ procedureName, input }) => {
				calls.push({ procedureName, input });
				if (procedureName === "project.one") {
					return {
						projectId: "p1",
						name: "Project 1",
						environments: [
							{
								environmentId: "env1",
								name: "production",
								applications: [
									{
										applicationId: "app1",
										name: "Frontend",
										appName: "myapp",
										serverId: "srv1",
									},
								],
								compose: [],
								postgres: [],
								mysql: [],
								mariadb: [],
								mongo: [],
								redis: [],
							},
						],
					};
				}
				if (procedureName === "docker.getContainers") {
					return [
						{
							containerId: "c1",
							name: "myapp_web_1",
							image: "nginx:latest",
							state: "running",
							status: "Up",
							ports: "80/tcp",
						},
						{
							containerId: "c2",
							name: "unrelated",
							image: "busybox",
							state: "running",
							status: "Up",
							ports: "",
						},
					];
				}
				throw new Error(`Unexpected procedure: ${procedureName}`);
			}),
		};

		setTrpcBridge(bridge);
		initializeTools();

		const tool = toolRegistry.get("project_containers");
		expect(tool).toBeTruthy();

		const res = await tool!.execute(
			{ includeUnmatched: false, limitPerServer: 10 },
			{ organizationId: "org", userId: "user", projectId: "p1" },
		);

		expect(res.success).toBe(true);
		expect(res.message).toContain('Loaded containers for project "Project 1"');
		expect(res.data).toMatchObject({
			project: { projectId: "p1", name: "Project 1" },
			servers: [
				{
					serverId: "srv1",
					containers: [
						{
							containerId: "c1",
							name: "myapp_web_1",
							matchedService: {
								serviceType: "application",
								serviceId: "app1",
								name: "Frontend",
								appName: "myapp",
							},
						},
					],
				},
			],
		});

		const dockerCall = calls.find((c) => c.procedureName === "docker.getContainers");
		expect(dockerCall).toBeTruthy();
		expect(dockerCall!.input).toEqual({ serverId: "srv1" });
	});
});
