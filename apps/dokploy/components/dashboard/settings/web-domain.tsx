import { zodResolver } from "@hookform/resolvers/zod";
import { GlobeIcon } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
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
import {
	formatPanelDomainsDisplay,
	parsePanelDomainsInput,
	parsePanelDomainsInputResult,
} from "@/utils/panel-domains";
import { api } from "@/utils/api";

const baseServerDomainSchema = z.object({
	domains: z.string(),
	letsEncryptEmail: z.string(),
	certificateType: z.enum(["letsencrypt", "none", "custom"]),
});

function getPanelDomainErrorMessage(
	t: (key: string, options?: Record<string, unknown>) => string,
	message: string,
) {
	const errorMap: Record<string, string> = {
		"Add at least one domain":
			"settings.server.domain.validation.domainsRequired",
		"Use full URLs separated by commas, for example https://panel.example.com,https://admin.example.com":
			"settings.server.domain.validation.fullUrlsRequired",
		"Only http:// and https:// URLs are supported":
			"settings.server.domain.validation.protocolUnsupported",
		"All panel domains must use the same protocol":
			"settings.server.domain.validation.protocolMismatch",
		"Domains cannot include credentials":
			"settings.server.domain.validation.credentialsUnsupported",
		"Custom ports are not supported for panel domains":
			"settings.server.domain.validation.portsUnsupported",
		"Paths, query strings, and hashes are not supported for panel domains":
			"settings.server.domain.validation.pathsUnsupported",
		"Domain host is required":
			"settings.server.domain.validation.hostRequired",
	};

	return t(errorMap[message] || "settings.server.domain.assignError");
}

const createServerDomainSchema = (t: (key: string) => string) =>
	baseServerDomainSchema.superRefine((data, ctx) => {
		let parsedDomains;
		try {
			parsedDomains = parsePanelDomainsInput(data.domains);
		} catch (error) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["domains"],
				message:
					error instanceof Error
						? getPanelDomainErrorMessage(t, error.message)
						: t("settings.server.domain.assignError"),
			});
			return;
		}

		if (parsedDomains.https && !data.certificateType) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["certificateType"],
				message: t("settings.server.domain.validation.certificateRequired"),
			});
		}
		if (
			parsedDomains.https &&
			data.certificateType === "letsencrypt" &&
			!data.letsEncryptEmail
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["letsEncryptEmail"],
				message: t(
					"settings.server.domain.validation.letsEncryptEmailRequired",
				),
			});
		}
	});

type AddServerDomain = z.infer<typeof baseServerDomainSchema>;

