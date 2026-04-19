import { zodResolver } from "@hookform/resolvers/zod";
import { DatabaseZap, PenBoxIcon, PlusCircle, RefreshCw } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import type { CacheType } from "../domains/handle-domain";
import { ScheduleFormField } from "../schedules/handle-schedules";

const ALL_MOUNTS_VOLUME_NAME = "ALL";
const ALL_MOUNTS_VOLUME_NAME_INTERNAL = "dokploy_all_mounts";

const toUiVolumeName = (value?: string | null) =>
	value === ALL_MOUNTS_VOLUME_NAME_INTERNAL
		? ALL_MOUNTS_VOLUME_NAME
		: value || "";

const isAllMountsValue = (value?: string | null) =>
	["all", ALL_MOUNTS_VOLUME_NAME_INTERNAL].includes(
		(value || "").trim().toLowerCase(),
	);

type MountSelectOption = {
	Type?: string | null;
	Source?: string | null;
	Name?: string | null;
	Destination?: string | null;
	BackupValue?: string | null;
	DisplayValue?: string | null;
};

const getMountOptionValue = (mount: MountSelectOption) =>
	mount.DisplayValue?.trim() ||
	(mount.Type === "bind"
		? mount.Source?.trim() || ""
		: mount.Name?.trim() || "");

const getMountOptionSubmitValue = (mount: MountSelectOption) =>
	mount.BackupValue?.trim() ||
	(mount.Type === "bind"
		? mount.Source?.trim() || ""
		: mount.Name?.trim() || "");

const resolveMountSelection = (
	value: string | null | undefined,
	mounts: MountSelectOption[],
) => {
	const normalizedValue = value?.trim();
	if (!normalizedValue) return null;

	const matchedMount = mounts.find((mount) => {
		const formValue = getMountOptionValue(mount);
		const submitValue = getMountOptionSubmitValue(mount);
		return formValue === normalizedValue || submitValue === normalizedValue;
	});

	if (!matchedMount) return null;

	return {
		formValue: getMountOptionValue(matchedMount),
		submitValue: getMountOptionSubmitValue(matchedMount),
	};
};

const getMountOptionLabel = (mount: MountSelectOption) =>
	mount.Destination?.trim() || getMountOptionValue(mount);

const renderMountSelectItem = (mount: MountSelectOption) => {
	const value = getMountOptionValue(mount);
	if (!value) return null;

	const label = getMountOptionLabel(mount);

	return (
		<SelectItem
			key={`${mount.Type}-${value}-${mount.Destination || ""}`}
			value={value}
			textValue={label}
		>
			<span className="whitespace-normal break-all text-left">{label}</span>
		</SelectItem>
	);
};

const createFormSchema = (t: (key: string) => string) =>
	z
		.object({
			name: z.string().min(1, t("volumeBackups.validation.nameRequired")),
			cronExpression: z
				.string()
				.min(1, t("volumeBackups.validation.cronRequired")),
			volumeName: z
				.string()
				.min(1, t("volumeBackups.validation.volumeNameRequired")),
			prefix: z.string().min(1, t("backups.handle.validation.prefixRequired")),
			keepLatestCount: z.coerce
				.number()
				.int()
				.gte(1, t("volumeBackups.validation.keepLatestMin"))
				.optional()
				.nullable(),
			turnOff: z.boolean().default(false),
			enabled: z.boolean().default(true),
			serviceType: z.enum([
				"application",
				"compose",
				"postgres",
				"mariadb",
				"mongo",
				"mysql",
				"redis",
			]),
			serviceName: z.string(),
			destinationId: z
				.string()
				.min(1, t("volumeBackups.validation.destinationRequired")),
		})
		.superRefine((data, ctx) => {
			const volumeName = data.volumeName.trim();
			const isAbsolutePath =
				volumeName.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(volumeName);
			const isVolumeName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volumeName);

			if (!isAbsolutePath && !isVolumeName) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: t("volumeBackups.validation.volumeNameInvalid"),
					path: ["volumeName"],
				});
			}

			if (data.serviceType === "compose" && !data.serviceName) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: t("volumeBackups.validation.serviceNameRequired"),
					path: ["serviceName"],
				});
			}
		});

interface Props {
	id?: string;
	volumeBackupId?: string;
	volumeBackupType?:
		| "application"
		| "compose"
		| "postgres"
		| "mariadb"
		| "mongo"
		| "mysql"
		| "redis";
}

