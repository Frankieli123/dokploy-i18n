"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
	Check,
	CheckCircle2,
	ChevronDown,
	Circle,
	Loader2,
	PenBoxIcon,
	PlusIcon,
	Trash2,
	XCircle,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { CardDescription } from "@/components/ui/card";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
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
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
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
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { translateErrorMessage } from "@/utils/error-translation";

const providerTypeSchema = z.enum([
	"openai",
	"azure",
	"anthropic",
	"cohere",
	"perplexity",
	"mistral",
	"ollama",
	"deepinfra",
	"deepseek",
	"gemini",
	"openai_compatible",
]);

const baseEmbeddingSchema = z.object({
	providerType: providerTypeSchema.default("openai_compatible"),
	apiUrl: z.string().url(),
	apiKey: z.string().optional(),
	model: z.string().min(1),
});

type BaseSchema = z.infer<typeof baseEmbeddingSchema>;

const normalizeEmbeddingSchema = (data: BaseSchema): BaseSchema => {
	const trimmed = data.apiUrl.replace(/\/+$/, "");
	const fixed = trimmed
		.replace(/\/v1beta\/v1$/, "/v1beta")
		.replace(/\/beta\/v1$/, "/beta")
		.replace(/\/v2\/v2$/, "/v2")
		.replace(/\/v1\/v1$/, "/v1");
	const apiKey = data.apiKey?.trim() || "";
	const model = data.model.trim();

	if (data.providerType === "gemini") {
		return {
			...data,
			apiUrl: fixed.replace(/\/v1beta$/, ""),
			apiKey,
			model,
		};
	}

	return { ...data, apiUrl: fixed, apiKey, model };
};

const embeddingSchema = baseEmbeddingSchema.transform(normalizeEmbeddingSchema);

const createEmbeddingSchema = (t: (key: string) => string) =>
	baseEmbeddingSchema
		.extend({
			apiUrl: baseEmbeddingSchema.shape.apiUrl.url({
				message: t("settings.ai.validation.apiUrlInvalid"),
			}),
			model: baseEmbeddingSchema.shape.model.min(1, {
				message: t("settings.ai.validation.modelRequired"),
			}),
		})
		.transform(normalizeEmbeddingSchema);

type Schema = z.infer<typeof embeddingSchema>;