export const WebDomain = () => {
	const { t } = useTranslation("settings");
	const { data, refetch } = api.user.get.useQuery();
	const { mutateAsync, isPending } =
		api.settings.assignDomainServer.useMutation();
	const schema = useMemo(() => createServerDomainSchema(t), [t]);

	const form = useForm<AddServerDomain>({
		defaultValues: {
			domains: "",
			certificateType: "none",
			letsEncryptEmail: "",
		},
		resolver: zodResolver(schema as any) as any,
	});
	const domainsValue = form.watch("domains") || "";
	const parsedDomainsResult = parsePanelDomainsInputResult(domainsValue);
	const parsedDomains = parsedDomainsResult.data;
	const https = parsedDomains?.https ?? (data?.user?.https || false);
	const currentDomainsDisplay = formatPanelDomainsDisplay({
		host: data?.user?.host,
		additionalHosts: data?.user?.additionalHosts,
		https: data?.user?.https,
	});
	const hasChanged = domainsValue !== currentDomainsDisplay;
	useEffect(() => {
		if (data) {
			form.reset({
				domains: formatPanelDomainsDisplay({
					host: data?.user?.host,
					additionalHosts: data?.user?.additionalHosts,
					https: data?.user?.https,
				}),
				certificateType: data?.user?.certificateType,
				letsEncryptEmail: data?.user?.letsEncryptEmail || "",
			});
		}
	}, [form, form.reset, data]);

	const onSubmit = async (data: AddServerDomain) => {
		let parsed;
		try {
			parsed = parsePanelDomainsInput(data.domains);
		} catch (error) {
			form.setError("domains", {
				type: "manual",
				message:
					error instanceof Error
						? getPanelDomainErrorMessage(t, error.message)
						: t("settings.server.domain.assignError"),
			});
			return;
		}

		await mutateAsync({
			domains: parsed.domainsDisplay,
			letsEncryptEmail:
				parsed.https && data.certificateType === "letsencrypt"
					? data.letsEncryptEmail
					: "",
			certificateType: parsed.https ? data.certificateType : "none",
		})
			.then(async () => {
				await refetch();
				toast.success(t("settings.server.domain.assigned"));
			})
			.catch(() => {
				toast.error(t("settings.server.domain.assignError"));
			});
	};

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar  p-2.5 rounded-xl  max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md ">
					<CardHeader className="flex flex-row gap-2 flex-wrap justify-between items-center">
						<div className="flex flex-col gap-1">
							<CardTitle className="text-xl flex flex-row gap-2">
								<GlobeIcon className="size-6 text-muted-foreground self-center" />
								{t("settings.server.domain.title")}
							</CardTitle>
							<CardDescription>
								{t("settings.server.domain.description")}
							</CardDescription>
						</div>
					</CardHeader>
					<CardContent className="space-y-2 py-6 border-t">
						{/* Warning for GitHub webhook URL changes */}
						{hasChanged && (
							<AlertBlock type="warning">
								<div className="space-y-2">
									<p className="font-medium">
										{t("settings.server.domain.githubWarning.title")}
									</p>
									<p>{t("settings.server.domain.githubWarning.description")}</p>
								</div>
							</AlertBlock>
						)}
						<Form {...form}>
							<form
								onSubmit={form.handleSubmit(onSubmit)}
								className="grid w-full gap-4 md:grid-cols-2"
							>
								<FormField
									control={form.control}
									name="domains"
									render={({ field }) => {
										return (
											<FormItem className="md:col-span-2">
												<FormLabel>
													{t("settings.server.domain.form.domain")}
												</FormLabel>
												<FormControl>
													<Input
														className="w-full"
														placeholder={t(
															"settings.server.domain.form.domainsPlaceholder",
														)}
														{...field}
													/>
												</FormControl>
												<FormDescription>
													{t(
														"settings.server.domain.form.domainsDescription",
													)}
												</FormDescription>
												{parsedDomains && (
													<FormDescription>
														{t(
															"settings.server.domain.form.domainsProtocolDetected",
															{
																protocol: parsedDomains.https
																	? "HTTPS"
																	: "HTTP",
															},
														)}
													</FormDescription>
												)}
												{!parsedDomains &&
													domainsValue.trim() &&
													parsedDomainsResult.error && (
														<FormDescription className="text-destructive">
															{getPanelDomainErrorMessage(
																t,
																parsedDomainsResult.error,
															)}
														</FormDescription>
													)}
												<FormMessage />
											</FormItem>
										);
									}}
								/>

								{https && (
									<>
										<FormField
											control={form.control}
											name="certificateType"
											render={({ field }) => {
												return (
													<FormItem className="md:col-span-2">
														<FormLabel>
															{t("settings.server.domain.form.certificate.label")}
														</FormLabel>
														<Select
															onValueChange={field.onChange}
															value={field.value}
														>
															<FormControl>
																<SelectTrigger>
																	<SelectValue
																		placeholder={t(
																			"settings.server.domain.form.certificate.placeholder",
																		)}
																	/>
																</SelectTrigger>
															</FormControl>
															<SelectContent>
																<SelectItem value={"none"}>
																	{t(
																		"settings.server.domain.form.certificateOptions.none",
																	)}
																</SelectItem>
																<SelectItem value={"letsencrypt"}>
																	{t(
																		"settings.server.domain.form.certificateOptions.letsencrypt",
																	)}
																</SelectItem>
															</SelectContent>
														</Select>
														<FormMessage />
													</FormItem>
												);
											}}
										/>
										{form.watch("certificateType") === "letsencrypt" && (
											<FormField
												control={form.control}
												name="letsEncryptEmail"
												render={({ field }) => {
													return (
														<FormItem className="md:col-span-2">
															<FormLabel>
																{t(
																	"settings.server.domain.form.letsEncryptEmail",
																)}
															</FormLabel>
															<FormControl>
																<Input
																	className="w-full"
																	placeholder={"Dp4kz@example.com"}
																	{...field}
																/>
															</FormControl>
															<FormMessage />
														</FormItem>
													);
												}}
											/>
										)}
									</>
								)}

								<div className="flex w-full justify-end col-span-2">
									<Button isPending={isPending} type="submit">
										{t("settings.common.save")}
									</Button>
								</div>
							</form>
						</Form>
					</CardContent>
				</div>
			</Card>
		</div>
	);
};

