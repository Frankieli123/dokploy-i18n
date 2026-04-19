import {
	cleanPatchRepos,
	createPatch,
	deletePatch,
	ensurePatchRepo,
	findApplicationById,
	findComposeById,
	findPatchByFilePath,
	findPatchById,
	findPatchesByEntityId,
	getPatchRepoContext,
	markPatchForDeletion,
	readPatchRepoDirectory,
	readPatchRepoFile,
	updatePatch,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import {
	apiCreatePatch,
	apiDeletePatch,
	apiFindPatch,
	apiFindPatchesByEntityId,
	apiTogglePatchEnabled,
	apiUpdatePatch,
} from "@/server/db/schema";

const resolveEntity = async (
	id: string,
	type: "application" | "compose",
	ctx: {
		session: { activeOrganizationId: string };
		user: { id: string; role: string };
	},
) => {
	if (type === "application") {
		const app = await findApplicationById(id);
		if (app.environment.project.organizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to access this application",
			});
		}
		await checkServicePermissionAndAccess(ctx, id, {
			service: ["read"],
		});
		return {
			entity: app,
			serverId: app.buildServerId || app.serverId,
		};
	}

	const compose = await findComposeById(id);
	if (
		compose.environment.project.organizationId !== ctx.session.activeOrganizationId
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this compose",
		});
	}
	await checkServicePermissionAndAccess(ctx, id, {
		service: ["read"],
	});
	return {
		entity: compose,
		serverId: compose.serverId,
	};
};

const resolvePatchContext = async (
	patchId: string,
	ctx: {
		session: { activeOrganizationId: string };
		user: { id: string; role: string };
	},
) => {
	const currentPatch = await findPatchById(patchId);
	if (currentPatch.applicationId) {
		await resolveEntity(currentPatch.applicationId, "application", ctx);
		return {
			patch: currentPatch,
			entityId: currentPatch.applicationId,
			entityType: "application" as const,
		};
	}
	if (currentPatch.composeId) {
		await resolveEntity(currentPatch.composeId, "compose", ctx);
		return {
			patch: currentPatch,
			entityId: currentPatch.composeId,
			entityType: "compose" as const,
		};
	}

	throw new TRPCError({
		code: "BAD_REQUEST",
		message: "Patch is not attached to a supported entity",
	});
};

