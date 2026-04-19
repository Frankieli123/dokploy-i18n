"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";
import { useUrl } from "@/utils/hooks/use-url";

const DEFAULT_SCOPES = ["openid", "email", "profile"];

type OidcProviderForm = {
	providerId: string;
	issuer: string;
	domains: string[];
	clientId: string;
	clientSecret: string;
	scopes: string[];
};

const createSchema = (t: (key: string) => string) =>
	z.object({
		providerId: z.string().min(1, t("settings.sso.form.providerIdRequired")).trim(),
		issuer: z
			.string()
			.min(1, t("settings.sso.form.issuerRequired"))
			.url(t("settings.sso.form.invalidUrl"))
			.trim(),
		domains: z
			.array(z.string().trim())
			.refine((value) => value.filter(Boolean).length > 0, {
				message: t("settings.sso.form.domainRequired"),
			}),
		clientId: z.string().min(1, t("settings.sso.form.clientIdRequired")).trim(),
		clientSecret: z
			.string()
			.min(1, t("settings.sso.form.clientSecretRequired")),
		scopes: z.array(z.string().trim()),
	});

const defaultValues: OidcProviderForm = {
	providerId: "",
	issuer: "",
	domains: [""],
	clientId: "",
	clientSecret: "",
	scopes: [...DEFAULT_SCOPES],
};

function parseOidcConfig(value: string | null) {
	if (!value) return null;
	try {
		return JSON.parse(value) as {
			clientId?: string;
			clientSecret?: string;
			scopes?: string[];
		};
	} catch {
		return null;
	}
}

interface Props {
	providerId?: string;
	children: React.ReactNode;
}

