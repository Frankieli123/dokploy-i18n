import { IS_CLOUD, validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { Loader2 } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { ShowBackups } from "@/components/dashboard/database/backups/show-backups";
import { DialogAction } from "@/components/shared/dialog-action";
import { WebDomain } from "@/components/dashboard/settings/web-domain";
import { WebServer } from "@/components/dashboard/settings/web-server";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";
import { getLocale, serverSideTranslations } from "@/utils/i18n";

const Page = () => {
	const { data: user } = api.user.get.useQuery();
	const { mutateAsync: fullBackup, isLoading } =
		api.backup.fullBackup.useMutation();
	const { mutateAsync: fullRestore, isLoading: isRestoring } =
		api.backup.fullRestore.useMutation();
	return (
		<div className="w-full">
			<div className="h-full rounded-xl  max-w-5xl mx-auto flex flex-col gap-4">
				<WebDomain />
				<WebServer />
				<div className="w-full flex flex-col gap-4">
					<div className="flex justify-end gap-2">
						<Button
							onClick={async () => {
								try {
									await fullBackup();
									toast.success("全量备份已启动（后台运行）");
								} catch {
									toast.error("启动全量备份失败");
								}
							}}
							disabled={isLoading || isRestoring}
						>
							{isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
							一键备份
						</Button>
						<DialogAction
							title="确认全量恢复？"
							description="会从最新备份恢复数据库与卷（ALL），可能覆盖现有数据。Web Server 请在下方备份列表单独恢复。"
							disabled={isRestoring}
							onClick={() => {
								void (async () => {
									try {
										await fullRestore();
										toast.success("全量恢复已启动（后台运行）");
									} catch {
										toast.error("启动全量恢复失败");
									}
								})();
							}}
							type="destructive"
						>
							<Button
								variant="outline"
								disabled={isLoading || isRestoring}
							>
								{isRestoring && (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								)}
								一键恢复
							</Button>
						</DialogAction>
					</div>
					<Card className="h-full bg-sidebar  p-2.5 rounded-xl  mx-auto w-full">
						<ShowBackups
							id={user?.userId ?? ""}
							databaseType="web-server"
							backupType="database"
						/>
					</Card>
				</div>
			</div>
		</div>
	);
};

export default Page;

Page.getLayout = (page: ReactElement) => {
	return (
		<DashboardLayout metaName="settings.server.webServer.title">
			{page}
		</DashboardLayout>
	);
};
export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ serviceId: string }>,
) {
	const { req, res } = ctx;
	const locale = await getLocale(req.cookies);
	if (IS_CLOUD) {
		return {
			redirect: {
				permanent: true,
				destination: "/dashboard/projects",
			},
		};
	}
	const { user, session } = await validateRequest(ctx.req);
	if (!user) {
		return {
			redirect: {
				permanent: true,
				destination: "/",
			},
		};
	}
	if (user.role === "member") {
		return {
			redirect: {
				permanent: true,
				destination: "/dashboard/settings/profile",
			},
		};
	}

	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});
	await helpers.user.get.prefetch();

	return {
		props: {
			trpcState: helpers.dehydrate(),
			...(await serverSideTranslations(locale, ["settings"])),
		},
	};
}
