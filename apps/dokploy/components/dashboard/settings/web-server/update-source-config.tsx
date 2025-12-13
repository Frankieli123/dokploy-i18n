import { Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "next-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";

const UPDATE_TAGS_URL_STORAGE_KEY = "dokployUpdateTagsUrl";

export const readUpdateTagsUrlFromStorage = (): string | null => {
	if (typeof window === "undefined") {
		return null;
	}
	const raw = window.localStorage.getItem(UPDATE_TAGS_URL_STORAGE_KEY);
	const trimmed = raw?.trim();
	return trimmed ? trimmed : null;
};

export const writeUpdateTagsUrlToStorage = (tagsUrl: string | null) => {
	if (typeof window === "undefined") {
		return;
	}
	const trimmed = tagsUrl?.trim();
	if (!trimmed) {
		window.localStorage.removeItem(UPDATE_TAGS_URL_STORAGE_KEY);
		return;
	}
	window.localStorage.setItem(UPDATE_TAGS_URL_STORAGE_KEY, trimmed);
};

export const UpdateSourceConfig = ({
	disabled,
}: {
	disabled?: boolean;
}) => {
	const { t } = useTranslation("settings");
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");

	useEffect(() => {
		if (!open) {
			return;
		}
		setValue(readUpdateTagsUrlFromStorage() ?? "");
	}, [open]);

	const handleSave = () => {
		writeUpdateTagsUrlToStorage(value);
		toast.success("Saved");
		setOpen(false);
	};

	const handleClear = () => {
		writeUpdateTagsUrlToStorage(null);
		setValue("");
		toast.success("Cleared");
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" disabled={disabled}>
					<Settings2 className="h-4 w-4" />
					<span>Update source</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[420px]">
				<div className="space-y-3">
					<div className="space-y-1">
						<Label htmlFor="updateTagsUrl">Update source URL</Label>
						<Input
							id="updateTagsUrl"
							value={value}
							onChange={(e) => setValue(e.target.value)}
							placeholder="https://..."
							spellCheck={false}
							disabled={disabled}
						/>
						<div className="text-xs text-muted-foreground">
							Leave empty to use Docker Hub.
						</div>
					</div>
					<div className="flex items-center justify-between gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleClear}
							disabled={disabled}
						>
							<Trash2 className="h-4 w-4" />
							<span>Clear</span>
						</Button>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setOpen(false)}
							>
								{t("settings.common.cancel")}
							</Button>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={handleSave}
								disabled={disabled}
							>
								{t("settings.common.save")}
							</Button>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	);
};