export const AiEmbeddingProviderForm = () => {
	const { t } = useTranslation("settings");
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [modelPopoverOpen, setModelPopoverOpen] = useState(false);
	const [modelSearch, setModelSearch] = useState("");

	const {
		data: embeddingProvider,
		refetch: refetchEmbeddingProvider,
		isPending: isPendingEmbeddingProvider,
	} = api.ai.embeddingProvider.get.useQuery();
	const { mutateAsync: upsertEmbeddingProvider, isPending: isSaving } =
		api.ai.embeddingProvider.upsert.useMutation();
	const { mutateAsync: deleteEmbeddingProvider, isPending: isDeleting } =
		api.ai.embeddingProvider.delete.useMutation();

	const {
		data: testResult,
		refetch: refetchTest,
		isPending: isTesting,
		isRefetching: isRetesting,
	} = api.ai.embeddingProvider.test.useQuery(undefined, {
		enabled: !!embeddingProvider,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const { data: diagnostics } = api.ai.embeddingProvider.diagnostics.useQuery(
		undefined,
		{
			enabled: !!embeddingProvider,
			refetchOnWindowFocus: false,
		},
	);

	const schema = createEmbeddingSchema(t);

	const form = useForm<Schema>({
		resolver: zodResolver(schema as any) as any,
		defaultValues: {
			providerType: "openai_compatible",
			apiUrl: "https://api.openai.com/v1",
			apiKey: "",
			model: "",
		},
	});

	useEffect(() => {
		if (embeddingProvider) {
			const parsedProviderType = providerTypeSchema.safeParse(
				embeddingProvider.providerType,
			);
			const providerType = parsedProviderType.success
				? parsedProviderType.data
				: "openai_compatible";
			const displayApiUrl = (() => {
				const raw = (embeddingProvider.apiUrl ?? "https://api.openai.com/v1")
					.replace(/\/+$/, "")
					.trim();
				if (providerType === "gemini") return raw.replace(/\/v1beta$/, "");
				return raw;
			})();

			form.reset({
				providerType,
				apiUrl: displayApiUrl,
				apiKey: embeddingProvider.apiKey ?? "",
				model: embeddingProvider.model ?? "",
			});
		} else {
			form.reset({
				providerType: "openai_compatible",
				apiUrl: "https://api.openai.com/v1",
				apiKey: "",
				model: "",
			});
		}
		setError(null);
		setModelSearch("");
		setModelPopoverOpen(false);
	}, [embeddingProvider, form]);

	const apiUrl = form.watch("apiUrl");
	const apiKey = form.watch("apiKey");
	const providerType = form.watch("providerType");
	const isOllama = providerType === "ollama";

	const {
		data: models,
		isLoading: isPendingServerModels,
		error: fetchModelsError,
	} =
		api.ai.getModels.useQuery(
			{
				apiUrl: apiUrl ?? "",
				apiKey: apiKey ?? "",
				providerType: providerType ?? "openai_compatible",
			},
			{
				enabled: !!apiUrl && (isOllama || !!apiKey),
			},
		);

	useEffect(() => {
		if (fetchModelsError) {
			setError(
				t("settings.ai.models.fetchError", { error: fetchModelsError.message }),
			);
		}
	}, [fetchModelsError, t]);

	const currentVectorCount = diagnostics?.embeddedPlaybooks ?? 0;
	const totalPlaybookCount = diagnostics?.totalPlaybooks ?? 0;

	const onSubmit = async (data: Schema) => {
		try {
			await upsertEmbeddingProvider({
				providerType: data.providerType,
				apiUrl: data.apiUrl,
				apiKey: data.apiKey ?? "",
				model: data.model,
			});

			utils.ai.embeddingProvider.get.invalidate();
			utils.ai.embeddingProvider.test.invalidate();
			utils.ai.embeddingProvider.diagnostics.invalidate();
			toast.success(t("settings.ai.embeddingProvider.toast.saveSuccess"));
			refetchEmbeddingProvider();
			setOpen(false);
		} catch (error) {
			const errorMessage =
				error instanceof Error
					? error.message
					: t("settings.ai.toast.unknownError");
			toast.error(t("settings.ai.embeddingProvider.toast.saveError"), {
				description: translateErrorMessage(errorMessage, t),
			});
		}
	};

	if (isPendingEmbeddingProvider) {
		return (
			<div className="flex items-center justify-between bg-sidebar p-1 w-full rounded-lg">
				<div className="flex items-center justify-between p-3.5 rounded-lg bg-background border w-full">
					<div className="space-y-2">
						<div className="h-4 w-32 bg-muted/50 rounded animate-pulse" />
						<div className="h-3 w-48 bg-muted/50 rounded animate-pulse" />
					</div>
					<div className="h-8 w-8 bg-muted/50 rounded animate-pulse" />
				</div>
			</div>
		);
	}

	return (
		<div className="bg-sidebar p-1 w-full rounded-lg">
			<div className="p-3.5 rounded-lg bg-background border w-full space-y-3">
				<div className="flex items-center justify-between gap-3">
					<div>
					<span className="text-sm font-medium">
						{t("settings.ai.embeddingProvider.title")}
					</span>
					<CardDescription>
						{embeddingProvider
							? `${embeddingProvider.model} (${embeddingProvider.providerType})`
							: t("settings.ai.embeddingProvider.empty")}
					</CardDescription>
				</div>

				<div className="flex items-center">
					{embeddingProvider && (
						<TooltipProvider delayDuration={0}>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="hover:bg-transparent"
										onClick={(e) => {
											e.preventDefault();
											refetchTest();
										}}
									>
										{(isTesting || isRetesting) && (
											<Loader2 className="size-4 animate-spin text-muted-foreground" />
										)}
										{!(isTesting || isRetesting) &&
											testResult?.status === "ok" && (
												<CheckCircle2 className="size-4 text-green-500" />
											)}
										{!(isTesting || isRetesting) &&
											testResult?.status === "error" && (
												<XCircle className="size-4 text-red-500" />
											)}
										{!(isTesting || isRetesting) &&
											(!testResult ||
												testResult.status === "not_configured") && (
												<Circle className="size-4 text-muted-foreground" />
											)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{(isTesting || isRetesting) &&
										t("settings.ai.embeddingProvider.test.testing")}
									{!(isTesting || isRetesting) &&
										testResult?.status === "ok" && (
											<div className="flex flex-col gap-1 text-xs">
												<span className="font-semibold text-green-500">
													{t("settings.ai.embeddingProvider.test.status.ok")}
												</span>
												<span>
													{t("settings.ai.embeddingProvider.test.model")}:{" "}
													{testResult.model}
												</span>
												<span>
													{t("settings.ai.embeddingProvider.test.dim")}:{" "}
													{testResult.dim}
												</span>
												<span>
													{t("settings.ai.embeddingProvider.test.vectors")}:{" "}
													{`${currentVectorCount} / ${totalPlaybookCount}`}
												</span>
												{testResult.latencyMs && (
													<span>
														{t("settings.ai.embeddingProvider.test.latency")}:{" "}
														{testResult.latencyMs}ms
													</span>
												)}
											</div>
										)}
									{!(isTesting || isRetesting) &&
										testResult?.status === "error" && (
											<div className="flex flex-col gap-1 text-xs max-w-[250px]">
												<span className="font-semibold text-red-500">
													{t("settings.ai.embeddingProvider.test.status.error")}
												</span>
												<span className="text-muted-foreground">
													{t("settings.ai.embeddingProvider.test.fallback")}
												</span>
												<span>
													{t("settings.ai.embeddingProvider.test.vectors")}:{" "}
													{`${currentVectorCount} / ${totalPlaybookCount}`}
												</span>
												{testResult.error && (
													<span className="break-words">{testResult.error}</span>
												)}
											</div>
										)}
									{!(isTesting || isRetesting) &&
										(!testResult ||
											testResult.status === "not_configured") && (
											<div className="flex flex-col gap-1 text-xs">
												<span>
													{t(
														"settings.ai.embeddingProvider.test.status.notConfigured",
													)}
												</span>
												<span className="text-muted-foreground">
													{t("settings.ai.embeddingProvider.test.fallback")}
												</span>
												<span>
													{t("settings.ai.embeddingProvider.test.vectors")}:{" "}
													{`${currentVectorCount} / ${totalPlaybookCount}`}
												</span>
											</div>
										)}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					)}
					{embeddingProvider && (
						<DialogAction
							title={t("settings.ai.embeddingProvider.delete.title")}
							description={t("settings.ai.embeddingProvider.delete.description")}
							type="destructive"
							onClick={async () => {
								await deleteEmbeddingProvider()
									.then(() => {
										toast.success(
											t("settings.ai.embeddingProvider.delete.success"),
										);
										refetchEmbeddingProvider();
										utils.ai.embeddingProvider.test.invalidate();
										utils.ai.embeddingProvider.diagnostics.invalidate();
									})
									.catch(() => {
										toast.error(
											t("settings.ai.embeddingProvider.delete.error"),
										);
									});
							}}
						>
							<Button
								variant="ghost"
								size="icon"
								className="group hover:bg-red-500/10 "
								isPending={isDeleting}
							>
								<Trash2 className="size-4 text-primary group-hover:text-red-500" />
							</Button>
						</DialogAction>
					)}

					<Dialog
						open={open}
						onOpenChange={(isOpen) => {
							setOpen(isOpen);
							if (!isOpen) {
								setModelSearch("");
								setModelPopoverOpen(false);
							}
						}}
					>
						<DialogTrigger asChild>
							{embeddingProvider ? (
								<Button
									variant="ghost"
									size="icon"
									className="group hover:bg-blue-500/10 "
								>
									<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
								</Button>
							) : (
								<Button className="cursor-pointer space-x-3">
									<PlusIcon className="h-4 w-4" />
									{t("settings.ai.embeddingProvider.form.configure")}
								</Button>
							)}
						</DialogTrigger>
						<DialogContent className="sm:max-w-lg">
							<DialogHeader>
								<DialogTitle>
									{embeddingProvider
										? t("settings.ai.embeddingProvider.form.editTitle")
										: t("settings.ai.embeddingProvider.form.addTitle")}
								</DialogTitle>
								<DialogDescription>
									{t("settings.ai.embeddingProvider.form.description")}
								</DialogDescription>
							</DialogHeader>
							<Form {...form}>
								{error && <AlertBlock type="error">{error}</AlertBlock>}
								<form
									onSubmit={form.handleSubmit(onSubmit)}
									className="space-y-2"
								>
									<FormField
										control={form.control}
										name="providerType"
										render={({ field }) => (
											<FormItem>
												<FormLabel>
													{t("settings.ai.form.providerType.label")}
												</FormLabel>
												<Select
													onValueChange={(value) => {
														field.onChange(value);
														form.setValue("model", "");
														if (value === "openai") {
															form.setValue(
																"apiUrl",
																"https://api.openai.com/v1",
															);
														} else if (value === "gemini") {
															form.setValue(
																"apiUrl",
																"https://generativelanguage.googleapis.com/v1beta",
															);
														} else if (value === "ollama") {
															form.setValue("apiUrl", "http://localhost:11434");
														} else if (value === "anthropic") {
															form.setValue(
																"apiUrl",
																"https://api.anthropic.com",
															);
														}
													}}
													value={field.value}
												>
													<FormControl>
														<SelectTrigger>
															<SelectValue
																placeholder={t(
																	"settings.ai.form.providerType.placeholder",
																)}
															/>
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														<SelectItem value="openai">
															{t("settings.ai.form.providerType.options.openai")}
														</SelectItem>
														<SelectItem value="azure">
															{t("settings.ai.form.providerType.options.azure")}
														</SelectItem>
														<SelectItem value="anthropic">
															{t(
																"settings.ai.form.providerType.options.anthropic",
															)}
														</SelectItem>
														<SelectItem value="cohere">
															{t("settings.ai.form.providerType.options.cohere")}
														</SelectItem>
														<SelectItem value="gemini">
															{t("settings.ai.form.providerType.options.gemini")}
														</SelectItem>
														<SelectItem value="ollama">
															{t("settings.ai.form.providerType.options.ollama")}
														</SelectItem>
														<SelectItem value="mistral">
															{t("settings.ai.form.providerType.options.mistral")}
														</SelectItem>
														<SelectItem value="perplexity">
															{t(
																"settings.ai.form.providerType.options.perplexity",
															)}
														</SelectItem>
														<SelectItem value="deepinfra">
															{t(
																"settings.ai.form.providerType.options.deepinfra",
															)}
														</SelectItem>
														<SelectItem value="deepseek">
															{t(
																"settings.ai.form.providerType.options.deepseek",
															)}
														</SelectItem>
														<SelectItem value="openai_compatible">
															{t(
																"settings.ai.form.providerType.options.openai_compatible",
															)}
														</SelectItem>
													</SelectContent>
												</Select>
												<FormDescription>
													{t("settings.ai.form.providerType.description")}
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>

									<FormField
										control={form.control}
										name="apiUrl"
										render={({ field }) => (
											<FormItem>
												<FormLabel>{t("settings.ai.form.apiUrl.label")}</FormLabel>
												<FormControl>
													<Input
														placeholder={t("settings.ai.form.apiUrl.placeholder")}
														{...field}
														onChange={(e) => {
															field.onChange(e);
															if (form.getValues("model")) {
																form.setValue("model", "");
															}
														}}
													/>
												</FormControl>
												<FormDescription>
													{t("settings.ai.form.apiUrl.description")}
												</FormDescription>
												<FormMessage />
											</FormItem>
										)}
									/>

									{!isOllama && (
										<FormField
											control={form.control}
											name="apiKey"
											render={({ field }) => (
												<FormItem>
													<FormLabel>
														{t("settings.ai.form.apiKey.label")}
													</FormLabel>
													<FormControl>
														<Input
															type="password"
															placeholder={t(
																"settings.ai.form.apiKey.placeholder",
															)}
															autoComplete="one-time-code"
															{...field}
															onChange={(e) => {
																field.onChange(e);
																if (form.getValues("model")) {
																	form.setValue("model", "");
																}
															}}
														/>
													</FormControl>
													<FormDescription>
														{t("settings.ai.form.apiKey.description")}
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									)}

									{isPendingServerModels && (
										<span className="text-sm text-muted-foreground">
											{t("settings.ai.models.loading")}
										</span>
									)}

									{!isPendingServerModels && !models?.length && (
										<FormField
											control={form.control}
											name="model"
											render={({ field }) => (
												<FormItem>
													<FormLabel>{t("settings.ai.form.model.label")}</FormLabel>
													<FormControl>
														<Input
															placeholder={t(
																"settings.ai.form.model.placeholder",
															)}
															{...field}
														/>
													</FormControl>
													<FormDescription>
														{t("settings.ai.form.model.description")}
													</FormDescription>
													<FormMessage />
												</FormItem>
											)}
										/>
									)}

									{!isPendingServerModels && models && models.length > 0 && (
										<FormField
											control={form.control}
											name="model"
											render={({ field }) => {
												const selectedModel = models.find(
													(m) => m.id === field.value,
												);
												const filteredModels = models.filter((model) =>
													model.id
														.toLowerCase()
														.includes(modelSearch.toLowerCase()),
												);

												const displayModels =
													field.value &&
													!filteredModels.find((m) => m.id === field.value) &&
													selectedModel
														? [selectedModel, ...filteredModels]
														: filteredModels;

												return (
													<FormItem>
														<FormLabel>
															{t("settings.ai.form.model.label")}
														</FormLabel>
														<Popover
															open={modelPopoverOpen}
															onOpenChange={setModelPopoverOpen}
														>
															<PopoverTrigger asChild>
																<FormControl>
																	<Button
																		variant="outline"
																		className={cn(
																			"w-full justify-between",
																			!field.value && "text-muted-foreground",
																		)}
																	>
																		{field.value
																			? (selectedModel?.id ?? field.value)
																			: t(
																					"settings.ai.form.model.placeholder",
																				)}
																		<ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
																	</Button>
																</FormControl>
															</PopoverTrigger>
															<PopoverContent
																className="w-[400px] p-0"
																align="start"
															>
																<Command>
																	<CommandInput
																		placeholder={t(
																			"settings.ai.form.model.searchPlaceholder",
																		)}
																		value={modelSearch}
																		onValueChange={setModelSearch}
																	/>
																	<CommandList>
																		<CommandEmpty>
																			{t("settings.ai.models.notFound")}
																		</CommandEmpty>
																		{displayModels.map((model) => {
																			const isSelected =
																				field.value === model.id;
																			return (
																				<CommandItem
																					key={model.id}
																					value={model.id}
																					onSelect={() => {
																						field.onChange(model.id);
																						setModelPopoverOpen(false);
																						setModelSearch("");
																					}}
																				>
																					<Check
																						className={cn(
																							"mr-2 h-4 w-4",
																							isSelected
																								? "opacity-100"
																								: "opacity-0",
																						)}
																					/>
																					{model.id}
																				</CommandItem>
																			);
																		})}
																	</CommandList>
																</Command>
															</PopoverContent>
														</Popover>
														<FormDescription>
															{t("settings.ai.form.model.description")}
														</FormDescription>
														<FormMessage />
													</FormItem>
												);
											}}
										/>
									)}

									<div className="flex justify-end gap-2 pt-4">
										<Button type="submit" isPending={isSaving}>
											{embeddingProvider
												? t("settings.common.update")
												: t("settings.common.create")}
										</Button>
									</div>
								</form>
							</Form>
						</DialogContent>
					</Dialog>
				</div>
				</div>
			</div>
		</div>
	);
};