export const patchRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreatePatch)
		.mutation(async ({ input, ctx }) => {
			if (input.applicationId) {
				await checkServicePermissionAndAccess(ctx, input.applicationId, {
					service: ["create"],
				});
				await getPatchRepoContext({
					type: "application",
					id: input.applicationId,
				});
			} else if (input.composeId) {
				await checkServicePermissionAndAccess(ctx, input.composeId, {
					service: ["create"],
				});
				await getPatchRepoContext({
					type: "compose",
					id: input.composeId,
				});
			} else {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Either applicationId or composeId must be provided",
				});
			}

			const result = await createPatch(input);
			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceId: result.patchId,
				resourceName: result.filePath,
				metadata: { type: "patch" },
			});
			return result;
		}),

	one: protectedProcedure.input(apiFindPatch).query(async ({ input, ctx }) => {
		const patch = await findPatchById(input.patchId);
		const serviceId = patch.applicationId ?? patch.composeId;
		if (!serviceId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Patch is not attached to a supported entity",
			});
		}
		await checkServicePermissionAndAccess(ctx, serviceId, {
			service: ["read"],
		});
		return patch;
	}),

	byEntityId: protectedProcedure
		.input(apiFindPatchesByEntityId)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["read"],
			});
			await resolveEntity(input.id, input.type, ctx);
			return await findPatchesByEntityId(input.id, input.type);
		}),

	update: protectedProcedure
		.input(apiUpdatePatch)
		.mutation(async ({ input, ctx }) => {
			const { patch } = await resolvePatchContext(input.patchId, ctx);
			const serviceId = patch.applicationId ?? patch.composeId;
			if (!serviceId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Patch is not attached to a supported entity",
				});
			}
			await checkServicePermissionAndAccess(ctx, serviceId, {
				service: ["create"],
			});
			const { patchId, ...data } = input;
			const result = await updatePatch(patchId, data);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: patchId,
				resourceName: patch.filePath,
				metadata: { type: "patch" },
			});
			return result;
		}),

	delete: protectedProcedure
		.input(apiDeletePatch)
		.mutation(async ({ input, ctx }) => {
			const { patch } = await resolvePatchContext(input.patchId, ctx);
			const serviceId = patch.applicationId ?? patch.composeId;
			if (!serviceId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Patch is not attached to a supported entity",
				});
			}
			await checkServicePermissionAndAccess(ctx, serviceId, {
				service: ["delete"],
			});
			const result = await deletePatch(input.patchId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.patchId,
				resourceName: patch.filePath,
				metadata: { type: "patch" },
			});
			return result;
		}),

	toggleEnabled: protectedProcedure
		.input(apiTogglePatchEnabled)
		.mutation(async ({ input, ctx }) => {
			const { patch } = await resolvePatchContext(input.patchId, ctx);
			const serviceId = patch.applicationId ?? patch.composeId;
			if (!serviceId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Patch is not attached to a supported entity",
				});
			}
			await checkServicePermissionAndAccess(ctx, serviceId, {
				service: ["create"],
			});
			const result = await updatePatch(input.patchId, { enabled: input.enabled });
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: input.patchId,
				resourceName: patch.filePath,
				metadata: { type: "patch", enabled: input.enabled },
			});
			return result;
		}),

	ensureRepo: protectedProcedure
		.input(apiFindPatchesByEntityId)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["create"],
			});
			await resolveEntity(input.id, input.type, ctx);
			const result = await ensurePatchRepo({
				type: input.type,
				id: input.id,
			});
			await audit(ctx, {
				action: "create",
				resourceType: "settings",
				resourceId: input.id,
				metadata: { type: "ensurePatchRepo", serviceType: input.type },
			});
			return result;
		}),

	readRepoDirectories: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				repoPath: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["read"],
			});
			await resolveEntity(input.id, input.type, ctx);
			const { repoPath, serverId } = await getPatchRepoContext({
				type: input.type,
				id: input.id,
			});
			return await readPatchRepoDirectory(repoPath, serverId);
		}),

	readRepoFile: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				filePath: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["read"],
			});
			await resolveEntity(input.id, input.type, ctx);
			await getPatchRepoContext({
				type: input.type,
				id: input.id,
			});
			const existingPatch = await findPatchByFilePath(
				input.filePath,
				input.id,
				input.type,
			);

			if (existingPatch?.type === "delete") {
				try {
					return await readPatchRepoFile(input.id, input.type, input.filePath);
				} catch {
					return "(File not found in repo - will be removed if it exists)";
				}
			}

			if (typeof existingPatch?.content === "string" && existingPatch.content) {
				return existingPatch.content;
			}

			return await readPatchRepoFile(input.id, input.type, input.filePath);
		}),

	saveFileAsPatch: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				filePath: z.string().min(1),
				content: z.string(),
				patchType: z.enum(["create", "update"]).default("update"),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["create"],
			});
			await resolveEntity(input.id, input.type, ctx);
			await getPatchRepoContext({
				type: input.type,
				id: input.id,
			});
			const existingPatch = await findPatchByFilePath(
				input.filePath,
				input.id,
				input.type,
			);

			if (!existingPatch) {
				const result = await createPatch({
					filePath: input.filePath,
					content: input.content,
					type: input.patchType,
					applicationId: input.type === "application" ? input.id : undefined,
					composeId: input.type === "compose" ? input.id : undefined,
				});
				await audit(ctx, {
					action: "create",
					resourceType: "settings",
					resourceId: result.patchId,
					resourceName: input.filePath,
					metadata: { type: "saveFileAsPatch" },
				});
				return result;
			}

			const result = await updatePatch(existingPatch.patchId, {
				content: input.content,
				type: input.patchType,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceId: existingPatch.patchId,
				resourceName: input.filePath,
				metadata: { type: "saveFileAsPatch" },
			});
			return result;
		}),

	markFileForDeletion: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				type: z.enum(["application", "compose"]),
				filePath: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				service: ["create"],
			});
			await resolveEntity(input.id, input.type, ctx);
			await getPatchRepoContext({
				type: input.type,
				id: input.id,
			});
			const result = await markPatchForDeletion(input.filePath, input.id, input.type);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.id,
				resourceName: input.filePath,
				metadata: { type: "markFileForDeletion" },
			});
			return result;
		}),

	cleanPatchRepos: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await cleanPatchRepos(input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.serverId || "local",
				metadata: { type: "cleanPatchRepos" },
			});
			return true;
		}),

	cleanRepos: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await cleanPatchRepos(input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceId: input.serverId || "local",
				metadata: { type: "cleanPatchRepos" },
			});
			return true;
		}),
});
