import { IS_CLOUD } from "@dokploy/server";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import type { Job } from "bullmq";
import { Queue } from "bullmq";
import { redisConfig } from "./redis-connection";

type QueueLike = {
	name: string;
	getJobs: (...args: any[]) => Promise<Job[]>;
	getJobCounts: (...args: any[]) => Promise<Record<string, number>>;
	add: (...args: any[]) => Promise<Job>;
	close: () => Promise<void>;
	on: (...args: any[]) => QueueLike;
};

const noopQueue: QueueLike = {
	name: "deployments",
	getJobs: () => Promise.resolve([] as Job[]),
	getJobCounts: () => Promise.resolve({} as Record<string, number>),
	add: () =>
		Promise.resolve({ id: "noop", remove: () => Promise.resolve() } as Job),
	close: () => Promise.resolve(),
	on: (..._args: any[]) => noopQueue,
};

let queueInstance: QueueLike | null = null;

const createQueue = (): QueueLike =>
	new Queue("deployments", {
		connection: redisConfig,
		prefix: process.env.BULLMQ_PREFIX || undefined,
	});

const getQueue = (): QueueLike => {
	if (IS_CLOUD) {
		return noopQueue;
	}

	if (!queueInstance) {
		queueInstance = createQueue();
		process.once("SIGTERM", () => {
			void queueInstance?.close();
			process.exit(0);
		});
		queueInstance.on("error", (error: unknown) => {
			if ((error as any).code === "ECONNREFUSED") {
				console.error(
					"Make sure you have installed Redis and it is running.",
					error,
				);
			}
		});
	}

	return queueInstance;
};

const myQueue: QueueLike = {
	name: "deployments",
	getJobs: (...args) => getQueue().getJobs(...args),
	getJobCounts: (...args) => getQueue().getJobCounts(...args),
	add: (...args) => getQueue().add(...args),
	close: () => getQueue().close(),
	on: (...args) => getQueue().on(...args),
};

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
	const { deploymentWorker } = await import("./deployments-queue");
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
