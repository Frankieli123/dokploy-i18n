import { zodResolver } from "@hookform/resolvers/zod";
import { PenBoxIcon } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { GithubIcon } from "@/components/icons/data-tools-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const createSchema = (t: (key: string, options?: any) => string) =>
	z.object({
		name: z.string().min(1, {
			message: t("settings.gitProviders.validation.nameRequired"),
		}),
		appName: z.string().min(1, {
			message: t("settings.gitProviders.validation.appNameRequired"),
		}),
		githubMirrorPrefixUrl: z
			.string()
			.url({
				message: t("settings.gitProviders.validation.invalidUrl", {
					defaultValue: "Invalid URL",
				}),
			})
			.optional()
			.or(z.literal("")),
		githubApiProxyUrl: z
			.string()
			.url({
				message: t("settings.gitProviders.validation.invalidUrl", {
					defaultValue: "Invalid URL",
				}),
			})
			.optional()
			.or(z.literal("")),
		githubMirrorForwardAuth: z.boolean().optional(),
	});

type Schema = z.infer<ReturnType<typeof createSchema>>;

interface Props {
	githubId: string;
}

export const EditGithubProvider = ({ githubId }: Props) => {
	const { t } = useTranslation("settings");
	const { data: github } = api.github.one.useQuery(
		{
			githubId,
		},
		{
			enabled: !!githubId,
		},
	);
	const utils = api.useUtils();
	const [isOpen, setIsOpen] = useState(false);
	const { mutateAsync, error, isError } = api.github.update.useMutation();
	const { mutateAsync: testConnection, isPending } =
		api.github.testConnection.useMutation();
	const schema = createSchema(t);
	const form = useForm<Schema>({
		defaultValues: {
			name: "",
			appName: "",
			githubMirrorPrefixUrl: "",
			githubApiProxyUrl: "",
			githubMirrorForwardAuth: false,
		},
		resolver: zodResolver(schema as any) as any,
	});

	useEffect(() => {
		form.reset({
			name: github?.gitProvider.name || "",
			appName: github?.githubAppName || "",
			githubMirrorPrefixUrl: github?.githubMirrorPrefixUrl || "",
			githubApiProxyUrl: github?.githubApiProxyUrl || "",
			githubMirrorForwardAuth: github?.githubMirrorForwardAuth ?? false,
		});
	}, [form, isOpen]);

	const onSubmit = async (data: Schema) => {
		await mutateAsync({
			githubId,
			name: data.name || "",
			gitProviderId: github?.gitProviderId || "",
			githubAppName: data.appName || "",
			githubMirrorPrefixUrl: data.githubMirrorPrefixUrl || null,
			githubApiProxyUrl: data.githubApiProxyUrl || null,
			githubMirrorForwardAuth: data.githubMirrorForwardAuth ?? false,
		})
			.then(async () => {
				await utils.gitProvider.getAll.invalidate();
				toast.success(
					t("settings.gitProviders.github.edit.toast.updatedSuccess"),
				);
				setIsOpen(false);
			})
			.catch(() => {
				toast.error(t("settings.gitProviders.github.edit.toast.updatedError"));
			});
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="group hover:bg-blue-500/10 "
				>
					<PenBoxIcon className="size-3.5  text-primary group-hover:text-blue-500" />
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl ">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{t("settings.gitProviders.github.edit.title")}{" "}
						<GithubIcon className="size-5" />
					</DialogTitle>
				</DialogHeader>

				{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}
				<Form {...form}>
					<form
						id="hook-form-add-github"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-1"
					>
						<CardContent className="p-0">
							<div className="flex flex-col gap-4">
								<FormField
									control={form.control}
									name="name"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												{t("settings.gitProviders.github.edit.nameLabel")}
											</FormLabel>
											<FormControl>
												<Input
													placeholder={t(
														"settings.gitProviders.github.edit.namePlaceholder",
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
									name="appName"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												{t("settings.gitProviders.github.edit.appNameLabel")}
											</FormLabel>
											<FormControl>
												<Input
													placeholder={t(
														"settings.gitProviders.github.edit.appNamePlaceholder",
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
									name="githubMirrorForwardAuth"
									render={({ field }) => (
										<FormItem>
											<div className="flex items-center space-x-2">
												<FormControl>
													<Switch
														checked={Boolean(field.value)}
														onCheckedChange={field.onChange}
													/>
												</FormControl>
												<FormLabel className="!mt-0">
													{t(
														"settings.gitProviders.github.edit.mirrorForwardAuthLabel",
														{
															defaultValue:
																"Allow forwarding GitHub auth through Mirror Prefix (private repos)",
														},
													)}
												</FormLabel>
											</div>
											<FormDescription>
												{t(
													"settings.gitProviders.github.edit.mirrorForwardAuthDescription",
													{
														defaultValue:
															"Includes a GitHub App installation token in the mirror-prefixed clone URL. Enable only for trusted/self-hosted mirrors.",
													},
												)}
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="githubMirrorPrefixUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												{t(
													"settings.gitProviders.github.edit.mirrorPrefixLabel",
													{
														defaultValue: "Mirror Prefix URL (Git Clone)",
													},
												)}
											</FormLabel>
											<FormControl>
												<Input
													placeholder={t(
														"settings.gitProviders.github.edit.mirrorPrefixPlaceholder",
														{ defaultValue: "e.g. https://ghproxy.com/" },
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
									name="githubApiProxyUrl"
									render={({ field }) => (
										<FormItem>
											<FormLabel>
												{t("settings.gitProviders.github.edit.apiProxyLabel", {
													defaultValue: "GitHub API Proxy URL",
												})}
											</FormLabel>
											<FormControl>
												<Input
													placeholder={t(
														"settings.gitProviders.github.edit.apiProxyPlaceholder",
														{ defaultValue: "e.g. http://1.2.3.4:7890" },
													)}
													{...field}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>

								<div className="flex w-full justify-between gap-4 mt-4">
									<Button
										type="button"
										variant={"secondary"}
										isPending={isPending}
										onClick={async () => {
											await testConnection({
												githubId,
											})
												.then(async (message) => {
													toast.info(
														t(
															"settings.gitProviders.github.edit.toast.testSuccessMessage",
															{ message },
														),
													);
												})
												.catch((error) => {
													toast.error(
														t(
															"settings.gitProviders.github.edit.toast.testErrorMessage",
															{ error: error.message },
														),
													);
												});
										}}
									>
										{t("settings.gitProviders.github.edit.testButton")}
									</Button>
									<Button type="submit" isPending={form.formState.isSubmitting}>
										{t("settings.gitProviders.github.edit.updateButton")}
									</Button>
								</div>
							</div>
						</CardContent>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};

