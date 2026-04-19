import type { IUpdateData } from "@dokploy/server/index";
import {
	Bug,
	Download,
	Info,
	RefreshCcw,
	Server,
	Sparkles,
	Stars,
} from "lucide-react";
import Link from "next/link";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { ToggleAutoCheckUpdates } from "./toggle-auto-check-updates";
import { UpdateSourceConfig } from "./update-source-config";
import { UpdateWebServer } from "./update-webserver";

interface Props {
	updateData?: IUpdateData;
	children?: React.ReactNode;
	isOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export const UpdateServer = ({
	updateData,
	children,
	isOpen: isOpenProp,
	onOpenChange: onOpenChangeProp,
}: Props) => {
	const { t, ready } = useTranslation("settings");
	const [hasCheckedUpdate, setHasCheckedUpdate] = useState(!!updateData);
	const [isUpdateAvailable, setIsUpdateAvailable] = useState(
		!!updateData?.updateAvailable,
	);
	const { mutateAsync: getUpdateData, isPending } =
		api.settings.getUpdateData.useMutation();
	const { data: dokployVersion } = api.settings.getDokployVersion.useQuery();
	const { data: releaseTag } = api.settings.getReleaseTag.useQuery();
	const [latestVersion, setLatestVersion] = useState(
		updateData?.latestVersion ?? "",
	);
	const [isOpenInternal, setIsOpenInternal] = useState(false);

	const handleCheckUpdates = async () => {
		try {
			const nextUpdateData = await getUpdateData(undefined);
			const versionToUpdate = nextUpdateData.latestVersion || "";
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(nextUpdateData.updateAvailable);
			setLatestVersion(versionToUpdate);

			if (nextUpdateData.updateAvailable) {
				toast.success(versionToUpdate, {
					description: t("settings.server.webServer.update.toast.newVersion"),
				});
			} else {
				toast.info(t("settings.server.webServer.update.toast.noUpdates"));
			}
		} catch (error) {
			console.error("Error checking for updates:", error);
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(false);
			toast.error(t("settings.server.webServer.update.toast.error"));
		}
	};

	const isOpen = isOpenInternal || isOpenProp;
	const onOpenChange = (open: boolean) => {
		setIsOpenInternal(open);
		onOpenChangeProp?.(open);
	};

	if (!ready) {
		return (
			<Dialog open={isOpen} onOpenChange={onOpenChange}>
				<DialogTrigger asChild>{children}</DialogTrigger>
				<DialogContent className="max-w-lg">
					<div className="flex items-center justify-center p-8">
						<RefreshCcw className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	const dialogTitleKey = "settings.server.webServer.update.dialogTitle";
	const dialogTitle = t(dialogTitleKey);
	if (dialogTitle === dialogTitleKey) {
		return (
			<Dialog open={isOpen} onOpenChange={onOpenChange}>
				<DialogTrigger asChild>{children}</DialogTrigger>
				<DialogContent className="max-w-lg">
					<div className="flex items-center justify-center p-8">
						<RefreshCcw className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				{children ? (
					children
				) : (
					<TooltipProvider delayDuration={0}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant={updateData ? "outline" : "secondary"}
									size="sm"
									onClick={() => onOpenChange(true)}
								>
									<Download className="h-4 w-4 flex-shrink-0" />
									{updateData ? (
										<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
											{t("settings.server.webServer.update.buttonAvailable")}
										</span>
									) : (
										<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
											{t("settings.server.webServer.update.checkButton")}
										</span>
									)}
									{updateData && (
										<span className="absolute right-2 flex h-2 w-2 group-data-[collapsible=icon]:hidden">
											<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
											<span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
										</span>
									)}
								</Button>
							</TooltipTrigger>
							{updateData && (
								<TooltipContent side="right" sideOffset={10}>
									<p>{t("settings.server.webServer.update.buttonAvailable")}</p>
								</TooltipContent>
							)}
						</Tooltip>
					</TooltipProvider>
				)}
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<div className="mb-8 flex items-center justify-between">
					<DialogTitle className="text-2xl font-semibold">
						{dialogTitle}
					</DialogTitle>
					{dokployVersion && (
						<div className="mr-2 flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
							<Server className="h-4 w-4 text-muted-foreground" />
							<span className="text-sm text-muted-foreground">
								{dokployVersion}
								{(releaseTag === "canary" || releaseTag === "feature") &&
									` (${releaseTag})`}
							</span>
						</div>
					)}
				</div>

				{!hasCheckedUpdate && (
					<div className="mb-8">
						<p className="text text-muted-foreground">
							{t("settings.server.webServer.update.initialDescriptionLine1")}
							<br />
							<br />
							{t("settings.server.webServer.update.initialDescriptionLine2")}
						</p>
					</div>
				)}

				{isUpdateAvailable && latestVersion && (
					<div className="mb-8">
						<div className="mb-4 inline-flex w-full items-center gap-2 rounded-lg border border-emerald-900 bg-emerald-900 px-3 py-2 dark:bg-emerald-900/40">
							<div className="flex items-center gap-1.5">
								<Download className="h-4 w-4 text-emerald-400" />
								<span className="text font-medium text-emerald-400">
									{t("settings.server.webServer.update.newVersionLabel")}
								</span>
							</div>
							<span className="text font-semibold text-emerald-300">
								{latestVersion}
							</span>
						</div>

						<div className="space-y-4 text-muted-foreground">
							<p className="text">
								{t("settings.server.webServer.update.newVersionDescription")}
							</p>
							<ul className="space-y-3">
								<li className="flex items-start gap-2">
									<Stars className="mt-0.5 h-5 w-5 text-[#5B9DFF]" />
									<span className="text">
										{t("settings.server.webServer.update.reason.features")}
									</span>
								</li>
								<li className="flex items-start gap-2">
									<Bug className="mt-0.5 h-5 w-5 text-[#5B9DFF]" />
									<span className="text">
										{t("settings.server.webServer.update.reason.bugfixes")}
									</span>
								</li>
							</ul>
						</div>
					</div>
				)}

				{hasCheckedUpdate && !isUpdateAvailable && !isPending && (
					<div className="mb-8">
						<div className="mb-6 flex flex-col items-center gap-6">
							<div className="rounded-full bg-emerald-400/40 p-4">
								<Sparkles className="h-8 w-8 text-emerald-400" />
							</div>
							<div className="space-y-2 text-center">
								<h3 className="text-lg font-medium">
									{t("settings.server.webServer.update.latestVersionTitle")}
								</h3>
								<p className="text text-muted-foreground">
									{t("settings.server.webServer.update.latestVersionDescription")}
								</p>
							</div>
						</div>
					</div>
				)}

				{hasCheckedUpdate && isPending && (
					<div className="mb-8">
						<div className="mb-6 flex flex-col items-center gap-6">
							<div className="rounded-full bg-[#5B9DFF]/40 p-4 text-foreground">
								<RefreshCcw className="h-8 w-8 animate-spin" />
							</div>
							<div className="space-y-2 text-center">
								<h3 className="text-lg font-medium">
									{t("settings.server.webServer.update.checkingTitle")}
								</h3>
								<p className="text text-muted-foreground">
									{t("settings.server.webServer.update.checkingDescription")}
								</p>
							</div>
						</div>
					</div>
				)}

				{isUpdateAvailable && (
					<div className="mb-8 rounded-lg bg-[#16254D] p-4">
						<div className="flex gap-2">
							<Info className="h-5 w-5 flex-shrink-0 text-[#5B9DFF]" />
							<div className="text-[#5B9DFF]">
								{t("settings.server.webServer.update.releaseNotes")}
								<Link
									href="https://github.com/Dokploy/dokploy/releases"
									target="_blank"
									className="text-white underline hover:text-zinc-200"
								>
									{t("settings.server.webServer.update.releaseNotesLink")}
								</Link>
							</div>
						</div>
					</div>
				)}

				<div className="flex items-center justify-between gap-2 pt-2">
					<UpdateSourceConfig disabled={isPending} />
					<ToggleAutoCheckUpdates disabled={isPending} />
				</div>

				<div className="mt-4 flex items-center justify-end space-y-4">
					<div className="flex items-center gap-2">
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							{t("settings.common.cancel")}
						</Button>
						{isUpdateAvailable ? (
							<UpdateWebServer />
						) : (
							<Button
								variant="secondary"
								onClick={handleCheckUpdates}
								disabled={isPending}
							>
								{isPending ? (
									<>
										<RefreshCcw className="h-4 w-4 animate-spin" />
										{t("settings.server.webServer.update.checkingButton")}
									</>
								) : (
									<>
										<RefreshCcw className="h-4 w-4" />
										{t("settings.server.webServer.update.checkButton")}
									</>
								)}
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};

export default UpdateServer;
