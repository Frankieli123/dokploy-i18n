import { zodResolver } from "@hookform/resolvers/zod";
import { CheckIcon, ChevronsUpDown, HelpCircle, Plus, X } from "lucide-react";
import Link from "next/link";
import { useTranslation } from "next-i18next";
import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { BitbucketIcon } from "@/components/icons/data-tools-icons";
import { AlertBlock } from "@/components/shared/alert-block";
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

const createBitbucketProviderSchema = (t: (key: string) => string) =>
	z.object({
		buildPath: z
			.string()
			.min(1, t("application.git.bitbucket.validation.buildPathRequired"))
			.default("/"),
		repository: z
			.object({
				repo: z
					.string()
					.min(1, t("application.git.bitbucket.validation.repositoryRequired")),
				owner: z
					.string()
					.min(1, t("application.git.bitbucket.validation.ownerRequired")),
			})
			.required(),
		branch: z
			.string()
			.min(1, t("application.git.bitbucket.validation.branchRequired")),
		bitbucketId: z
			.string()
			.min(1, t("application.git.bitbucket.validation.bitbucketIdRequired")),
		watchPaths: z.array(z.string()).optional(),
		enableSubmodules: z.boolean().default(false),
	});

type BitbucketProvider = z.infer<ReturnType<typeof createBitbucketProviderSchema>>;

interface Props {
	applicationId: string;
}

