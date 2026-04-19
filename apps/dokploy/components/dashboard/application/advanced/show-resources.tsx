import { zodResolver } from "@hookform/resolvers/zod";
import { InfoIcon, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

const ulimitSchema = z.object({
	Name: z.string().min(1),
	Soft: z.coerce.number().int().min(-1),
	Hard: z.coerce.number().int().min(-1),
});

const addResourcesSchema = z.object({
	memoryReservation: z.string().optional(),
	cpuLimit: z.string().optional(),
	memoryLimit: z.string().optional(),
	cpuReservation: z.string().optional(),
	ulimitsSwarm: z.array(ulimitSchema).optional(),
});

const ULIMIT_PRESETS = [
	{ value: "nofile", label: "nofile" },
	{ value: "nproc", label: "nproc" },
	{ value: "memlock", label: "memlock" },
	{ value: "stack", label: "stack" },
	{ value: "core", label: "core" },
	{ value: "cpu", label: "cpu" },
	{ value: "data", label: "data" },
	{ value: "fsize", label: "fsize" },
	{ value: "locks", label: "locks" },
	{ value: "msgqueue", label: "msgqueue" },
	{ value: "nice", label: "nice" },
	{ value: "rtprio", label: "rtprio" },
	{ value: "sigpending", label: "sigpending" },
] as const;

export type ServiceType =
	| "postgres"
	| "mongo"
	| "redis"
	| "mysql"
	| "mariadb"
	| "application";

interface Props {
	id: string;
	type: ServiceType | "application";
}

type AddResources = z.infer<typeof addResourcesSchema>;
export const ShowResources = ({ id, type }: Props) => {
	const { t } = useTranslation("common");
	const queryMap = {
		postgres: () =>
			api.postgres.one.useQuery({ postgresId: id }, { enabled: !!id }),
		redis: () => api.redis.one.useQuery({ redisId: id }, { enabled: !!id }),
		mysql: () => api.mysql.one.useQuery({ mysqlId: id }, { enabled: !!id }),
		mariadb: () =>
			api.mariadb.one.useQuery({ mariadbId: id }, { enabled: !!id }),
		application: () =>
			api.application.one.useQuery({ applicationId: id }, { enabled: !!id }),
		mongo: () => api.mongo.one.useQuery({ mongoId: id }, { enabled: !!id }),
	};
	const { data, refetch } = queryMap[type]
		? queryMap[type]()
		: api.mongo.one.useQuery({ mongoId: id }, { enabled: !!id });

	const mutationMap = {
		postgres: () => api.postgres.update.useMutation(),
		redis: () => api.redis.update.useMutation(),
		mysql: () => api.mysql.update.useMutation(),
		mariadb: () => api.mariadb.update.useMutation(),
		application: () => api.application.update.useMutation(),
		mongo: () => api.mongo.update.useMutation(),
	};

	const { mutateAsync, isPending } = mutationMap[type]
		? mutationMap[type]()
		: api.mongo.update.useMutation();

	const form = useForm<AddResources>({
		defaultValues: {
			cpuLimit: "",
			cpuReservation: "",
			memoryLimit: "",
			memoryReservation: "",
			ulimitsSwarm: [],
		},
		resolver: zodResolver(addResourcesSchema as any) as any,
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "ulimitsSwarm",
	});

	useEffect(() => {
		if (data) {
			form.reset({
				cpuLimit: data?.cpuLimit || undefined,
				cpuReservation: data?.cpuReservation || undefined,
				memoryLimit: data?.memoryLimit || undefined,
				memoryReservation: data?.memoryReservation || undefined,
				ulimitsSwarm: data?.ulimitsSwarm || [],
			});
		}
	}, [data, form, form.reset]);

	const onSubmit = async (formData: AddResources) => {
		await mutateAsync({
			mongoId: id || "",
			postgresId: id || "",
			redisId: id || "",
			mysqlId: id || "",
			mariadbId: id || "",
			applicationId: id || "",
			cpuLimit: formData.cpuLimit || null,
			cpuReservation: formData.cpuReservation || null,
			memoryLimit: formData.memoryLimit || null,
			memoryReservation: formData.memoryReservation || null,
			ulimitsSwarm:
				formData.ulimitsSwarm && formData.ulimitsSwarm.length > 0
					? formData.ulimitsSwarm
					: null,
		})
			.then(async () => {
				toast.success(t("resources.toast.updateSuccess"));
				await refetch();
			})
			.catch(() => {
				toast.error(t("resources.toast.updateError"));
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">{t("resources.card.title")}</CardTitle>
				<CardDescription>{t("resources.card.description")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<AlertBlock type="info">
					{t("resources.alert.redeployReminder")}
				</AlertBlock>
				<Form {...form}>
					<form
						id="hook-form"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-8 "
					>
						<div className="grid w-full md:grid-cols-2 gap-4">
							<FormField
								control={form.control}
								name="memoryLimit"
								render={({ field }) => {
									return (
										<FormItem>
											<div
												className="flex items-center gap-2"
												onClick={(e) => e.preventDefault()}
											>
												<FormLabel>
													{t("resources.form.memoryLimitLabel")}
												</FormLabel>
												<TooltipProvider>
													<Tooltip delayDuration={0}>
														<TooltipTrigger>
															<InfoIcon className="h-4 w-4 text-muted-foreground" />
														</TooltipTrigger>
														<TooltipContent>
															<p>{t("resources.tooltip.memoryLimit")}</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</div>
											<FormControl>
												<Input
													placeholder={t(
														"resources.form.memoryLimitPlaceholder",
													)}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
							<FormField
								control={form.control}
								name="memoryReservation"
								render={({ field }) => (
									<FormItem>
										<div
											className="flex items-center gap-2"
											onClick={(e) => e.preventDefault()}
										>
											<FormLabel>
												{t("resources.form.memoryReservationLabel")}
											</FormLabel>
											<TooltipProvider>
												<Tooltip delayDuration={0}>
													<TooltipTrigger>
														<InfoIcon className="h-4 w-4 text-muted-foreground" />
													</TooltipTrigger>
													<TooltipContent>
														<p>{t("resources.tooltip.memoryReservation")}</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</div>
										<FormControl>
											<Input
												placeholder={t(
													"resources.form.memoryReservationPlaceholder",
												)}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="cpuLimit"
								render={({ field }) => {
									return (
										<FormItem>
											<div
												className="flex items-center gap-2"
												onClick={(e) => e.preventDefault()}
											>
												<FormLabel>
													{t("resources.form.cpuLimitLabel")}
												</FormLabel>
												<TooltipProvider>
													<Tooltip delayDuration={0}>
														<TooltipTrigger>
															<InfoIcon className="h-4 w-4 text-muted-foreground" />
														</TooltipTrigger>
														<TooltipContent>
															<p>{t("resources.tooltip.cpuLimit")}</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</div>
											<FormControl>
												<Input
													placeholder={t("resources.form.cpuLimitPlaceholder")}
													{...field}
													value={field.value?.toString() || ""}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
							<FormField
								control={form.control}
								name="cpuReservation"
								render={({ field }) => {
									return (
										<FormItem>
											<div
												className="flex items-center gap-2"
												onClick={(e) => e.preventDefault()}
											>
												<FormLabel>
													{t("resources.form.cpuReservationLabel")}
												</FormLabel>
												<TooltipProvider>
													<Tooltip delayDuration={0}>
														<TooltipTrigger>
															<InfoIcon className="h-4 w-4 text-muted-foreground" />
														</TooltipTrigger>
														<TooltipContent>
															<p>{t("resources.tooltip.cpuReservation")}</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</div>
											<FormControl>
												<Input
													placeholder={t(
														"resources.form.cpuReservationPlaceholder",
													)}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									);
								}}
							/>
						</div>
						<div className="space-y-4">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<FormLabel className="text-base">
										{t("resources.form.ulimitsLabel")}
									</FormLabel>
									<TooltipProvider>
										<Tooltip delayDuration={0}>
											<TooltipTrigger>
												<InfoIcon className="h-4 w-4 text-muted-foreground" />
											</TooltipTrigger>
											<TooltipContent>
												<p>{t("resources.tooltip.ulimits")}</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => append({ Name: "nofile", Soft: 65535, Hard: 65535 })}
								>
									<Plus className="mr-1 h-4 w-4" />
									{t("resources.form.addUlimit")}
								</Button>
							</div>

							{fields.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									{t("resources.form.noUlimits")}
								</p>
							) : (
								<div className="space-y-3">
									{fields.map((field, index) => (
										<div
											key={field.id}
											className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3"
										>
											<FormField
												control={form.control}
												name={`ulimitsSwarm.${index}.Name`}
												render={({ field }) => (
													<FormItem className="flex-1">
														<FormLabel className="text-xs">
															{t("resources.form.ulimitType")}
														</FormLabel>
														<Select
															onValueChange={field.onChange}
															value={field.value}
														>
															<FormControl>
																<SelectTrigger>
																	<SelectValue
																		placeholder={t("resources.form.selectUlimit")}
																	/>
																</SelectTrigger>
															</FormControl>
															<SelectContent>
																{ULIMIT_PRESETS.map((preset) => (
																	<SelectItem
																		key={preset.value}
																		value={preset.value}
																	>
																		{preset.label}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
														<FormMessage />
													</FormItem>
												)}
											/>
											<FormField
												control={form.control}
												name={`ulimitsSwarm.${index}.Soft`}
												render={({ field }) => (
													<FormItem className="w-32">
														<FormLabel className="text-xs">
															{t("resources.form.softLimit")}
														</FormLabel>
														<FormControl>
															<Input
																type="number"
																min={-1}
																{...field}
																onChange={(event) =>
																	field.onChange(Number(event.target.value))
																}
															/>
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
											<FormField
												control={form.control}
												name={`ulimitsSwarm.${index}.Hard`}
												render={({ field }) => (
													<FormItem className="w-32">
														<FormLabel className="text-xs">
															{t("resources.form.hardLimit")}
														</FormLabel>
														<FormControl>
															<Input
																type="number"
																min={-1}
																{...field}
																onChange={(event) =>
																	field.onChange(Number(event.target.value))
																}
															/>
														</FormControl>
														<FormMessage />
													</FormItem>
												)}
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="mt-6 text-destructive hover:text-destructive"
												onClick={() => remove(index)}
											>
												<Trash2 className="h-4 w-4" />
											</Button>
										</div>
									))}
								</div>
							)}
						</div>
						<div className="flex w-full justify-end">
							<Button isPending={isPending} type="submit">
								{t("button.save")}
							</Button>
						</div>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};

