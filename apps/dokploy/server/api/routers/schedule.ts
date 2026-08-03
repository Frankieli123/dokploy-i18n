import {
	checkServiceAccess,
	findServerById,
	IS_CLOUD,
	removeScheduleJob,
	scheduleJob,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema/deployment";
import {
	createScheduleSchema,
	schedules,
	updateScheduleSchema,
} from "@dokploy/server/db/schema/schedule";
import { runCommand } from "@dokploy/server/index";
import {
	createSchedule,
	deleteSchedule,
	findScheduleById,
	updateSchedule,
} from "@dokploy/server/services/schedule";
import {
	checkPermission,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { removeJob, schedule } from "@/server/utils/backup";
import { createTRPCRouter, protectedProcedure } from "../trpc";

type ScheduleAction = "read" | "create" | "update" | "delete";
type ScheduleContext = {
	user: { id: string };
	session: { activeOrganizationId: string };
};

const assertHostScheduleAccess = async (
	ctx: ScheduleContext,
	scheduleType: "application" | "compose" | "server" | "dokploy-server",
	serverId?: string | null,
) => {
	if (scheduleType === "server") {
		if (!serverId) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Server is required",
			});
		}
		const targetServer = await findServerById(serverId);
		if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this server",
			});
		}
	}

	if (scheduleType === "dokploy-server") {
		const member = await findMemberByUserId(
			ctx.user.id,
			ctx.session.activeOrganizationId,
		);
		if (member.role !== "owner" && member.role !== "admin") {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Only owners and admins can manage host schedules",
			});
		}
	}
};

const assertScheduleAccess = async (
	ctx: ScheduleContext,
	scheduleItem: Awaited<ReturnType<typeof findScheduleById>>,
	action: ScheduleAction,
) => {
	await checkPermission(ctx, { schedule: [action] });
	const serviceId = scheduleItem.applicationId || scheduleItem.composeId;
	if (serviceId) {
		await checkServiceAccess(
			ctx.user.id,
			serviceId,
			ctx.session.activeOrganizationId,
			"access",
		);
		return;
	}
	await assertHostScheduleAccess(
		ctx,
		scheduleItem.scheduleType,
		scheduleItem.serverId,
	);
};

export const scheduleRouter = createTRPCRouter({
	create: protectedProcedure
		.input(createScheduleSchema)
		.mutation(async ({ input, ctx }) => {
			await checkPermission(ctx, { schedule: ["create"] });
			const scheduleType = input.scheduleType ?? "application";
			const serviceId =
				scheduleType === "application"
					? input.applicationId
					: scheduleType === "compose"
						? input.composeId
						: null;
			if (scheduleType === "application" || scheduleType === "compose") {
				if (!serviceId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Service is required",
					});
				}
				await checkServiceAccess(
					ctx.user.id,
					serviceId,
					ctx.session.activeOrganizationId,
					"access",
				);
			} else {
				await assertHostScheduleAccess(ctx, scheduleType, input.serverId);
			}
			const newSchedule = await createSchedule({
				...input,
				scheduleType,
				applicationId:
					scheduleType === "application" ? input.applicationId : null,
				composeId: scheduleType === "compose" ? input.composeId : null,
				serverId: scheduleType === "server" ? input.serverId : null,
				userId: scheduleType === "dokploy-server" ? ctx.user.id : null,
			});

			if (newSchedule?.enabled) {
				if (IS_CLOUD) {
					schedule({
						scheduleId: newSchedule.scheduleId,
						type: "schedule",
						cronSchedule: newSchedule.cronExpression,
					});
				} else {
					scheduleJob(newSchedule);
				}
			}
			return newSchedule;
		}),

	update: protectedProcedure
		.input(updateScheduleSchema)
		.mutation(async ({ input, ctx }) => {
			const existingSchedule = await findScheduleById(input.scheduleId);
			await assertScheduleAccess(ctx, existingSchedule, "update");
			const immutableTargets = [
				["scheduleType", input.scheduleType, existingSchedule.scheduleType],
				["applicationId", input.applicationId, existingSchedule.applicationId],
				["composeId", input.composeId, existingSchedule.composeId],
				["serverId", input.serverId, existingSchedule.serverId],
				["userId", input.userId, existingSchedule.userId],
			] as const;
			for (const [field, nextValue, currentValue] of immutableTargets) {
				if (nextValue !== undefined && nextValue !== currentValue) {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: `Changing ${field} is not allowed`,
					});
				}
			}
			const updatedSchedule = await updateSchedule(input);

			if (IS_CLOUD) {
				if (updatedSchedule?.enabled) {
					schedule({
						scheduleId: updatedSchedule.scheduleId,
						type: "schedule",
						cronSchedule: updatedSchedule.cronExpression,
					});
				} else {
					await removeJob({
						cronSchedule: updatedSchedule.cronExpression,
						scheduleId: updatedSchedule.scheduleId,
						type: "schedule",
					});
				}
			} else {
				if (updatedSchedule?.enabled) {
					removeScheduleJob(updatedSchedule.scheduleId);
					scheduleJob(updatedSchedule);
				} else {
					removeScheduleJob(updatedSchedule.scheduleId);
				}
			}
			return updatedSchedule;
		}),

	delete: protectedProcedure
		.input(z.object({ scheduleId: z.string() }))
		.mutation(async ({ input, ctx }) => {
			const schedule = await findScheduleById(input.scheduleId);
			await assertScheduleAccess(ctx, schedule, "delete");
			await deleteSchedule(input.scheduleId);

			if (IS_CLOUD) {
				await removeJob({
					cronSchedule: schedule.cronExpression,
					scheduleId: schedule.scheduleId,
					type: "schedule",
				});
			} else {
				removeScheduleJob(schedule.scheduleId);
			}
			return true;
		}),

	list: protectedProcedure
		.input(
			z.object({
				id: z.string(),
				scheduleType: z.enum([
					"application",
					"compose",
					"server",
					"dokploy-server",
				]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { schedule: ["read"] });
			if (
				input.scheduleType === "application" ||
				input.scheduleType === "compose"
			) {
				await checkServiceAccess(
					ctx.user.id,
					input.id,
					ctx.session.activeOrganizationId,
					"access",
				);
			} else {
				await assertHostScheduleAccess(
					ctx,
					input.scheduleType,
					input.scheduleType === "server" ? input.id : null,
				);
			}
			const where = {
				application: eq(schedules.applicationId, input.id),
				compose: eq(schedules.composeId, input.id),
				server: eq(schedules.serverId, input.id),
				"dokploy-server": eq(schedules.userId, ctx.user.id),
			};
			return db.query.schedules.findMany({
				where: where[input.scheduleType],
				with: {
					application: true,
					server: true,
					compose: true,
					deployments: {
						orderBy: [desc(deployments.createdAt)],
					},
				},
			});
		}),

	one: protectedProcedure
		.input(z.object({ scheduleId: z.string() }))
		.query(async ({ input, ctx }) => {
			const schedule = await findScheduleById(input.scheduleId);
			await assertScheduleAccess(ctx, schedule, "read");
			return schedule;
		}),

	runManually: protectedProcedure
		.input(z.object({ scheduleId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const scheduleItem = await findScheduleById(input.scheduleId);
			await assertScheduleAccess(ctx, scheduleItem, "create");
			try {
				await runCommand(input.scheduleId);
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						error instanceof Error ? error.message : "Error running schedule",
				});
			}
		}),
});
