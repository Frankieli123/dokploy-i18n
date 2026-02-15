import { IS_CLOUD } from "@dokploy/server";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import { deploymentWorker } from "./deployments-queue";
import { redisConfig } from "./redis-connection";

const createNoopQueue = () => ({
	name: "deployments",
	getJobs: () => Promise.resolve([] as Job[]),
	getJobCounts: () => Promise.resolve({}),
	add: () =>
		Promise.resolve({ id: "noop", remove: () => Promise.resolve() } as Job),
	close: () => Promise.resolve(),
	on: () => {},
});

const myQueue = !IS_CLOUD
	? new Queue("deployments", {
			connection: redisConfig,
			prefix: process.env.BULLMQ_PREFIX || undefined,
		})
	: (createNoopQueue() as unknown as Queue);

if (!IS_CLOUD) {
	process.on("SIGTERM", () => {
		myQueue.close();
		process.exit(0);
	});

	myQueue.on("error", (error) => {
		if ((error as any).code === "ECONNREFUSED") {
			console.error(
				"Make sure you have installed Redis and it is running.",
				error,
			);
		}
	});
}

export const cleanQueuesByApplication = async (applicationId: string) => {
	const jobs = await myQueue.getJobs(["waiting", "delayed"]);

	for (const job of jobs) {
		if (job?.data?.applicationId === applicationId) {
			await job.remove();
			console.log(`Removed job ${job.id} for application ${applicationId}`);
		}
	}
};

export const cleanQueuesByCompose = async (composeId: string) => {
	const jobs = await myQueue.getJobs(["waiting", "delayed"]);

	for (const job of jobs) {
		if (job?.data?.composeId === composeId) {
			await job.remove();
			console.log(`Removed job ${job.id} for compose ${composeId}`);
		}
	}
};

export const cleanAllDeploymentQueue = async () => {
	const worker = deploymentWorker as unknown as {
		cancelAllJobs?: (reason?: string) => Promise<void>;
	};
	if (typeof worker.cancelAllJobs === "function") {
		await worker.cancelAllJobs("User requested cancellation");
	}

	const jobs = await myQueue.getJobs(["waiting", "delayed"]);
	for (const job of jobs) {
		await job.remove();
	}

	return true;
};

export const killDockerBuild = async (
	type: "application" | "compose",
	serverId: string | null,
) => {
	try {
		if (type === "application") {
			const command = `pkill -2 -f "docker build"`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		} else if (type === "compose") {
			const command = `pkill -2 -f "docker compose"`;

			if (serverId) {
				await execAsyncRemote(serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		console.error(error);
	}
};

export { myQueue };
