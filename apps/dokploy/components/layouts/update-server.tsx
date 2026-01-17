import type { IUpdateData } from "@dokploy/server/index";
import { Download } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useRef, useState } from "react";
import { api } from "@/utils/api";
import UpdateServer from "../dashboard/settings/web-server/update-server";
import { Button } from "../ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../ui/tooltip";

const AUTO_CHECK_UPDATES_INTERVAL_MINUTES = 7;

export const UpdateServerButton = () => {
	const { t, ready } = useTranslation("settings");
	const [updateData, setUpdateData] = useState<IUpdateData>({
		latestVersion: null,
		updateAvailable: false,
	});
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: autoCheckEnabled } = api.settings.getAutoCheckUpdates.useQuery(
		undefined,
		{
			enabled: !isCloud,
		},
	);
	const { mutateAsync: setAutoCheckUpdates } =
		api.settings.setAutoCheckUpdates.useMutation();
	const { mutateAsync: getUpdateData } =
		api.settings.getUpdateData.useMutation();
	const [isOpen, setIsOpen] = useState(false);

	const checkUpdatesIntervalRef = useRef<null | NodeJS.Timeout>(null);

	useEffect(() => {
		// 官方逻辑：仅在自托管环境下自动检查更新
		if (isCloud) {
			return;
		}

		const enabledFromDb = autoCheckEnabled ?? true;
		const legacy = localStorage.getItem("enableAutoCheckUpdates");
		if (legacy === "true" || legacy === "false") {
			const legacyValue = legacy === "true";
			if (legacyValue !== enabledFromDb) {
				void setAutoCheckUpdates({ enabled: legacyValue })
					.then(() => {
						localStorage.removeItem("enableAutoCheckUpdates");
					})
					.catch(() => {
						// ignore migration errors
					});
			} else {
				localStorage.removeItem("enableAutoCheckUpdates");
			}
		}

		const clearUpdatesInterval = () => {
			if (checkUpdatesIntervalRef.current) {
				clearInterval(checkUpdatesIntervalRef.current);
			}
		};

		const checkUpdates = async () => {
			try {
				if (!enabledFromDb) {
					return;
				}

				const fetchedUpdateData = await getUpdateData(undefined);

				if (fetchedUpdateData?.updateAvailable) {
					// 一旦发现有更新，停止轮询并在侧边栏显示按钮
					clearUpdatesInterval();
					setUpdateData(fetchedUpdateData);
				}
			} catch (error) {
				console.error("Error auto-checking for updates:", error);
			}
		};

		checkUpdatesIntervalRef.current = setInterval(
			checkUpdates,
			AUTO_CHECK_UPDATES_INTERVAL_MINUTES * 60_000,
		);

		// 初次加载时也检查一次
		checkUpdates();

		return () => {
			clearUpdatesInterval();
		};
	}, [autoCheckEnabled, getUpdateData, isCloud, setAutoCheckUpdates]);

	if (isCloud || !updateData.updateAvailable) {
		return null;
	}

	// 等待 I18N 资源加载完成，避免显示键值
	if (!ready) {
		return null;
	}

	const updateAvailableLabelKey =
		"settings.server.webServer.update.buttonAvailable";
	const updateAvailableLabel = t(updateAvailableLabelKey);
	if (updateAvailableLabel === updateAvailableLabelKey) {
		return null;
	}

	return (
		<div className="border-t pt-4">
			<UpdateServer
				updateData={updateData}
				isOpen={isOpen}
				onOpenChange={setIsOpen}
			>
				<TooltipProvider delayDuration={0}>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant={updateData ? "outline" : "secondary"}
								className="w-full relative"
								onClick={() => setIsOpen(true)}
							>
								<Download className="h-4 w-4 flex-shrink-0" />
								<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
									{updateAvailableLabel}
								</span>
								<span className="absolute right-2 flex h-2 w-2 group-data-[collapsible=icon]:hidden">
									<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
									<span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
								</span>
							</Button>
						</TooltipTrigger>
						<TooltipContent side="right" sideOffset={10}>
							<p>{updateAvailableLabel}</p>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</UpdateServer>
		</div>
	);
};