export const SaveBitbucketProvider = ({ applicationId }: Props) => {
	const { t } = useTranslation("common");
	const { data: bitbucketProviders } =
		api.bitbucket.bitbucketProviders.useQuery();
	const { data, refetch } = api.application.one.useQuery({ applicationId });

	const { mutateAsync, isPending: isSavingBitbucketProvider } =
		api.application.saveBitbucketProvider.useMutation();

	const schema = createBitbucketProviderSchema(t);
	const form = useForm<BitbucketProvider>({
		defaultValues: {
			buildPath: "/",
			repository: {
				owner: "",
				repo: "",
			},
			bitbucketId: "",
			branch: "",
			watchPaths: [],
			enableSubmodules: false,
		},
		resolver: zodResolver(schema as any) as any,
	});

	const repository = form.watch("repository");
	const bitbucketId = form.watch("bitbucketId");
	const watchPathInputRef = useRef<HTMLInputElement | null>(null);

	const {
		data: repositories,
		isPending: isPendingRepositories,
		error,
	} = api.bitbucket.getBitbucketRepositories.useQuery(
		{
			bitbucketId,
		},
		{
			enabled: !!bitbucketId,
		},
	);

	const {
		data: branches,
		fetchStatus,
		status,
	} = api.bitbucket.getBitbucketBranches.useQuery(
		{
			owner: repository?.owner,
			repo: repository?.repo,
			bitbucketId,
		},
		{
			enabled: !!repository?.owner && !!repository?.repo && !!bitbucketId,
		},
	);

	useEffect(() => {
		if (data) {
			form.reset({
				branch: data.bitbucketBranch || "",
				repository: {
					repo: data.bitbucketRepository || "",
					owner: data.bitbucketOwner || "",
				},
				buildPath: data.bitbucketBuildPath || "/",
				bitbucketId: data.bitbucketId || "",
				watchPaths: data.watchPaths || [],
				enableSubmodules: data.enableSubmodules || false,
			});
		}
	}, [form.reset, data?.applicationId, form]);

	const onSubmit = async (data: BitbucketProvider) => {
		await mutateAsync({
			bitbucketBranch: data.branch,
			bitbucketRepository: data.repository.repo,
			bitbucketOwner: data.repository.owner,
			bitbucketBuildPath: data.buildPath,
			bitbucketId: data.bitbucketId,
			applicationId,
			watchPaths: data.watchPaths || [],
			enableSubmodules: data.enableSubmodules || false,
			})
				.then(async () => {
					toast.success(t("application.git.bitbucket.toast.saveSuccess"));
					await refetch();
				})
				.catch(() => {
					toast.error(t("application.git.bitbucket.toast.saveError"));
				});
		};

	return (
		<div>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="grid w-full gap-4 py-3"
				>
						{error && (
							<AlertBlock type="error">
								{t("application.git.bitbucket.state.repositoriesError")}:{" "}
								{error.message}
							</AlertBlock>
						)}
					<div className="grid md:grid-cols-2 gap-4">
						<FormField
							control={form.control}
							name="bitbucketId"
								render={({ field }) => (
									<FormItem className="md:col-span-2 flex flex-col">
										<FormLabel>
											{t(
												"application.git.bitbucket.form.bitbucketAccountLabel",
											)}
										</FormLabel>
										<Select
											onValueChange={(value) => {
												field.onChange(value);
												form.setValue("repository", {
												owner: "",
												repo: "",
											});
											form.setValue("branch", "");
										}}
										defaultValue={field.value}
											value={field.value}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue
														placeholder={t(
															"application.git.bitbucket.form.bitbucketAccountPlaceholder",
														)}
													/>
												</SelectTrigger>
											</FormControl>
										<SelectContent>
											{bitbucketProviders?.map((bitbucketProvider) => (
												<SelectItem
													key={bitbucketProvider.bitbucketId}
													value={bitbucketProvider.bitbucketId}
												>
													{bitbucketProvider.gitProvider.name}
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
								name="repository"
								render={({ field }) => (
									<FormItem className="md:col-span-2 flex flex-col">
										<div className="flex items-center justify-between">
											<FormLabel>
												{t("application.git.bitbucket.form.repositoryLabel")}
											</FormLabel>
											{field.value.owner && field.value.repo && (
												<Link
													href={`https://bitbucket.org/${field.value.owner}/${field.value.repo}`}
													target="_blank"
													rel="noopener noreferrer"
													className="flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
												>
													<BitbucketIcon className="h-4 w-4" />
													<span>
														{t(
															"application.git.bitbucket.form.viewRepositoryLink",
														)}
													</span>
												</Link>
											)}
										</div>
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
														{isPendingRepositories
															? t(
																	"application.git.bitbucket.state.loadingRepositories",
																)
															: field.value.owner
																? repositories?.find(
																		(repo) => repo.name === field.value.repo,
																	)?.name
																: t(
																		"application.git.bitbucket.form.repositorySelectPlaceholder",
																	)}

														<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
													</Button>
											</FormControl>
										</PopoverTrigger>
										<PopoverContent className="p-0" align="start">
												<Command>
													<CommandInput
														placeholder={t(
															"application.git.bitbucket.form.repositorySearchPlaceholder",
														)}
														className="h-9"
													/>
													{isPendingRepositories && (
														<span className="py-6 text-center text-sm">
															{t(
																"application.git.bitbucket.state.loadingRepositories",
															)}
														</span>
													)}
													<CommandEmpty>
														{t("application.git.bitbucket.state.noRepositories")}
													</CommandEmpty>
												<ScrollArea className="h-96">
													<CommandGroup>
														{repositories?.map((repo) => (
															<CommandItem
																value={repo.name}
																key={repo.url}
																onSelect={() => {
																	form.setValue("repository", {
																		owner: repo.owner.username as string,
																		repo: repo.name,
																	});
																	form.setValue("branch", "");
																}}
															>
																<span className="flex items-center gap-2">
																	<span>{repo.name}</span>
																	<span className="text-muted-foreground text-xs">
																		{repo.owner.username}
																	</span>
																</span>
																<CheckIcon
																	className={cn(
																		"ml-auto h-4 w-4",
																		repo.name === field.value.repo
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
										{form.formState.errors.repository && (
											<p className={cn("text-sm font-medium text-destructive")}>
												{t(
													"application.git.bitbucket.validation.repositoryRequired",
												)}
											</p>
										)}
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="branch"
								render={({ field }) => (
									<FormItem className="block w-full">
										<FormLabel>
											{t("application.git.bitbucket.form.branchLabel")}
										</FormLabel>
										<Popover>
											<PopoverTrigger asChild>
												<FormControl>
													<Button
													variant="outline"
													className={cn(
														" w-full justify-between !bg-input",
														!field.value && "text-muted-foreground",
													)}
													>
														{status === "pending" && fetchStatus === "fetching"
															? t(
																	"application.git.bitbucket.state.loadingBranches",
																)
															: field.value
																? branches?.find(
																		(branch) => branch.name === field.value,
																	)?.name
																: t(
																		"application.git.bitbucket.form.branchSelectPlaceholder",
																	)}
														<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
													</Button>
												</FormControl>
											</PopoverTrigger>
										<PopoverContent className="p-0" align="start">
												<Command>
													<CommandInput
														placeholder={t(
															"application.git.bitbucket.form.branchSearchPlaceholder",
														)}
														className="h-9"
													/>
													{status === "pending" && fetchStatus === "fetching" && (
														<span className="py-6 text-center text-sm text-muted-foreground">
															{t(
																"application.git.bitbucket.state.loadingBranches",
															)}
														</span>
													)}
													{!repository?.owner && (
														<span className="py-6 text-center text-sm text-muted-foreground">
															{t(
																"application.git.bitbucket.form.repositorySelectFirst",
															)}
														</span>
													)}
													<ScrollArea className="h-96">
														<CommandEmpty>
															{t("application.git.bitbucket.state.noBranches")}
														</CommandEmpty>

													<CommandGroup>
														{branches?.map((branch) => (
															<CommandItem
																value={branch.name}
																key={branch.commit.sha}
																onSelect={() => {
																	form.setValue("branch", branch.name);
																}}
															>
																{branch.name}
																<CheckIcon
																	className={cn(
																		"ml-auto h-4 w-4",
																		branch.name === field.value
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

										<FormMessage />
									</Popover>
								</FormItem>
							)}
						/>
							<FormField
								control={form.control}
								name="buildPath"
								render={({ field }) => (
									<FormItem>
										<FormLabel>
											{t("application.git.bitbucket.form.buildPathLabel")}
										</FormLabel>
										<FormControl>
											<Input
												placeholder={t(
													"application.git.bitbucket.form.buildPathPlaceholder",
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
								name="watchPaths"
								render={({ field }) => (
									<FormItem className="md:col-span-2">
										<div className="flex items-center gap-2">
											<FormLabel>
												{t("application.git.bitbucket.form.watchPathsLabel")}
											</FormLabel>
											<TooltipProvider>
												<Tooltip>
													<TooltipTrigger asChild>
														<HelpCircle className="size-4 text-muted-foreground hover:text-foreground transition-colors cursor-pointer" />
													</TooltipTrigger>
													<TooltipContent>
														<p>
															{t(
																"application.git.bitbucket.form.watchPathsTooltip",
															)}
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</div>
										<div className="flex flex-wrap gap-2 mb-2">
											{field.value?.map((path, index) => (
												<Badge
													key={index}
													variant="secondary"
													className="flex items-center gap-1"
												>
													{path}
													<X
														className="size-3 cursor-pointer hover:text-destructive"
														onClick={() => {
															const newPaths = [...(field.value || [])];
															newPaths.splice(index, 1);
															field.onChange(newPaths);
														}}
													/>
												</Badge>
											))}
										</div>
										<div className="flex gap-2">
											<FormControl>
												<Input
													ref={watchPathInputRef}
													placeholder={t(
														"application.git.bitbucket.form.watchPathsPlaceholder",
													)}
													onKeyDown={(e) => {
														if (e.key === "Enter") {
															e.preventDefault();
															const input = e.currentTarget;
															const path = input.value.trim();
															if (path) {
																field.onChange([...(field.value || []), path]);
																input.value = "";
															}
														}
													}}
												/>
											</FormControl>
											<Button
												type="button"
												variant="outline"
												size="icon"
												onClick={() => {
													const input = watchPathInputRef.current;
													if (!input) return;
													const path = input.value.trim();
													if (path) {
														field.onChange([...(field.value || []), path]);
														input.value = "";
													}
												}}
											>
												<Plus className="size-4" />
											</Button>
										</div>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="enableSubmodules"
								render={({ field }) => (
									<FormItem className="flex items-center space-x-2">
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
											/>
										</FormControl>
										<FormLabel className="!mt-0">
											{t(
												"application.git.bitbucket.form.enableSubmodulesLabel",
											)}
										</FormLabel>
									</FormItem>
								)}
							/>
					</div>
					<div className="flex w-full justify-end">
							<Button
								isPending={isSavingBitbucketProvider}
								type="submit"
								className="w-fit"
							>
								{t("button.save")}
							</Button>
					</div>
				</form>
			</Form>
		</div>
	);
};

