import { useTranslation } from "next-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHealthCheckAfterMutation } from "@/hooks/use-health-check-after-mutation";
import { api } from "@/utils/api";
import { EditTraefikEnv } from "../../web-server/edit-traefik-env";
import { ManageTraefikPorts } from "../../web-server/manage-traefik-ports";
import { ShowModalLogs } from "../../web-server/show-modal-logs";

interface Props {
	serverId?: string;
}
export const ShowTraefikActions = ({ serverId }: Props) => {
	const { t } = useTranslation("settings");
	const { mutateAsync: reloadTraefik, isPending: reloadTraefikIsLoading } =
		api.settings.reloadTraefik.useMutation();

	const { mutateAsync: toggleDashboard, isPending: toggleDashboardIsLoading } =
		api.settings.toggleDashboard.useMutation();

	const { data: haveTraefikDashboardPortEnabled, refetch: refetchDashboard } =
		api.settings.haveTraefikDashboardPortEnabled.useQuery({
			serverId,
		});

	const {
		execute: executeWithHealthCheck,
		isExecuting: isHealthCheckExecuting,
	} = useHealthCheckAfterMutation({
		initialDelay: 5000,
		successMessage: t("settings.server.webServer.traefik.dashboardUpdated"),
		onSuccess: () => {
			refetchDashboard();
		},
	});

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				asChild
				disabled={
					reloadTraefikIsLoading ||
					toggleDashboardIsLoading ||
					isHealthCheckExecuting
				}
			>
				<Button
					isPending={
						reloadTraefikIsLoading ||
						toggleDashboardIsLoading ||
						isHealthCheckExecuting
					}
					variant="outline"
				>
					{t("settings.server.webServer.traefik.label")}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="w-56" align="start">
				<DropdownMenuLabel>
					{t("settings.server.webServer.actions")}
				</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						onClick={async () => {
							await reloadTraefik({
								serverId: serverId,
							})
								.then(async () => {
									toast.success(
										t("settings.server.webServer.traefik.reloaded"),
									);
								})
								.catch(() => {});
						}}
						className="cursor-pointer"
					>
						<span>{t("settings.server.webServer.reload")}</span>
					</DropdownMenuItem>
					<ShowModalLogs
						appName="dokploy-traefik"
						serverId={serverId}
						type="standalone"
					>
						<DropdownMenuItem
							onSelect={(e) => e.preventDefault()}
							className="cursor-pointer"
						>
							{t("settings.server.webServer.watchLogs")}
						</DropdownMenuItem>
					</ShowModalLogs>
					<EditTraefikEnv serverId={serverId}>
						<DropdownMenuItem
							onSelect={(e) => e.preventDefault()}
							className="cursor-pointer"
						>
							<span>{t("settings.server.webServer.traefik.modifyEnv")}</span>
						</DropdownMenuItem>
					</EditTraefikEnv>

					<DropdownMenuItem
						onClick={async () => {
							await executeWithHealthCheck(() =>
								toggleDashboard({
									enableDashboard: !haveTraefikDashboardPortEnabled,
									serverId: serverId,
								}),
							).catch((error) => {
								toast.error(
									(error as Error)?.message ||
										"Failed to update Traefik dashboard",
								);
							});
						}}
						className="w-full cursor-pointer space-x-3"
					>
						<span>
							{haveTraefikDashboardPortEnabled
								? t("settings.server.webServer.traefik.disableDashboard")
								: t("settings.server.webServer.traefik.enableDashboard")}
						</span>
					</DropdownMenuItem>
					<ManageTraefikPorts serverId={serverId}>
						<DropdownMenuItem
							onSelect={(e) => e.preventDefault()}
							className="cursor-pointer"
						>
							<span>{t("settings.server.webServer.traefik.managePorts")}</span>
						</DropdownMenuItem>
					</ManageTraefikPorts>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};

