import http from "node:http";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	IS_CLOUD,
	initCancelDeployments,
	initCronJobs,
	initializeNetwork,
	initSchedules,
	initVolumeBackupsCronJobs,
	sendDokployRestartNotifications,
	setupDirectories,
} from "@dokploy/server";
import { warmupAi } from "@dokploy/server/services/ai";
import { config } from "dotenv";
import next from "next";
import { ensureAiChatPerformanceIndexes } from "@/server/db/ai-indexes";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupTerminalWebSocketServer } from "./wss/terminal";

config({ path: ".env" });
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, turbopack: process.env.TURBOPACK === "1" });
const handle = app.getRequestHandler();
void app
	.prepare()
	.then(async () => {
		try {
			const server = http.createServer((req, res) => {
				handle(req, res);
			});

			setupDrawerLogsWebSocketServer(server);
			setupDeploymentLogsWebSocketServer(server);
			setupDockerContainerLogsWebSocketServer(server);
			setupDockerContainerTerminalWebSocketServer(server);
			setupTerminalWebSocketServer(server);
			if (!IS_CLOUD) {
				setupDockerStatsMonitoringSocketServer(server);
			}

			if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
				setupDirectories();
				createDefaultMiddlewares();
				await initializeNetwork();
				createDefaultTraefikConfig();
				createDefaultServerTraefikConfig();
				void ensureAiChatPerformanceIndexes();
				await initCronJobs();
				await initSchedules();
				await initCancelDeployments();
				await initVolumeBackupsCronJobs();
				await sendDokployRestartNotifications();
			}

			if (IS_CLOUD && process.env.NODE_ENV === "production") {
				void ensureAiChatPerformanceIndexes();
			}

			server.listen(PORT, HOST);
			console.log(`Server Started on: http://${HOST}:${PORT}`);
			void warmupAi();
			if (!IS_CLOUD) {
				console.log("Starting Deployment Worker");
				const { deploymentWorker } = await import("./queues/deployments-queue");
				await deploymentWorker.run();
			}
		} catch (e) {
			console.error("Main Server Error", e);
			process.exit(1);
		}
	})
	.catch((e) => {
		console.error("app.prepare failed", e);
		process.exit(1);
	});
