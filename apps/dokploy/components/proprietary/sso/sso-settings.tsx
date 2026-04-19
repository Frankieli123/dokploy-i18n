"use client";

import { Eye, Loader2, LogIn, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";
import { useUrl } from "@/utils/hooks/use-url";
import { RegisterOidcDialog } from "./register-oidc-dialog";
import { RegisterSamlDialog } from "./register-saml-dialog";

type ProviderItem = {
	id: string | null;
	providerId: string;
	issuer: string;
	domain: string;
	oidcConfig: string | null;
	samlConfig: string | null;
	organizationId: string | null;
};

function parseOidcConfig(value: string | null) {
	if (!value) return null;
	try {
		return JSON.parse(value) as {
			clientId?: string;
			scopes?: string[];
		};
	} catch {
		return null;
	}
}

function parseSamlConfig(value: string | null) {
	if (!value) return null;
	try {
		return JSON.parse(value) as {
			entryPoint?: string;
		};
	} catch {
		return null;
	}
}

export function SSOSettings() {
	const { t } = useTranslation("settings");
	const utils = api.useUtils();
	const baseUrl = useUrl();
	const [detailsProvider, setDetailsProvider] = useState<ProviderItem | null>(null);
	const [manageOriginsOpen, setManageOriginsOpen] = useState(false);
	const [newOrigin, setNewOrigin] = useState("");
	const [editingOrigin, setEditingOrigin] = useState<string | null>(null);
	const [editingValue, setEditingValue] = useState("");

	const { data: providers, isPending } = api.sso.listProviders.useQuery();
	const { data: trustedOrigins = [] } = api.sso.getTrustedOrigins.useQuery(
		undefined,
		{ enabled: manageOriginsOpen },
	);
	const deleteProvider = api.sso.deleteProvider.useMutation();
	const addTrustedOrigin = api.sso.addTrustedOrigin.useMutation();
	const removeTrustedOrigin = api.sso.removeTrustedOrigin.useMutation();
	const updateTrustedOrigin = api.sso.updateTrustedOrigin.useMutation();

	const handleAddOrigin = async () => {
		const value = newOrigin.trim();
		if (!value) return;
		try {
			await addTrustedOrigin.mutateAsync({ origin: value });
			setNewOrigin("");
			toast.success(t("settings.sso.origins.added"));
			await utils.sso.getTrustedOrigins.invalidate();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : t("settings.sso.origins.addError"),
			);
		}
	};

	const handleRemoveOrigin = async (origin: string) => {
		try {
			await removeTrustedOrigin.mutateAsync({ origin });
			toast.success(t("settings.sso.origins.removed"));
			await utils.sso.getTrustedOrigins.invalidate();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("settings.sso.origins.removeError"),
			);
		}
	};

	const handleSaveOrigin = async () => {
		if (!editingOrigin || !editingValue.trim()) {
			setEditingOrigin(null);
			setEditingValue("");
			return;
		}
		try {
			await updateTrustedOrigin.mutateAsync({
				oldOrigin: editingOrigin,
				newOrigin: editingValue.trim(),
			});
			setEditingOrigin(null);
			setEditingValue("");
			toast.success(t("settings.sso.origins.updated"));
			await utils.sso.getTrustedOrigins.invalidate();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("settings.sso.origins.updateError"),
			);
		}
	};

	return (
		<Card className="bg-sidebar">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<div className="flex items-center gap-2">
						<LogIn className="size-5 text-muted-foreground" />
						<CardTitle>{t("settings.sso.title")}</CardTitle>
					</div>
					<CardDescription>{t("settings.sso.description")}</CardDescription>
				</div>
				<Button variant="outline" size="sm" onClick={() => setManageOriginsOpen(true)}>
					<Shield className="mr-2 size-4" />
					{t("settings.sso.manageOrigins")}
				</Button>
			</CardHeader>
			<CardContent className="space-y-4">
				{isPending ? (
					<div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" />
						<span>{t("settings.sso.loading")}</span>
					</div>
				) : providers && providers.length > 0 ? (
					<>
						<div className="flex flex-wrap gap-2">
							<RegisterOidcDialog>
								<Button variant="secondary" size="sm">
									<Plus className="mr-2 size-4" />
									{t("settings.sso.addOidc")}
								</Button>
							</RegisterOidcDialog>
							<RegisterSamlDialog>
								<Button variant="outline" size="sm">
									<Plus className="mr-2 size-4" />
									{t("settings.sso.addSaml")}
								</Button>
							</RegisterSamlDialog>
						</div>
						<div className="space-y-3">
							<p className="text-sm font-medium">
								{t("settings.sso.registeredProviders")}
							</p>
							<div className="grid gap-3 sm:grid-cols-2">
								{providers.map((provider) => {
									const isOidc = !!provider.oidcConfig;
									const isSaml = !!provider.samlConfig;
									return (
										<Card key={provider.id} className="bg-background">
											<CardHeader className="pb-2">
												<CardTitle className="text-base">
													{provider.providerId}
												</CardTitle>
												<CardDescription className="break-all text-xs">
													{provider.issuer}
												</CardDescription>
												<div className="flex flex-wrap gap-1 pt-1">
													<Badge variant="secondary" className="text-xs">
														{provider.domain}
													</Badge>
													{isOidc ? (
														<Badge variant="outline" className="text-xs">
															OIDC
														</Badge>
													) : null}
													{isSaml ? (
														<Badge variant="outline" className="text-xs">
															SAML
														</Badge>
													) : null}
												</div>
											</CardHeader>
											<CardContent className="flex flex-wrap gap-2 pt-0">
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setDetailsProvider(provider)}
												>
													<Eye className="mr-1 size-3" />
													{t("settings.sso.viewDetails")}
												</Button>
												{isOidc ? (
													<RegisterOidcDialog providerId={provider.providerId}>
														<Button variant="ghost" size="sm">
															<Pencil className="mr-1 size-3" />
															{t("settings.sso.edit")}
														</Button>
													</RegisterOidcDialog>
												) : null}
												{isSaml ? (
													<RegisterSamlDialog providerId={provider.providerId}>
														<Button variant="ghost" size="sm">
															<Pencil className="mr-1 size-3" />
															{t("settings.sso.edit")}
														</Button>
													</RegisterSamlDialog>
												) : null}
												<DialogAction
													title={t("settings.sso.removeProviderTitle")}
													description={t("settings.sso.removeProviderDescription", {
														providerId: provider.providerId,
													})}
													type="destructive"
													onClick={async () => {
														try {
															await deleteProvider.mutateAsync({
																providerId: provider.providerId,
															});
															toast.success(t("settings.sso.removed"));
															await utils.sso.listProviders.invalidate();
														} catch (error) {
															toast.error(
																error instanceof Error
																	? error.message
																	: t("settings.sso.removeError"),
															);
														}
													}}
												>
													<Button
														variant="ghost"
														size="sm"
														className="text-destructive hover:text-destructive"
													>
														<Trash2 className="mr-1 size-3" />
														{t("settings.sso.remove")}
													</Button>
												</DialogAction>
											</CardContent>
										</Card>
									);
								})}
							</div>
						</div>
					</>
				) : (
					<div className="flex flex-col items-center justify-center gap-4 rounded-md border border-dashed py-10 text-center">
						<div className="rounded-full bg-muted p-4">
							<LogIn className="size-8 text-muted-foreground" />
						</div>
						<div className="space-y-1">
							<p className="text-lg font-semibold">
								{t("settings.sso.emptyTitle")}
							</p>
							<p className="text-sm text-muted-foreground">
								{t("settings.sso.emptyDescription")}
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							<RegisterOidcDialog>
								<Button variant="secondary">
									<Plus className="mr-2 size-4" />
									{t("settings.sso.addOidc")}
								</Button>
							</RegisterOidcDialog>
							<RegisterSamlDialog>
								<Button variant="outline">
									<Plus className="mr-2 size-4" />
									{t("settings.sso.addSaml")}
								</Button>
							</RegisterSamlDialog>
						</div>
					</div>
				)}
			</CardContent>

			<Dialog
				open={!!detailsProvider}
				onOpenChange={(open) => !open && setDetailsProvider(null)}
			>
				<DialogContent className="sm:max-w-[480px]">
					{detailsProvider ? (
						<>
							<DialogHeader>
								<DialogTitle>{t("settings.sso.detailsTitle")}</DialogTitle>
								<DialogDescription>
									{t("settings.sso.detailsDescription")}
								</DialogDescription>
							</DialogHeader>
							<div className="grid gap-3 py-2">
								<div className="grid gap-1">
									<span className="text-xs font-medium text-muted-foreground">
										{t("settings.sso.form.providerId")}
									</span>
									<p className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm">
										{detailsProvider.providerId}
									</p>
								</div>
								<div className="grid gap-1">
									<span className="text-xs font-medium text-muted-foreground">
										{t("settings.sso.form.issuer")}
									</span>
									<p className="rounded-md bg-muted px-2 py-1.5 break-all text-sm">
										{detailsProvider.issuer}
									</p>
								</div>
								<div className="grid gap-1">
									<span className="text-xs font-medium text-muted-foreground">
										{t("settings.sso.form.domains")}
									</span>
									<p className="rounded-md bg-muted px-2 py-1.5 text-sm">
										{detailsProvider.domain}
									</p>
								</div>
								{detailsProvider.oidcConfig ? (
									<>
										{(() => {
											const oidc = parseOidcConfig(detailsProvider.oidcConfig);
											if (!oidc) return null;
											return (
												<>
													{oidc.clientId ? (
														<div className="grid gap-1">
															<span className="text-xs font-medium text-muted-foreground">
																{t("settings.sso.form.clientId")}
															</span>
															<p className="rounded-md bg-muted px-2 py-1.5 font-mono text-sm">
																{oidc.clientId}
															</p>
														</div>
													) : null}
													{oidc.scopes?.length ? (
														<div className="grid gap-1">
															<span className="text-xs font-medium text-muted-foreground">
																{t("settings.sso.form.scopes")}
															</span>
															<p className="rounded-md bg-muted px-2 py-1.5 text-sm">
																{oidc.scopes.join(" ")}
															</p>
														</div>
													) : null}
												</>
											);
										})()}
									</>
								) : null}
								{detailsProvider.samlConfig ? (
									<>
										{(() => {
											const saml = parseSamlConfig(detailsProvider.samlConfig);
											if (!saml?.entryPoint) return null;
											return (
												<div className="grid gap-1">
													<span className="text-xs font-medium text-muted-foreground">
														{t("settings.sso.form.entryPoint")}
													</span>
													<p className="rounded-md bg-muted px-2 py-1.5 break-all text-sm">
														{saml.entryPoint}
													</p>
												</div>
											);
										})()}
									</>
								) : null}
								<div className="grid gap-1">
									<span className="text-xs font-medium text-muted-foreground">
										{t("settings.sso.callbackUrl")}
									</span>
									<p className="rounded-md bg-muted px-2 py-1.5 break-all font-mono text-xs">
										{baseUrl || "{baseUrl}"}
										{detailsProvider.samlConfig
											? "/api/auth/sso/saml2/callback/"
											: "/api/auth/sso/callback/"}
										{detailsProvider.providerId}
									</p>
								</div>
							</div>
							<DialogFooter>
								<Button variant="outline" onClick={() => setDetailsProvider(null)}>
									{t("settings.common.cancel")}
								</Button>
							</DialogFooter>
						</>
					) : null}
				</DialogContent>
			</Dialog>

			<Dialog open={manageOriginsOpen} onOpenChange={setManageOriginsOpen}>
				<DialogContent className="sm:max-w-[480px]">
					<DialogHeader>
						<DialogTitle>{t("settings.sso.origins.title")}</DialogTitle>
						<DialogDescription>
							{t("settings.sso.origins.description")}
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-2">
						<div className="space-y-2">
							<p className="text-sm font-medium">
								{t("settings.sso.origins.current")}
							</p>
							{trustedOrigins.length === 0 ? (
								<p className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
									{t("settings.sso.origins.empty")}
								</p>
							) : (
								<ul className="flex flex-col gap-2">
									{trustedOrigins.map((origin) => (
										<li
											key={origin}
											className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2"
										>
											{editingOrigin === origin ? (
												<>
													<Input
														value={editingValue}
														onChange={(event) => setEditingValue(event.target.value)}
														className="flex-1 font-mono text-sm"
														autoFocus
													/>
													<Button size="sm" onClick={handleSaveOrigin}>
														{t("settings.common.save")}
													</Button>
													<Button
														size="sm"
														variant="ghost"
														onClick={() => {
															setEditingOrigin(null);
															setEditingValue("");
														}}
													>
														{t("settings.common.cancel")}
													</Button>
												</>
											) : (
												<>
													<span className="flex-1 break-all font-mono text-sm">
														{origin}
													</span>
													<Button
														variant="ghost"
														size="icon"
														onClick={() => {
															setEditingOrigin(origin);
															setEditingValue(origin);
														}}
													>
														<Pencil className="size-3.5" />
													</Button>
													<DialogAction
														title={t("settings.sso.origins.removeTitle")}
														description={t("settings.sso.origins.removeDescription", {
															origin,
														})}
														type="destructive"
														onClick={async () => handleRemoveOrigin(origin)}
													>
														<Button
															variant="ghost"
															size="icon"
															className="text-destructive hover:text-destructive"
														>
															<Trash2 className="size-3.5" />
														</Button>
													</DialogAction>
												</>
											)}
										</li>
									))}
								</ul>
							)}
						</div>
						<div className="space-y-2">
							<p className="text-sm font-medium">
								{t("settings.sso.origins.addLabel")}
							</p>
							<div className="flex gap-2">
								<Input
									value={newOrigin}
									onChange={(event) => setNewOrigin(event.target.value)}
									placeholder="https://example.com"
									className="font-mono text-sm"
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											void handleAddOrigin();
										}
									}}
								/>
								<Button onClick={handleAddOrigin}>
									<Plus className="mr-1 size-4" />
									{t("settings.sso.origins.add")}
								</Button>
							</div>
						</div>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setManageOriginsOpen(false)}>
							{t("settings.common.cancel")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
