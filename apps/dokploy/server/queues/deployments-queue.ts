import {
	deployApplication,
	deployCompose,
	deployPreviewApplication,
	IS_CLOUD,
	rebuildApplication,
	rebuildCompose,
	rebuildPreviewApplication,
	updateApplicationStatus,
	updateCompose,
	updatePreviewDeployment,
} from "@dokploy/server";
import { type Job, Worker } from "bullmq";
import type { DeploymentJob } from "./queue-types";
import { redisConfig } from "./redis-connection";

type DeploymentWorkerLike = Pick<Worker<DeploymentJob>, "run" | "close"> & {
	cancelJob: (jobId: string) => Promise<void>;
	cancelAllJobs: (reason?: string) => Promise<void>;
};

const createDeploymentWorker = () =>
	new Worker(
		"deployments",
		async (job: Job<DeploymentJob>) => {
			try {
				if (job.data.applicationType === "application") {
					await updateApplicationStatus(job.data.applicationId, "running");

					if (job.data.type === "redeploy") {
						await rebuildApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					} else if (job.data.type === "deploy") {
						await deployApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					}
				} else if (job.data.applicationType === "compose") {
					await updateCompose(job.data.composeId, {
						composeStatus: "running",
					});
					if (job.data.type === "deploy") {
						await deployCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					} else if (job.data.type === "redeploy") {
						await rebuildCompose({
							composeId: job.data.composeId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
						});
					}
				} else if (job.data.applicationType === "application-preview") {
					await updatePreviewDeployment(job.data.previewDeploymentId, {
						previewStatus: "running",
					});

					if (job.data.type === "redeploy") {
						await rebuildPreviewApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							previewDeploymentId: job.data.previewDeploymentId,
						});
					} else if (job.data.type === "deploy") {
						await deployPreviewApplication({
							applicationId: job.data.applicationId,
							titleLog: job.data.titleLog,
							descriptionLog: job.data.descriptionLog,
							previewDeploymentId: job.data.previewDeploymentId,
						});
					}
				}
			} catch (error) {
				console.log("Error", error);
			}
		},
		{
			autorun: false,
			connection: redisConfig,
			prefix: process.env.BULLMQ_PREFIX || undefined,
		},
	);

const noopWorker = {
	run: () => Promise.resolve(),
	close: () => Promise.resolve(),
	cancelJob: () => Promise.resolve(),
	cancelAllJobs: () => Promise.resolve(),
};

let workerInstance: DeploymentWorkerLike | null = null;

const getDeploymentWorker = (): DeploymentWorkerLike => {
	if (IS_CLOUD) {
		return noopWorker;
	}

	if (!workerInstance) {
		workerInstance =
			createDeploymentWorker() as unknown as DeploymentWorkerLike;
	}

	return workerInstance;
};

export const deploymentWorker: DeploymentWorkerLike = {
	run: () => getDeploymentWorker().run(),
	close: () => getDeploymentWorker().close(),
	cancelJob: (jobId: string) => getDeploymentWorker().cancelJob(jobId),
	cancelAllJobs: (reason?: string) =>
		getDeploymentWorker().cancelAllJobs(reason),
};
