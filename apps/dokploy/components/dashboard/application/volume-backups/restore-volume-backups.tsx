import { zodResolver } from "@hookform/resolvers/zod";
import copy from "copy-to-clipboard";
import { debounce } from "lodash";
import { CheckIcon, ChevronsUpDown, Copy, RotateCcw } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { DrawerLogs } from "@/components/shared/drawer-logs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { formatBytes } from "../../database/backups/restore-backup";
import { type LogLine, parseLogs } from "../../docker/logs/utils";

interface Props {
	id: string;
	type: "application" | "compose";
	serverId?: string;
}

type ConfiguredRestoreTarget = {
	volumeName: string;
	prefix?: string | null;
	serviceName?: string | null;
	DisplayVolumeName?: string | null;
	SubmitVolumeName?: string | null;
};

const ALL_MOUNTS_VOLUME_NAME = "dokploy_all_mounts";
const ALL_MOUNTS_BACKUP_BASE_NAME = "all_mounts";
const ALL_MOUNTS_UI_VALUE = "ALL";

const normalizeRestorePrefix = (value?: string | null) => {
	const trimmed = (value || "").trim().replace(/\\/g, "/");
	if (!trimmed || trimmed === "/") return "";
	return `${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}/`;
};

const normalizeRestorePath = (value: string) =>
	value.trim().replace(/\\/g, "/").replace(/^\/+/, "");

const isBindPath = (value: string) =>
	value.startsWith("/") ||
	value.startsWith("./") ||
	value.startsWith("../") ||
	/^[a-zA-Z]:[\\/]/.test(value);

const isAllMountsVolumeName = (value: string) => {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === ALL_MOUNTS_VOLUME_NAME ||
		normalized === ALL_MOUNTS_UI_VALUE.toLowerCase()
	);
};

const toRestoreTargetValue = (value: string) =>
	value === ALL_MOUNTS_VOLUME_NAME ? ALL_MOUNTS_UI_VALUE : value;

const getConfiguredRestoreDisplayValue = (config: ConfiguredRestoreTarget) =>
	toRestoreTargetValue(
		config.DisplayVolumeName?.trim() || config.volumeName.trim(),
	);

const getConfiguredRestoreSubmitValue = (config: ConfiguredRestoreTarget) =>
	config.SubmitVolumeName?.trim() || config.volumeName.trim();

const resolveConfiguredRestoreTarget = (
	value: string | null | undefined,
	configs: ConfiguredRestoreTarget[],
) => {
	const normalizedValue = value?.trim();
	if (!normalizedValue) return null;

	return (
		configs.find((config) => {
			const displayValue = getConfiguredRestoreDisplayValue(config);
			const submitValue = getConfiguredRestoreSubmitValue(config);

			return (
				displayValue.trim() === normalizedValue ||
				submitValue.trim() === normalizedValue
			);
		}) || null
	);
};

const sha256 = async (value: string) => {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);

	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

const getBackupBaseName = async (source: string) => {
	if (isAllMountsVolumeName(source)) {
		return ALL_MOUNTS_BACKUP_BASE_NAME;
	}

	if (!isBindPath(source)) return source;

	const normalized = source.replace(/\\/g, "/");
	const baseName =
		normalized.split("/").filter(Boolean).pop()?.trim() || "bind";
	const safeBaseName = baseName.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 32);
	const hash = (await sha256(normalized)).slice(0, 12);

	return `bind-${safeBaseName}-${hash}`;
};

const createRestoreVolumeBackupSchema = (t: (key: string) => string) =>
	z.object({
		destinationId: z
			.string({
				required_error: t("backups.restore.validation.destinationRequired"),
			})
			.min(1, {
				message: t("backups.restore.validation.destinationRequired"),
			}),
		backupFile: z
			.string({
				required_error: t("backups.restore.validation.backupFileRequired"),
			})
			.min(1, {
				message: t("backups.restore.validation.backupFileRequired"),
			}),
		volumeName: z
			.string({
				required_error: t(
					"volumeBackups.restore.validation.volumeNameRequired",
				),
			})
			.min(1, {
				message: t("volumeBackups.restore.validation.volumeNameRequired"),
			}),
	});