export function RegisterOidcDialog({ providerId, children }: Props) {
	const { t } = useTranslation("settings");
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const baseUrl = useUrl();
	const schema = createSchema(t);
	const isEdit = !!providerId;

	const { data } = api.sso.one.useQuery(
		{ providerId: providerId ?? "" },
		{ enabled: open && !!providerId },
	);
	const createMutation = api.sso.register.useMutation();
	const updateMutation = api.sso.update.useMutation();
	const mutateAsync = isEdit
		? updateMutation.mutateAsync
		: createMutation.mutateAsync;
	const isPending = isEdit ? updateMutation.isPending : createMutation.isPending;

	const form = useForm<OidcProviderForm>({
		resolver: zodResolver(schema as any) as any,
		defaultValues,
	});

	const watchedProviderId = useWatch({
		control: form.control,
		name: "providerId",
		defaultValue: "",
	});

	const {
		fields: domainFields,
		append: appendDomain,
		remove: removeDomain,
	} = useFieldArray({
		control: form.control,
		name: "domains" as never,
	});

	const {
		fields: scopeFields,
		append: appendScope,
		remove: removeScope,
	} = useFieldArray({
		control: form.control,
		name: "scopes" as never,
	});

	useEffect(() => {
		if (!data || !open) return;
		const parsed = parseOidcConfig(data.oidcConfig);
		const domains = data.domain
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		form.reset({
			providerId: data.providerId,
			issuer: data.issuer,
			domains: domains.length > 0 ? domains : [""],
			clientId: parsed?.clientId ?? "",
			clientSecret: parsed?.clientSecret ?? "",
			scopes:
				parsed?.scopes && parsed.scopes.length > 0
					? parsed.scopes
					: [...DEFAULT_SCOPES],
		});
	}, [data, form, open]);

	const onSubmit = async (values: OidcProviderForm) => {
		const scopes = values.scopes.map((item) => item.trim()).filter(Boolean);
		const domains = values.domains.map((item) => item.trim()).filter(Boolean);
		const isAzure = values.issuer.includes("login.microsoftonline.com");

		try {
			await mutateAsync({
				providerId: values.providerId.trim(),
				issuer: values.issuer.trim(),
				domains,
				oidcConfig: {
					clientId: values.clientId.trim(),
					clientSecret: values.clientSecret,
					scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES,
					pkce: true,
					mapping: isAzure
						? {
								id: "sub",
								email: "preferred_username",
								emailVerified: "email_verified",
								name: "name",
							}
						: {
								id: "sub",
								email: "email",
								emailVerified: "email_verified",
								name: "preferred_username",
								image: "picture",
							},
				},
			});
			toast.success(
				isEdit
					? t("settings.sso.oidc.updated")
					: t("settings.sso.oidc.created"),
			);
			form.reset(defaultValues);
			setOpen(false);
			await utils.sso.listProviders.invalidate();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("settings.sso.oidc.saveError"),
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-[520px] max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{isEdit
							? t("settings.sso.oidc.editTitle")
							: t("settings.sso.oidc.addTitle")}
					</DialogTitle>
					<DialogDescription>
						{isEdit
							? t("settings.sso.oidc.editDescription")
							: t("settings.sso.oidc.addDescription")}
					</DialogDescription>
				</DialogHeader>

				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="providerId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.sso.form.providerId")}</FormLabel>
									<FormControl>
										<Input
											{...field}
											readOnly={isEdit}
											className={isEdit ? "bg-muted" : undefined}
											placeholder="okta"
										/>
									</FormControl>
									<FormDescription>
										{t("settings.sso.form.providerIdDescription")}
									</FormDescription>
									{baseUrl ? (
										<div className="rounded-md bg-muted px-3 py-2 text-xs">
											<p className="font-medium text-muted-foreground">
												{t("settings.sso.callbackUrl")}
											</p>
											<p className="mt-0.5 break-all font-mono">
												{baseUrl}/api/auth/sso/callback/
												{watchedProviderId?.trim() || "..."}
											</p>
										</div>
									) : null}
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="issuer"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.sso.form.issuer")}</FormLabel>
									<FormControl>
										<Input {...field} placeholder="https://idp.example.com" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<FormLabel>{t("settings.sso.form.domains")}</FormLabel>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => appendDomain("" as never)}
								>
									<Plus className="mr-1 size-4" />
									{t("settings.sso.form.addDomain")}
								</Button>
							</div>
							<FormDescription>
								{t("settings.sso.form.domainsDescription")}
							</FormDescription>
							{domainFields.map((item, index) => (
								<FormField
									key={item.id}
									control={form.control}
									name={`domains.${index}` as never}
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<div className="flex gap-2">
													<Input
														{...field}
														placeholder="company.com"
														className="flex-1"
													/>
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() => removeDomain(index)}
														disabled={domainFields.length <= 1}
													>
														<Trash2 className="size-4" />
													</Button>
												</div>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							))}
						</div>

						<FormField
							control={form.control}
							name="clientId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.sso.form.clientId")}</FormLabel>
									<FormControl>
										<Input {...field} placeholder="client-id" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="clientSecret"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.sso.form.clientSecret")}</FormLabel>
									<FormControl>
										<Input {...field} type="password" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<FormLabel>{t("settings.sso.form.scopes")}</FormLabel>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => appendScope("" as never)}
								>
									<Plus className="mr-1 size-4" />
									{t("settings.sso.form.addScope")}
								</Button>
							</div>
							{scopeFields.map((item, index) => (
								<FormField
									key={item.id}
									control={form.control}
									name={`scopes.${index}` as never}
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<div className="flex gap-2">
													<Input {...field} placeholder="openid" className="flex-1" />
													<Button
														type="button"
														variant="ghost"
														size="icon"
														onClick={() => removeScope(index)}
														disabled={scopeFields.length <= 1}
													>
														<Trash2 className="size-4" />
													</Button>
												</div>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							))}
						</div>

						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								{t("settings.common.cancel")}
							</Button>
							<Button type="submit" isPending={isPending}>
								{isEdit
									? t("settings.sso.form.updateProvider")
									: t("settings.sso.form.createProvider")}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
