import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

export const ToggleAutoCheckUpdates = ({ disabled }: { disabled: boolean }) => {
	const { t } = useTranslation("settings");
	const utils = api.useUtils();
	const { data: enabledFromDb, isLoading } =
		api.settings.getAutoCheckUpdates.useQuery(undefined, {
			enabled: !disabled,
		});
	const { mutateAsync: setAutoCheckUpdates } =
		api.settings.setAutoCheckUpdates.useMutation();
	const [enabled, setEnabled] = useState<boolean>(true);

	useEffect(() => {
		if (disabled) {
			return;
		}
		if (enabledFromDb === undefined) {
			return;
		}
		setEnabled(enabledFromDb ?? true);
	}, [disabled, enabledFromDb]);

	useEffect(() => {
		if (disabled) {
			return;
		}
		if (enabledFromDb === undefined) {
			return;
		}
		const enabledResolved = enabledFromDb ?? true;
		const legacy = localStorage.getItem("enableAutoCheckUpdates");
		if (legacy !== "true" && legacy !== "false") {
			return;
		}
		const legacyValue = legacy === "true";
		if (legacyValue === enabledResolved) {
			localStorage.removeItem("enableAutoCheckUpdates");
			return;
		}
		void setAutoCheckUpdates({ enabled: legacyValue })
			.then(async () => {
				localStorage.removeItem("enableAutoCheckUpdates");
				await utils.settings.getAutoCheckUpdates.invalidate();
			})
			.catch(() => {
				// ignore migration errors
			});
	}, [disabled, enabledFromDb, setAutoCheckUpdates, utils]);

	const handleToggle = (checked: boolean) => {
		setEnabled(checked);
		void setAutoCheckUpdates({ enabled: checked }).then(async () => {
			await utils.settings.getAutoCheckUpdates.invalidate();
		});
	};

	return (
		<div className="flex items-center gap-4">
			<Switch
				checked={enabled}
				onCheckedChange={handleToggle}
				id="autoCheckUpdatesToggle"
				disabled={disabled || isLoading}
			/>
			<Label className="text-primary" htmlFor="autoCheckUpdatesToggle">
				{t("settings.server.webServer.update.autoCheckLabel")}
			</Label>
		</div>
	);
};
