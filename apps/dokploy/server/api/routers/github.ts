import {
	findGithubById,
	githubPublicRepoInfo,
	githubPublicRepoListPath,
	githubPublicRepoReadFile,
	getGithubBranches,
	getGithubRepositories,
	haveGithubRequirements,
	updateGithub,
	updateGitProvider,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { db } from "@/server/db";
import {
	apiFindGithubBranches,
	apiFindOneGithub,
	apiUpdateGithub,
} from "@/server/db/schema";

export const githubRouter = createTRPCRouter({
	one: protectedProcedure
		.input(apiFindOneGithub)
		.query(async ({ input, ctx }) => {
			const githubProvider = await findGithubById(input.githubId);
			if (
				githubProvider.gitProvider.organizationId !==
					ctx.session.activeOrganizationId &&
				githubProvider.gitProvider.userId === ctx.session.userId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this github provider",
				});
			}
			return githubProvider;
		}),
	publicRepoInfo: protectedProcedure
		.input(
			z.object({
				repo: z
					.string()
					.min(1)
					.describe("GitHub repository as owner/repo or a GitHub URL"),
			}),
		)
		.query(async ({ input }) => {
			return githubPublicRepoInfo({ repo: input.repo });
		}),
	publicRepoListPath: protectedProcedure
		.input(
			z.object({
				repo: z
					.string()
					.min(1)
					.describe("GitHub repository as owner/repo or a GitHub URL"),
				path: z
					.string()
					.optional()
					.default("")
					.describe('Path inside the repo ("" for root)'),
				ref: z
					.string()
					.optional()
					.describe("Optional branch, tag, or commit SHA"),
			}),
		)
		.query(async ({ input }) => {
			return githubPublicRepoListPath({
				repo: input.repo,
				path: input.path,
				ref: input.ref,
			});
		}),
	publicRepoReadFile: protectedProcedure
		.input(
			z.object({
				repo: z
					.string()
					.min(1)
					.describe("GitHub repository as owner/repo or a GitHub URL"),
				path: z.string().min(1).describe("File path inside the repo"),
				ref: z
					.string()
					.optional()
					.describe("Optional branch, tag, or commit SHA"),
				maxBytes: z
					.number()
					.min(1)
					.max(1_000_000)
					.optional()
					.default(250_000)
					.describe("Max bytes to return (prevents huge files)"),
			}),
		)
		.query(async ({ input }) => {
			return githubPublicRepoReadFile({
				repo: input.repo,
				path: input.path,
				ref: input.ref,
				maxBytes: input.maxBytes,
			});
		}),
	getGithubRepositories: protectedProcedure
		.input(apiFindOneGithub)
		.query(async ({ input, ctx }) => {
			const githubProvider = await findGithubById(input.githubId);
			if (
				githubProvider.gitProvider.organizationId !==
					ctx.session.activeOrganizationId &&
				githubProvider.gitProvider.userId === ctx.session.userId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this github provider",
				});
			}
			return await getGithubRepositories(input.githubId);
		}),
	getGithubBranches: protectedProcedure
		.input(apiFindGithubBranches)
		.query(async ({ input, ctx }) => {
			const githubProvider = await findGithubById(input.githubId || "");
			if (
				githubProvider.gitProvider.organizationId !==
					ctx.session.activeOrganizationId &&
				githubProvider.gitProvider.userId === ctx.session.userId
			) {
				//TODO: Remove this line when the cloud version is ready
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this github provider",
				});
			}
			return await getGithubBranches(input);
		}),
	githubProviders: protectedProcedure.query(async ({ ctx }) => {
		let result = await db.query.github.findMany({
			with: {
				gitProvider: true,
			},
		});

		result = result.filter(
			(provider) =>
				provider.gitProvider.organizationId ===
					ctx.session.activeOrganizationId &&
				provider.gitProvider.userId === ctx.session.userId,
		);

		const filtered = result
			.filter((provider) => haveGithubRequirements(provider))
			.map((provider) => {
				return {
					githubId: provider.githubId,
					gitProvider: {
						...provider.gitProvider,
					},
				};
			});

		return filtered;
	}),

	testConnection: protectedProcedure
		.input(apiFindOneGithub)
		.mutation(async ({ input, ctx }) => {
			try {
				const githubProvider = await findGithubById(input.githubId);
				if (
					githubProvider.gitProvider.organizationId !==
						ctx.session.activeOrganizationId &&
					githubProvider.gitProvider.userId === ctx.session.userId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not allowed to access this github provider",
					});
				}
				const result = await getGithubRepositories(input.githubId);
				return `Found ${result.length} repositories`;
			} catch (err) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: err instanceof Error ? err?.message : `Error: ${err}`,
				});
			}
		}),
	update: protectedProcedure
		.input(apiUpdateGithub)
		.mutation(async ({ input, ctx }) => {
			const githubProvider = await findGithubById(input.githubId);
			if (
				githubProvider.gitProvider.organizationId !==
					ctx.session.activeOrganizationId &&
				githubProvider.gitProvider.userId === ctx.session.userId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not allowed to access this github provider",
				});
			}
			await updateGitProvider(input.gitProviderId, {
				name: input.name,
				organizationId: ctx.session.activeOrganizationId,
			});

			await updateGithub(input.githubId, {
				...input,
			});
		}),
});
