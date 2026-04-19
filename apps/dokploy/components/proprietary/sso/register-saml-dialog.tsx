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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";
import { useUrl } from "@/utils/hooks/use-url";

type SamlProviderForm = {
	providerId: string;
	issuer: string;
	domains: string[];
	entryPoint: string;
	cert: string;
	idpMetadataXml?: string;
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
		entryPoint: z
			.string()
			.min(1, t("settings.sso.form.entryPointRequired"))
			.url(t("settings.sso.form.invalidUrl"))
			.trim(),
		cert: z.string().min(1, t("settings.sso.form.certificateRequired")),
		idpMetadataXml: z.string().optional(),
	});

const defaultValues: SamlProviderForm = {
	providerId: "",
	issuer: "",
	domains: [""],
	entryPoint: "",
	cert: "",
	idpMetadataXml: "",
};

function parseSamlConfig(value: string | null) {
	if (!value) return null;
	try {
		return JSON.parse(value) as {
			entryPoint?: string;
			cert?: string;
			idpMetadata?: { metadata?: string };
		};
	} catch {
		return null;
	}
}

interface Props {
	providerId?: string;
	children: React.ReactNode;
}

export function RegisterSamlDialog({ providerId, children }: Props) {
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

	const form = useForm<SamlProviderForm>({
		resolver: zodResolver(schema as any) as any,
		defaultValues,
	});

	const watchedProviderId = useWatch({
		control: form.control,
		name: "providerId",
		defaultValue: "",
	});

	const { fields, append, remove } = useFieldArray({
		control: form.control,
		name: "domains" as never,
	});

	useEffect(() => {
		if (!data || !open) return;
		const parsed = parseSamlConfig(data.samlConfig);
		const domains = data.domain
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		form.reset({
			providerId: data.providerId,
			issuer: data.issuer,
			domains: domains.length > 0 ? domains : [""],
			entryPoint: parsed?.entryPoint ?? "",
			cert: parsed?.cert ?? "",
			idpMetadataXml: parsed?.idpMetadata?.metadata ?? "",
		});
	}, [data, form, open]);

	const onSubmit = async (values: SamlProviderForm) => {
		const domains = values.domains.map((item) => item.trim()).filter(Boolean);

		try {
			await mutateAsync({
				providerId: values.providerId.trim(),
				issuer: values.issuer.trim(),
				domains,
				samlConfig: {
					entryPoint: values.entryPoint.trim(),
					cert: values.cert,
					callbackUrl: `${baseUrl}/api/auth/sso/saml2/callback/${values.providerId.trim()}`,
					audience: baseUrl,
					idpMetadata: values.idpMetadataXml?.trim()
						? { metadata: values.idpMetadataXml.trim() }
						: undefined,
					spMetadata: {
						metadata: `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${baseUrl}"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${baseUrl}/api/auth/sso/saml2/callback/${values.providerId.trim()}" index="1"/></md:SPSSODescriptor></md:EntityDescriptor>`,
					},
					mapping: {
						id: "nameID",
						email: "email",
						name: "displayName",
						firstName: "givenName",
						lastName: "surname",
					},
				},
			});
			toast.success(
				isEdit
					? t("settings.sso.saml.updated")
					: t("settings.sso.saml.created"),
			);
			form.reset(defaultValues);
			setOpen(false);
			await utils.sso.listProviders.invalidate();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("settings.sso.saml.saveError"),
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
							? t("settings.sso.saml.editTitle")
							: t("settings.sso.saml.addTitle")}
					</DialogTitle>
					<DialogDescription>
						{isEdit
							? t("settings.sso.saml.editDescription")
							: t("settings.sso.saml.addDescription")}
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
											placeholder="okta-saml"
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
												{baseUrl}/api/auth/sso/saml2/callback/
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
									onClick={() => append("" as never)}
								>
									<Plus className="mr-1 size-4" />
									{t("settings.sso.form.addDomain")}
								</Button>
							</div>
							<FormDescription>
								{t("settings.sso.form.domainsDescription")}
							</FormDescription>
							{fields.map((item, index) => (
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
														onClick={() => remove(index)}
														disabled={fields.length <= 1}
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
							name="entryPoint"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.sso.form.entryPoint")}</FormLabel>
									<FormControl>
										<Input {...field} placeholder="https://idp.example.com/sso" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="cert"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.sso.form.certificate")}</FormLabel>
									<FormControl>
										<Textarea {...field} rows={4} className="font-mono text-xs" />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="idpMetadataXml"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.sso.form.metadataXml")}</FormLabel>
									<FormControl>
										<Textarea {...field} rows={5} className="font-mono text-xs" />
									</FormControl>
									<FormDescription>
										{t("settings.sso.form.metadataXmlDescription")}
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

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