export const HandleVolumeBackups = ({
	id,
	volumeBackupId,
	volumeBackupType,
}: Props) => {
	const { t } = useTranslation("common");
	const [isOpen, setIsOpen] = useState(false);
	const [cacheType, setCacheType] = useState<CacheType>("cache");
	const [keepLatestCountInput, setKeepLatestCountInput] = useState("");
	const [isAllMountsLocked, setIsAllMountsLocked] = useState(false);
	const selectedMountValueRef = useRef<{
		formValue: string;
		submitValue: string;
	} | null>(null);

	const utils = api.useUtils();
	const formSchema = createFormSchema(t);
	const form = useForm<z.infer<typeof formSchema>>({
		resolver: zodResolver(formSchema as any) as any,
		defaultValues: {
			name: "",
			cronExpression: "",
			volumeName: "",
			prefix: "/",
			keepLatestCount: undefined,
			turnOff: false,
			enabled: true,
			serviceName: "",
			serviceType: volumeBackupType,
		},
	});

	const serviceTypeForm = volumeBackupType;
	const { data: destinations } = api.destination.all.useQuery();
	const { data: volumeBackup } = api.volumeBackups.one.useQuery(
		{ volumeBackupId: volumeBackupId || "" },
		{ enabled: !!volumeBackupId },
	);

	const { data: mounts } = api.mounts.allNamedByApplicationId.useQuery(
		{ applicationId: id || "" },
		{ enabled: !!id && volumeBackupType === "application" },
	);

	const {
		data: services,
		isFetching: isPendingServices,
		error: errorServices,
		refetch: refetchServices,
	} = api.compose.loadServices.useQuery(
		{
			composeId: id || "",
			type: cacheType,
		},
		{
			retry: false,
			refetchOnWindowFocus: false,
			enabled: !!id && volumeBackupType === "compose",
		},
	);

	const serviceName = form.watch("serviceName");
	const volumeName = form.watch("volumeName");
	const supportsAllMounts =
		serviceTypeForm === "compose" || serviceTypeForm === "application";
	const isAllMounts = supportsAllMounts && isAllMountsLocked;

	const toggleAllMounts = () => {
		const nextLocked = !isAllMountsLocked;
		setIsAllMountsLocked(nextLocked);
		selectedMountValueRef.current = null;
		form.setValue("volumeName", nextLocked ? ALL_MOUNTS_VOLUME_NAME : "", {
			shouldDirty: true,
			shouldTouch: true,
			shouldValidate: true,
		});
	};

	const { data: mountsByService } = api.compose.loadMountsByService.useQuery(
		{
			composeId: id || "",
			serviceName,
		},
		{
			enabled: !!id && volumeBackupType === "compose" && !!serviceName,
		},
	);

	useEffect(() => {
		if (volumeBackupId && volumeBackup) {
			const uiVolumeName = toUiVolumeName(volumeBackup.volumeName);
			form.reset({
				name: volumeBackup.name,
				cronExpression: volumeBackup.cronExpression,
				volumeName: uiVolumeName,
				prefix: volumeBackup.prefix || "/",
				keepLatestCount: volumeBackup.keepLatestCount || undefined,
				turnOff: volumeBackup.turnOff,
				enabled: volumeBackup.enabled || false,
				serviceName: volumeBackup.serviceName || "",
				destinationId: volumeBackup.destinationId,
				serviceType: volumeBackup.serviceType,
			});
			setIsAllMountsLocked(isAllMountsValue(uiVolumeName));
			setKeepLatestCountInput(
				volumeBackup.keepLatestCount !== null &&
					volumeBackup.keepLatestCount !== undefined
					? String(volumeBackup.keepLatestCount)
					: "",
			);
		} else if (!volumeBackupId && !isAllMountsValue(volumeName)) {
			setIsAllMountsLocked(false);
		}
	}, [form, volumeBackup, volumeBackupId, volumeName]);

	const availableMountOptions = useMemo(() => {
		if (volumeBackupType === "compose") {
			return mountsByService || [];
		}

		if (volumeBackupType === "application") {
			return mounts || [];
		}

		return [];
	}, [mounts, mountsByService, volumeBackupType]);

	useEffect(() => {
		if (!isOpen || isAllMountsValue(form.getValues("volumeName"))) return;

		const currentValue = form.getValues("volumeName")?.trim();
		if (!currentValue) {
			selectedMountValueRef.current = null;
			return;
		}

		const matchedMount = resolveMountSelection(
			currentValue,
			availableMountOptions,
		);
		if (!matchedMount) {
			selectedMountValueRef.current = null;
			return;
		}

		const { formValue, submitValue } = matchedMount;
		selectedMountValueRef.current =
			formValue !== submitValue ? { formValue, submitValue } : null;

		if (formValue !== currentValue) {
			form.setValue("volumeName", formValue, {
				shouldDirty: false,
				shouldTouch: false,
				shouldValidate: true,
			});
		}
	}, [availableMountOptions, form, isOpen]);

	const { mutateAsync, isPending } = volumeBackupId
		? api.volumeBackups.update.useMutation()
		: api.volumeBackups.create.useMutation();

	const onSubmit = async (values: z.infer<typeof formSchema>) => {
		if (!id && !volumeBackupId) return;

		const preparedKeepLatestCount =
			keepLatestCountInput === "" ? null : (values.keepLatestCount ?? null);
		const selectedMount = selectedMountValueRef.current;
		const resolvedMount = resolveMountSelection(
			values.volumeName,
			availableMountOptions,
		);
		const preparedVolumeName =
			resolvedMount?.submitValue ??
			(selectedMount &&
			values.volumeName.trim() === selectedMount.formValue.trim()
				? selectedMount.submitValue
				: values.volumeName);

		await mutateAsync({
			...values,
			keepLatestCount: preparedKeepLatestCount,
			volumeName: preparedVolumeName,
			destinationId: values.destinationId,
			volumeBackupId: volumeBackupId || "",
			serviceType: volumeBackupType,
			...(volumeBackupType === "application" && {
				applicationId: id || "",
			}),
			...(volumeBackupType === "compose" && {
				composeId: id || "",
			}),
			...(volumeBackupType === "postgres" && {
				serverId: id || "",
			}),
			...(volumeBackupType === "postgres" && {
				postgresId: id || "",
			}),
			...(volumeBackupType === "mariadb" && {
				mariadbId: id || "",
			}),
			...(volumeBackupType === "mongo" && {
				mongoId: id || "",
			}),
			...(volumeBackupType === "mysql" && {
				mysqlId: id || "",
			}),
			...(volumeBackupType === "redis" && {
				redisId: id || "",
			}),
		})
			.then(() => {
				toast.success(
					t(
						volumeBackupId
							? "volumeBackups.handle.toast.update.success"
							: "volumeBackups.handle.toast.create.success",
					),
				);
				utils.volumeBackups.list.invalidate({
					id,
					volumeBackupType,
				});
				setIsOpen(false);
			})
			.catch((error) => {
				toast.error(
					error instanceof Error ? error.message : t("common.unknownError"),
				);
			});
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				{volumeBackupId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10"
					>
						<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button>
						<PlusCircle className="w-4 h-4 mr-2" />
						{t("volumeBackups.handle.button.open")}
					</Button>
				)}
			</DialogTrigger>
			<DialogContent
				className={cn(
					volumeBackupType === "compose" || volumeBackupType === "application"
						? "sm:max-w-2xl"
						: " sm:max-w-lg",
				)}
			>
				<DialogHeader>
					<DialogTitle>
						{volumeBackupId
							? t("volumeBackups.handle.dialog.title.update")
							: t("volumeBackups.handle.dialog.title.create")}
					</DialogTitle>
					<DialogDescription>
						{t("volumeBackups.handle.dialog.description")}
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel className="flex items-center gap-2">
										{t("volumeBackups.handle.field.name.label")}
									</FormLabel>
									<FormControl>
										<Input
											placeholder={t(
												"volumeBackups.handle.field.name.placeholder",
											)}
											{...field}
										/>
									</FormControl>
									<FormDescription>
										{t("volumeBackups.handle.field.name.description")}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<ScheduleFormField
							name="cronExpression"
							formControl={form.control}
						/>

						<FormField
							control={form.control}
							name="destinationId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("volumeBackups.handle.field.destination.label")}
									</FormLabel>
									<Select
										onValueChange={field.onChange}
										defaultValue={field.value}
									>
										<FormControl>
											<SelectTrigger>
												<SelectValue
													placeholder={t(
														"volumeBackups.handle.field.destination.placeholder",
													)}
												/>
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{destinations?.map((destination) => (
												<SelectItem
													key={destination.destinationId}
													value={destination.destinationId}
												>
													{destination.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormDescription>
										{t("volumeBackups.handle.field.destination.description")}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						{serviceTypeForm === "compose" && (
							<>
								<div className="flex flex-col w-full gap-4">
									{errorServices && (
										<AlertBlock
											type="warning"
											className="[overflow-wrap:anywhere]"
										>
											{errorServices?.message}
										</AlertBlock>
									)}
									<FormField
										control={form.control}
										name="serviceName"
										render={({ field }) => (
											<FormItem className="w-full">
												<FormLabel>
													{t("volumeBackups.handle.field.serviceName.label")}
												</FormLabel>
												<div className="flex gap-2">
													<Select
														onValueChange={field.onChange}
														defaultValue={field.value || ""}
													>
														<FormControl>
															<SelectTrigger>
																<SelectValue
																	placeholder={t(
																		"volumeBackups.handle.field.serviceName.placeholder",
																	)}
																/>
															</SelectTrigger>
														</FormControl>

														<SelectContent>
															{services?.map((service, index) => (
																<SelectItem
																	value={service}
																	key={`${service}-${index}`}
																>
																	{service}
																</SelectItem>
															))}
															<SelectItem value="none" disabled>
																{t(
																	"volumeBackups.handle.field.serviceName.emptyOption",
																)}
															</SelectItem>
														</SelectContent>
													</Select>
													<TooltipProvider delayDuration={0}>
														<Tooltip>
															<TooltipTrigger asChild>
																<Button
																	variant="secondary"
																	type="button"
																	isPending={isPendingServices}
																	onClick={() => {
																		if (cacheType === "fetch") {
																			refetchServices();
																		} else {
																			setCacheType("fetch");
																		}
																	}}
																>
																	<RefreshCw className="size-4 text-muted-foreground" />
																</Button>
															</TooltipTrigger>
															<TooltipContent
																side="left"
																sideOffset={5}
																className="max-w-[10rem]"
															>
																<p>{t("backups.restore.tooltip.fetch")}</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
													<TooltipProvider delayDuration={0}>
														<Tooltip>
															<TooltipTrigger asChild>
																<Button
																	variant="secondary"
																	type="button"
																	isPending={isPendingServices}
																	onClick={() => {
																		if (cacheType === "cache") {
																			refetchServices();
																		} else {
																			setCacheType("cache");
																		}
																	}}
																>
																	<DatabaseZap className="size-4 text-muted-foreground" />
																</Button>
															</TooltipTrigger>
															<TooltipContent
																side="left"
																sideOffset={5}
																className="max-w-[10rem]"
															>
																<p>{t("backups.restore.tooltip.cache")}</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
												</div>

												<FormMessage />
											</FormItem>
										)}
									/>
								</div>
								{((mountsByService && mountsByService.length > 0) ||
									isAllMounts) && (
									<FormField
										control={form.control}
										name="volumeName"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													{t("volumeBackups.handle.field.volumeSelect.label")}
												</FormLabel>
												<div className="flex items-center gap-2">
													<div
														className={cn(
															"flex-1",
															isAllMounts && "pointer-events-none opacity-60",
														)}
													>
														<Select
															onValueChange={(value) => {
																if (isAllMounts) return;
																const selectedMount = mountsByService?.find(
																	(mount) =>
																		getMountOptionValue(mount) === value,
																);
																selectedMountValueRef.current = selectedMount
																	? {
																			formValue:
																				getMountOptionValue(selectedMount),
																			submitValue:
																				getMountOptionSubmitValue(
																					selectedMount,
																				),
																		}
																	: null;
																field.onChange(value);
															}}
															value={field.value || ""}
															disabled={isAllMounts}
														>
															<FormControl>
																<SelectTrigger className="text-left">
																	<SelectValue
																		placeholder={t(
																			"volumeBackups.handle.field.volumeSelect.placeholder",
																		)}
																	/>
																</SelectTrigger>
															</FormControl>
															<SelectContent>
																{mountsByService?.map(renderMountSelectItem)}
															</SelectContent>
														</Select>
													</div>
													<Button
														size="sm"
														type="button"
														variant={isAllMounts ? "default" : "outline"}
														className="h-10 shrink-0"
														onClick={toggleAllMounts}
													>
														{t("filter.all")}
													</Button>
												</div>
												<FormDescription>
													{t(
														"volumeBackups.handle.field.volumeSelect.description",
													)}
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>
								)}
							</>
						)}
						{serviceTypeForm === "application" && (
							<FormField
								control={form.control}
								name="volumeName"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{t("volumeBackups.handle.field.volumeSelect.label")}
										</FormLabel>
										<div className="flex items-center gap-2">
											<div
												className={cn(
													"flex-1",
													isAllMounts && "pointer-events-none opacity-60",
												)}
											>
												<Select
													onValueChange={(value) => {
														if (isAllMounts) return;
														const selectedMount = mounts?.find(
															(mount) => getMountOptionValue(mount) === value,
														);
														selectedMountValueRef.current = selectedMount
															? {
																	formValue: getMountOptionValue(selectedMount),
																	submitValue:
																		getMountOptionSubmitValue(selectedMount),
																}
															: null;
														field.onChange(value);
													}}
													value={field.value || ""}
													disabled={isAllMounts}
												>
													<FormControl>
														<SelectTrigger className="text-left">
															<SelectValue
																placeholder={t(
																	"volumeBackups.handle.field.volumeSelect.placeholder",
																)}
															/>
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														{mounts?.map(renderMountSelectItem)}
													</SelectContent>
												</Select>
											</div>
											<Button
												size="sm"
												type="button"
												variant={isAllMounts ? "default" : "outline"}
												className="h-10 shrink-0"
												onClick={toggleAllMounts}
											>
												{t("filter.all")}
											</Button>
										</div>
										<FormDescription>
											{t("volumeBackups.handle.field.volumeSelect.description")}
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						<FormField
							control={form.control}
							name="volumeName"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("volumeBackups.handle.field.volumeName.label")}
									</FormLabel>
									<FormControl>
										<Input
											placeholder={t(
												"volumeBackups.handle.field.volumeName.placeholder",
											)}
											{...field}
											value={
												isAllMounts ? t("filter.all") : (field.value ?? "")
											}
											onChange={(event) => {
												if (isAllMounts) return;
												if (
													selectedMountValueRef.current &&
													event.target.value.trim() !==
														selectedMountValueRef.current.formValue.trim()
												) {
													selectedMountValueRef.current = null;
												}
												field.onChange(event);
											}}
											disabled={isAllMounts}
											readOnly={isAllMounts}
										/>
									</FormControl>
									<FormDescription>
										{t("volumeBackups.handle.field.volumeName.description")}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="prefix"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("backups.field.prefixStorage")}</FormLabel>
									<FormControl>
										<Input placeholder="/" {...field} />
									</FormControl>
									<FormDescription>
										{t("backups.handle.field.prefixDescription")}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="keepLatestCount"
							render={({ field }) => (
								<FormItem>
									<FormLabel>
										{t("volumeBackups.handle.field.keepLatest.label")}
									</FormLabel>
									<FormControl>
										<Input
											{...field}
											type="number"
											min={1}
											autoComplete="off"
											placeholder={t(
												"volumeBackups.handle.field.keepLatest.placeholder",
											)}
											value={keepLatestCountInput}
											onChange={(e) => {
												const raw = e.target.value;
												setKeepLatestCountInput(raw);
												if (raw === "") {
													field.onChange(undefined);
												} else if (/^\d+$/.test(raw)) {
													field.onChange(Number(raw));
												}
											}}
										/>
									</FormControl>
									<FormDescription>
										{t("volumeBackups.handle.field.keepLatest.description")}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="turnOff"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
									<div className="space-y-0.5">
										<FormLabel className="text-base">
											{t("volumeBackups.handle.field.turnOff.label")}
										</FormLabel>
										<FormDescription className="text-muted-foreground">
											{t("volumeBackups.handle.field.turnOff.description")}
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="enabled"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-4 shadow-sm">
									<div className="space-y-0.5">
										<FormLabel className="text-base">
											{t("volumeBackups.handle.field.enabled.label")}
										</FormLabel>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>

						<Button type="submit" isPending={isPending} className="w-full">
							{volumeBackupId
								? t("volumeBackups.handle.button.update")
								: t("volumeBackups.handle.button.create")}
						</Button>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};