export const RestoreVolumeBackups = ({ id, type, serverId }: Props) => {
	const [isOpen, setIsOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");

	const { t } = useTranslation("common");
	const { data: destinations = [] } = api.destination.all.useQuery();

	const form = useForm<
		z.infer<ReturnType<typeof createRestoreVolumeBackupSchema>>
	>({
		defaultValues: {
			destinationId: "",
			backupFile: "",
			volumeName: "",
		},
		resolver: zodResolver(createRestoreVolumeBackupSchema(t)),
	});

	const destinationId = form.watch("destinationId");
	const volumeName = form.watch("volumeName");
	const backupFile = form.watch("backupFile");
	const autoFilledVolumeNameRef = useRef("");
	const submittingVolumeNameRef = useRef<string | null>(null);
	const selectedRestoreTargetRef = useRef<{
		formValue: string;
		submitValue: string;
	} | null>(null);
	const previousDestinationIdRef = useRef("");
	const isAutoFilledAllMounts =
		isAllMountsVolumeName(volumeName) &&
		volumeName === autoFilledVolumeNameRef.current;

	const debouncedSetSearch = debounce((value: string) => {
		setDebouncedSearchTerm(value);
	}, 350);

	const handleSearchChange = (value: string) => {
		setSearch(value);
		debouncedSetSearch(value);
	};

	const { data: files = [], isLoading } = api.backup.listBackupFiles.useQuery(
		{
			destinationId: destinationId,
			search: debouncedSearchTerm,
			serverId: serverId ?? "",
		},
		{
			enabled: isOpen && !!destinationId,
		},
	);
	const { data: configuredVolumeBackups = [] } =
		api.volumeBackups.list.useQuery(
			{
				id,
				volumeBackupType: type,
			},
			{
				enabled: isOpen,
			},
		);

	const [isDrawerOpen, setIsDrawerOpen] = useState(false);
	const [filteredLogs, setFilteredLogs] = useState<LogLine[]>([]);
	const [isDeploying, setIsDeploying] = useState(false);

	useEffect(() => {
		if (!isOpen) {
			previousDestinationIdRef.current = destinationId;
			return;
		}

		if (!previousDestinationIdRef.current) {
			previousDestinationIdRef.current = destinationId;
			return;
		}

		if (destinationId === previousDestinationIdRef.current) return;

		previousDestinationIdRef.current = destinationId;
		setSearch("");
		setDebouncedSearchTerm("");
		form.setValue("backupFile", "", {
			shouldDirty: true,
			shouldValidate: true,
		});

		const currentVolumeName = form.getValues("volumeName");
		const shouldKeepSingleDefaultTarget =
			configuredVolumeBackups.length === 1 &&
			currentVolumeName ===
				getConfiguredRestoreDisplayValue(configuredVolumeBackups[0]!);

		if (
			currentVolumeName === autoFilledVolumeNameRef.current &&
			!shouldKeepSingleDefaultTarget
		) {
			autoFilledVolumeNameRef.current = "";
			form.setValue("volumeName", "", {
				shouldDirty: true,
				shouldValidate: true,
			});
		}

		selectedRestoreTargetRef.current = null;
	}, [configuredVolumeBackups, destinationId, form, isOpen]);

	useEffect(() => {
		if (
			!isOpen ||
			form.getValues("volumeName") ||
			configuredVolumeBackups.length !== 1
		) {
			return;
		}

		const defaultTarget = configuredVolumeBackups[0];
		if (!defaultTarget?.volumeName) return;

		const nextValue = getConfiguredRestoreDisplayValue(defaultTarget);
		const submitValue = getConfiguredRestoreSubmitValue(defaultTarget);
		autoFilledVolumeNameRef.current = nextValue;
		selectedRestoreTargetRef.current =
			nextValue !== submitValue ? { formValue: nextValue, submitValue } : null;
		form.setValue("volumeName", nextValue, {
			shouldDirty: false,
			shouldValidate: true,
		});
	}, [configuredVolumeBackups, form, isOpen]);

	useEffect(() => {
		if (!backupFile) {
			const currentVolumeName = form.getValues("volumeName");
			const shouldKeepSingleDefaultTarget =
				configuredVolumeBackups.length === 1 &&
				currentVolumeName ===
					getConfiguredRestoreDisplayValue(configuredVolumeBackups[0]!);

			if (
				currentVolumeName === autoFilledVolumeNameRef.current &&
				!shouldKeepSingleDefaultTarget
			) {
				autoFilledVolumeNameRef.current = "";
				selectedRestoreTargetRef.current = null;
				form.setValue("volumeName", "", {
					shouldDirty: true,
					shouldValidate: true,
				});
			}
			return;
		}

		if (configuredVolumeBackups.length === 0) return;

		const syncVolumeNameFromBackupFile = async () => {
			const normalizedBackupPath = normalizeRestorePath(backupFile);
			const orderedConfigs = [...configuredVolumeBackups].sort(
				(a, b) =>
					normalizeRestorePrefix(b.prefix).length -
					normalizeRestorePrefix(a.prefix).length,
			);

			for (const config of orderedConfigs) {
				const normalizedPrefix = normalizeRestorePrefix(config.prefix);
				const relativePath = normalizedPrefix
					? normalizedBackupPath.startsWith(normalizedPrefix)
						? normalizedBackupPath.slice(normalizedPrefix.length)
						: null
					: normalizedBackupPath;

				if (!relativePath) continue;

				const fileName =
					relativePath.split("/").filter(Boolean).pop() || relativePath;
				const backupBaseName = await getBackupBaseName(config.volumeName);

				if (
					fileName === backupBaseName ||
					fileName.startsWith(`${backupBaseName}-`)
				) {
					const currentValue = form.getValues("volumeName");
					const nextValue = getConfiguredRestoreDisplayValue(config);
					const submitValue = getConfiguredRestoreSubmitValue(config);

					if (
						!currentValue ||
						currentValue === autoFilledVolumeNameRef.current
					) {
						autoFilledVolumeNameRef.current = nextValue;
						selectedRestoreTargetRef.current =
							nextValue !== submitValue
								? {
										formValue: nextValue,
										submitValue,
									}
								: null;
						form.setValue("volumeName", nextValue, {
							shouldDirty: true,
							shouldValidate: true,
						});
					}
					return;
				}
			}

			const currentVolumeName = form.getValues("volumeName");
			const shouldKeepSingleDefaultTarget =
				configuredVolumeBackups.length === 1 &&
				currentVolumeName ===
					getConfiguredRestoreDisplayValue(configuredVolumeBackups[0]!);

			if (
				currentVolumeName === autoFilledVolumeNameRef.current &&
				!shouldKeepSingleDefaultTarget
			) {
				autoFilledVolumeNameRef.current = "";
				selectedRestoreTargetRef.current = null;
				form.setValue("volumeName", "", {
					shouldDirty: true,
					shouldValidate: true,
				});
			}
		};

		void syncVolumeNameFromBackupFile();
	}, [backupFile, configuredVolumeBackups, form]);

	api.volumeBackups.restoreVolumeBackupWithLogs.useSubscription(
		{
			id,
			serviceType: type,
			serverId,
			destinationId,
			volumeName: submittingVolumeNameRef.current || volumeName,
			backupFileName: backupFile,
		},
		{
			enabled: isDeploying,
			onData(log) {
				if (!isDrawerOpen) {
					setIsDrawerOpen(true);
				}

				if (
					log.includes("Volume restore completed successfully") ||
					log.includes("All mounts restore completed") ||
					log.includes("Volume restore failed!")
				) {
					submittingVolumeNameRef.current = null;
					setIsDeploying(false);
				}

				const parsedLogs = parseLogs(log);
				setFilteredLogs((prev) => [...prev, ...parsedLogs]);
			},
			onError(error) {
				console.error("Restore logs error:", error);
				submittingVolumeNameRef.current = null;
				setIsDeploying(false);
			},
		},
	);

	const onSubmit = async (
		values: z.infer<ReturnType<typeof createRestoreVolumeBackupSchema>>,
	) => {
		const selectedTarget = selectedRestoreTargetRef.current;
		const resolvedTarget = resolveConfiguredRestoreTarget(
			values.volumeName,
			configuredVolumeBackups,
		);
		const preparedVolumeName = resolvedTarget
			? getConfiguredRestoreSubmitValue(resolvedTarget)
			: selectedTarget &&
					values.volumeName.trim() === selectedTarget.formValue.trim()
				? selectedTarget.submitValue
				: values.volumeName;

		submittingVolumeNameRef.current = preparedVolumeName;
		setIsDeploying(true);
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<RotateCcw className="mr-2 size-4" />
					{t("volumeBackups.restore.button.open")}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center">
						<RotateCcw className="mr-2 size-4" />
						{t("volumeBackups.restore.dialog.title")}
					</DialogTitle>
					<DialogDescription>
						{t("volumeBackups.restore.dialog.description")}
					</DialogDescription>
					<AlertBlock>
						{t("volumeBackups.restore.alert.volumeInUseWarning")}
					</AlertBlock>
				</DialogHeader>

				<Form {...form}>
					<form
						id="hook-form-restore-backup"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<FormField
							control={form.control}
							name="destinationId"
							render={({ field }) => (
								<FormItem className="">
									<FormLabel>
										{t("backups.restore.field.destination")}
									</FormLabel>
									<Popover>
										<PopoverTrigger asChild>
											<FormControl>
												<Button
													variant="outline"
													className={cn(
														"w-full justify-between !bg-input",
														!field.value && "text-muted-foreground",
													)}
												>
													{field.value
														? destinations.find(
																(d) => d.destinationId === field.value,
															)?.name
														: t("backups.restore.field.destinationPlaceholder")}
													<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
												</Button>
											</FormControl>
										</PopoverTrigger>
										<PopoverContent className="p-0" align="start">
											<Command>
												<CommandInput
													placeholder={t(
														"backups.restore.field.destinationSearchPlaceholder",
													)}
													className="h-9"
												/>
												<CommandEmpty>
													{t("backups.restore.field.destinationEmpty")}
												</CommandEmpty>
												<ScrollArea className="h-64">
													<CommandGroup>
														{destinations.map((destination) => (
															<CommandItem
																value={destination.destinationId}
																key={destination.destinationId}
																onSelect={() => {
																	form.setValue(
																		"destinationId",
																		destination.destinationId,
																	);
																}}
															>
																{destination.name}
																<CheckIcon
																	className={cn(
																		"ml-auto h-4 w-4",
																		destination.destinationId === field.value
																			? "opacity-100"
																			: "opacity-0",
																	)}
																/>
															</CommandItem>
														))}
													</CommandGroup>
												</ScrollArea>
											</Command>
										</PopoverContent>
									</Popover>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="backupFile"
							render={({ field }) => (
								<FormItem className="">
									<FormLabel className="flex items-center">
										{t("backups.restore.field.backupFileLabel")}
										{field.value && (
											<Badge variant="outline" className="truncate w-52">
												{field.value}
												<Copy
													className="ml-2 size-4 cursor-pointer"
													onClick={(e) => {
														e.stopPropagation();
														e.preventDefault();
														copy(field.value);
														toast.success(
															t("backups.restore.toast.fileCopied"),
														);
													}}
												/>
											</Badge>
										)}
									</FormLabel>
									<Popover modal>
										<PopoverTrigger asChild>
											<FormControl>
												<Button
													variant="outline"
													className={cn(
														"w-full justify-between !bg-input",
														!field.value && "text-muted-foreground",
													)}
												>
													<span className="truncate text-left flex-1 w-52">
														{field.value ||
															t(
																"backups.restore.field.backupFileButtonPlaceholder",
															)}
													</span>
													<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
												</Button>
											</FormControl>
										</PopoverTrigger>
										<PopoverContent className="p-0" align="start">
											<Command>
												<CommandInput
													placeholder={t(
														"backups.restore.field.backupFileSearchPlaceholder",
													)}
													value={search}
													onValueChange={handleSearchChange}
													className="h-9"
												/>
												{isLoading ? (
													<div className="py-6 text-center text-sm">
														{t("backups.restore.field.backupFileLoading")}
													</div>
												) : files.length === 0 && search ? (
													<div className="py-6 text-center text-sm text-muted-foreground">
														{t("backups.restore.field.backupFileEmptySearch", {
															search,
														})}
													</div>
												) : files.length === 0 ? (
													<div className="py-6 text-center text-sm text-muted-foreground">
														{t("backups.restore.field.backupFileEmpty")}
													</div>
												) : (
													<ScrollArea className="h-64">
														<CommandGroup className="w-96">
															{files?.map((file) => (
																<CommandItem
																	value={file.Path}
																	key={file.Path}
																	onSelect={() => {
																		if (file.IsDir) {
																			form.setValue("backupFile", "", {
																				shouldDirty: true,
																				shouldValidate: true,
																			});
																			setSearch(`${file.Path}/`);
																			setDebouncedSearchTerm(`${file.Path}/`);
																		} else {
																			form.setValue("backupFile", file.Path);
																			setSearch(file.Path);
																			setDebouncedSearchTerm(file.Path);
																		}
																	}}
																>
																	<div className="flex w-full flex-col gap-1">
																		<div className="flex w-full justify-between">
																			<span className="font-medium">
																				{file.Path}
																			</span>

																			<CheckIcon
																				className={cn(
																					"ml-auto h-4 w-4",
																					file.Path === field.value
																						? "opacity-100"
																						: "opacity-0",
																				)}
																			/>
																		</div>
																		<div className="flex items-center gap-4 text-xs text-muted-foreground">
																			<span>
																				{t(
																					"backups.restore.field.backupFileSize",
																					{
																						size: formatBytes(file.Size),
																					},
																				)}
																			</span>
																			{file.IsDir && (
																				<span className="text-blue-500">
																					{t(
																						"backups.restore.field.backupFileDirectoryTag",
																					)}
																				</span>
																			)}
																			{file.Hashes?.MD5 && (
																				<span>
																					{t(
																						"backups.restore.field.backupFileMd5Label",
																						{
																							hash: file.Hashes.MD5,
																						},
																					)}
																				</span>
																			)}
																		</div>
																	</div>
																</CommandItem>
															))}
														</CommandGroup>
													</ScrollArea>
												)}
											</Command>
										</PopoverContent>
									</Popover>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="volumeName"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("volumeBackups.restore.field.volumeNameLabel")}
									</FormLabel>
									<FormControl>
										<Input
											placeholder={t(
												"volumeBackups.restore.field.volumeNamePlaceholder",
											)}
											{...field}
											value={
												isAutoFilledAllMounts
													? t("filter.all")
													: (field.value ?? "")
											}
											onChange={(event) => {
												if (isAutoFilledAllMounts) return;
												if (
													selectedRestoreTargetRef.current &&
													event.target.value.trim() !==
														selectedRestoreTargetRef.current.formValue.trim()
												) {
													selectedRestoreTargetRef.current = null;
												}
												if (
													autoFilledVolumeNameRef.current &&
													event.target.value.trim() !==
														autoFilledVolumeNameRef.current.trim()
												) {
													autoFilledVolumeNameRef.current = "";
												}
												field.onChange(event);
											}}
											readOnly={isAutoFilledAllMounts}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<DialogFooter>
							<Button
								isLoading={isDeploying}
								form="hook-form-restore-backup"
								type="submit"
							>
								{t("button.restore")}
							</Button>
						</DialogFooter>
					</form>
				</Form>

				<DrawerLogs
					isOpen={isDrawerOpen}
					onClose={() => {
						setIsDrawerOpen(false);
						setFilteredLogs([]);
						submittingVolumeNameRef.current = null;
						setIsDeploying(false);
						// refetch();
					}}
					filteredLogs={filteredLogs}
				/>
			</DialogContent>
		</Dialog>
	);
};
