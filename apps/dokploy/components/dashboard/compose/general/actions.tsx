import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Ban, CheckCircle2, RefreshCcw, Rocket, Terminal } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { DockerTerminalModal } from "../../settings/web-server/docker-terminal-modal";

interface Props {
	composeId: string;
}
export const ComposeActions = ({ composeId }: Props) => {
	const router = useRouter();
	const { t } = useTranslation("common");
	const { data, refetch } = api.compose.one.useQuery(
		{
			composeId,
		},
		{ enabled: !!composeId },
	);
	const { mutateAsync: update } = api.compose.update.useMutation();
	const { mutateAsync: deploy, isPending: isDeploying } =
		api.compose.deploy.useMutation();
	const { mutateAsync: redeploy, isPending: isRedeploying } =
		api.compose.redeploy.useMutation();
	const { mutateAsync: start, isPending: isStarting } =
		api.compose.start.useMutation();
	const { mutateAsync: stop, isPending: isStopping } =
		api.compose.stop.useMutation();
	return (
		<div className="flex flex-row gap-4 w-full flex-wrap ">
			<TooltipProvider delayDuration={0} disableHoverableContent={false}>
				<DialogAction
					title={t("compose.deploy.title")}
					description={t("compose.deploy.confirm")}
					type="default"
					onClick={async () => {
						await deploy({
							composeId: composeId,
						})
							.then(() => {
								toast.success(t("compose.deploy.success"));
								refetch();
								router.push(
									`/dashboard/project/${data?.environment.projectId}/environment/${data?.environmentId}/services/compose/${composeId}?tab=deployments`,
								);
							})
							.catch(() => {
								toast.error(t("compose.deploy.error"));
							});
					}}
				>
					<Button
						variant="default"
						isPending={isDeploying}
						className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex items-center">
									<Rocket className="size-4 mr-1" />
									{t("compose.button.deploy")}
								</div>
							</TooltipTrigger>
							<TooltipPrimitive.Portal>
								<TooltipContent sideOffset={5} className="z-[60]">
									<p>{t("compose.tooltip.deploy")}</p>
								</TooltipContent>
							</TooltipPrimitive.Portal>
						</Tooltip>
					</Button>
				</DialogAction>
				<DialogAction
					title={t("compose.reload.title")}
					description={t("compose.reload.confirm")}
					type="default"
					onClick={async () => {
						await redeploy({
							composeId: composeId,
						})
							.then(() => {
								toast.success(t("compose.reload.success"));
								refetch();
							})
							.catch(() => {
								toast.error(t("compose.reload.error"));
							});
					}}
				>
					<Button
						variant="secondary"
						isPending={isRedeploying}
						className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="flex items-center">
									<RefreshCcw className="size-4 mr-1" />
									{t("compose.button.reload")}
								</div>
							</TooltipTrigger>
							<TooltipPrimitive.Portal>
								<TooltipContent sideOffset={5} className="z-[60]">
									<p>{t("compose.tooltip.reload")}</p>
								</TooltipContent>
							</TooltipPrimitive.Portal>
						</Tooltip>
					</Button>
				</DialogAction>
				{data?.composeType === "docker-compose" &&
				data?.composeStatus === "idle" ? (
					<DialogAction
						title={t("compose.start.title")}
						description={t("compose.start.confirm")}
						type="default"
						onClick={async () => {
							await start({
								composeId: composeId,
							})
								.then(() => {
									toast.success(t("compose.start.success"));
									refetch();
								})
								.catch(() => {
									toast.error(t("compose.start.error"));
								});
						}}
					>
						<Button
							variant="secondary"
							isPending={isStarting}
							className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="flex items-center">
										<CheckCircle2 className="size-4 mr-1" />
										{t("compose.button.start")}
									</div>
								</TooltipTrigger>
								<TooltipPrimitive.Portal>
									<TooltipContent sideOffset={5} className="z-[60]">
										<p>{t("compose.tooltip.start")}</p>
									</TooltipContent>
								</TooltipPrimitive.Portal>
							</Tooltip>
						</Button>
					</DialogAction>
				) : (
					<DialogAction
						title={t("compose.stop.title")}
						description={t("compose.stop.confirm")}
						onClick={async () => {
							await stop({
								composeId: composeId,
							})
								.then(() => {
									toast.success(t("compose.stop.success"));
									refetch();
								})
								.catch(() => {
									toast.error(t("compose.stop.error"));
								});
						}}
					>
						<Button
							variant="destructive"
							isPending={isStopping}
							className="flex items-center gap-1.5 group focus-visible:ring-2 focus-visible:ring-offset-2"
						>
							<Tooltip>
								<TooltipTrigger asChild>
									<div className="flex items-center">
										<Ban className="size-4 mr-1" />
										{t("compose.button.stop")}
									</div>
								</TooltipTrigger>
								<TooltipPrimitive.Portal>
									<TooltipContent sideOffset={5} className="z-[60]">
										<p>{t("compose.tooltip.stop")}</p>
									</TooltipContent>
								</TooltipPrimitive.Portal>
							</Tooltip>
						</Button>
					</DialogAction>
				)}
			</TooltipProvider>
			<DockerTerminalModal
				appName={data?.appName || ""}
				serverId={data?.serverId || ""}
				appType={data?.composeType || "docker-compose"}
				serviceId={data?.composeId}
			>
				<Button
					variant="outline"
					className="flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					<Terminal className="size-4 mr-1" />
					{t("compose.button.terminal")}
				</Button>
			</DockerTerminalModal>
			<div className="flex flex-row items-center gap-2 rounded-md px-4 py-2 border">
				<span className="text-sm font-medium">
					{t("compose.autoDeploy.label")}
				</span>
				<Switch
					aria-label="Toggle autodeploy"
					checked={data?.autoDeploy || false}
					onCheckedChange={async (enabled) => {
						await update({
							composeId,
							autoDeploy: enabled,
						})
							.then(async () => {
								toast.success(t("compose.autoDeploy.update.success"));
								await refetch();
							})
							.catch(() => {
								toast.error(t("compose.autoDeploy.update.error"));
							});
					}}
					className="flex flex-row gap-2 items-center data-[state=checked]:bg-primary"
				/>
			</div>
		</div>
	);
};
