"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
	Loader2,
	Pencil,
	PlusIcon,
	ShieldCheck,
	Trash2,
	Users,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DialogAction } from "@/components/shared/dialog-action";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const HIDDEN_RESOURCES = ["organization", "invitation", "team", "ac"];

const createRoleSchema = (t: (key: string) => string) =>
	z.object({
		role: z
			.string()
			.min(1, t("settings.users.roles.validation.roleRequired"))
			.max(50, t("settings.users.roles.validation.roleTooLong"))
			.regex(
				/^[a-zA-Z0-9:_-]+$/,
				t("settings.users.roles.validation.roleFormat"),
			),
	});

type FormValues = {
	role: string;
};

type RolePermissions = Record<string, string[]>;
type RoleItem = {
	role: string;
	permissions: RolePermissions;
	createdAt?: string;
};

const RESOURCE_META: Record<string, { label: string; description: string }> = {
	project: {
		label: "Projects",
		description: "Manage project creation and deletion",
	},
	service: {
		label: "Services",
		description: "Manage services within projects",
	},
	environment: {
		label: "Environments",
		description: "Manage environment creation, viewing, and deletion",
	},
	docker: {
		label: "Docker",
		description: "Access Docker-level actions and diagnostics",
	},
	sshKeys: {
		label: "SSH Keys",
		description: "Manage SSH key configurations",
	},
	gitProviders: {
		label: "Git Providers",
		description: "Manage Git provider connections",
	},
	traefikFiles: {
		label: "Traefik Files",
		description: "View and edit Traefik configuration files",
	},
	api: {
		label: "API / CLI",
		description: "Access API keys and CLI-related capabilities",
	},
	volume: {
		label: "Volumes",
		description: "Manage service volumes and mounts",
	},
	deployment: {
		label: "Deployments",
		description: "Trigger and manage deployments",
	},
	envVars: {
		label: "Service Env Vars",
		description: "Manage service-level environment variables",
	},
	projectEnvVars: {
		label: "Project Shared Env Vars",
		description: "Manage project-level shared environment variables",
	},
	environmentEnvVars: {
		label: "Environment Shared Env Vars",
		description: "Manage environment-level shared environment variables",
	},
	server: {
		label: "Servers",
		description: "Manage remote servers and nodes",
	},
	registry: {
		label: "Registries",
		description: "Manage container registries",
	},
	certificate: {
		label: "Certificates",
		description: "Manage certificates and SSL settings",
	},
	backup: {
		label: "Backups",
		description: "Manage backups and restores",
	},
	volumeBackup: {
		label: "Volume Backups",
		description: "Manage volume backups and restores",
	},
	schedule: {
		label: "Schedules",
		description: "Manage scheduled jobs",
	},
	domain: {
		label: "Domains",
		description: "Manage domains bound to services",
	},
	destination: {
		label: "S3 Destinations",
		description: "Manage S3-compatible backup destinations",
	},
	notification: {
		label: "Notifications",
		description: "Manage notification providers",
	},
	member: {
		label: "Users",
		description: "Manage members, invitations, and roles",
	},
	logs: {
		label: "Logs",
		description: "View service and deployment logs",
	},
	monitoring: {
		label: "Monitoring",
		description: "View server and service metrics",
	},
	auditLog: {
		label: "Audit Logs",
		description: "View organization audit logs",
	},
};

const ACTION_META: Record<string, Record<string, string>> = {
	project: {
		create: "Create",
		delete: "Delete",
	},
	service: {
		create: "Create",
		read: "Read",
		delete: "Delete",
	},
	environment: {
		create: "Create",
		read: "Read",
		delete: "Delete",
	},
	deployment: {
		read: "Read",
		create: "Deploy",
		cancel: "Cancel",
	},
	backup: {
		read: "Read",
		create: "Create",
		update: "Update",
		delete: "Delete",
		restore: "Restore",
	},
	volumeBackup: {
		read: "Read",
		create: "Create",
		update: "Update",
		delete: "Delete",
		restore: "Restore",
	},
};

function MembersBadge({ role }: { role: string }) {
	const [open, setOpen] = useState(false);
	const { data: members = [], isLoading } = api.customRole.membersByRole.useQuery(
		{ roleName: role },
		{ enabled: open },
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/80"
				>
					<Users className="size-3" />
					{members.length}
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-64 p-2" align="start">
				<p className="px-1 pb-2 text-xs font-medium text-muted-foreground">
					Assigned members
				</p>
				{isLoading ? (
					<div className="flex justify-center py-3">
						<Loader2 className="size-4 animate-spin text-muted-foreground" />
					</div>
				) : members.length === 0 ? (
					<p className="px-1 py-2 text-xs text-muted-foreground">
						No members assigned
					</p>
				) : (
					<ul className="space-y-1">
						{members.map((item) => (
							<li
								key={item.id}
								className="rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
							>
								<p className="font-medium">{item.user.name}</p>
								<p className="text-muted-foreground">{item.user.email}</p>
							</li>
						))}
					</ul>
				)}
			</PopoverContent>
		</Popover>
	);
}

function PermissionEditor({
	catalog,
	permissions,
	onToggle,
}: {
	catalog: Record<string, readonly string[]>;
	permissions: RolePermissions;
	onToggle: (resource: string, action: string) => void;
}) {
	const resources = Object.entries(catalog).filter(
		([resource]) => !HIDDEN_RESOURCES.includes(resource),
	);

	return (
		<div className="space-y-3 pt-2">
			<p className="text-sm font-medium">Permissions</p>
			<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
				{resources.map(([resource, actions]) => (
					<div key={resource} className="rounded-lg border p-3 space-y-3">
						<div>
							<p className="text-sm font-medium">
								{RESOURCE_META[resource]?.label ?? resource}
							</p>
							<p className="text-xs text-muted-foreground">
								{RESOURCE_META[resource]?.description ?? resource}
							</p>
						</div>
						<div className="space-y-2">
							{actions.map((action) => (
								<div
									key={`${resource}-${action}`}
									className="flex items-center gap-3 rounded-md border p-2 hover:bg-muted/50 cursor-pointer"
									onClick={() => onToggle(resource, action)}
								>
									<Switch
										checked={permissions[resource]?.includes(action) ?? false}
										onCheckedChange={() => onToggle(resource, action)}
									/>
									<div className="flex flex-col">
										<span className="text-xs font-medium">
											{ACTION_META[resource]?.[action] ?? action}
										</span>
									</div>
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

function RoleDialog({
	role,
	onSuccess,
	trigger,
}: {
	role?: RoleItem;
	onSuccess: () => Promise<void>;
	trigger: React.ReactNode;
}) {
	const { t } = useTranslation("settings");
	const [open, setOpen] = useState(false);
	const { data: catalog } = api.customRole.getStatements.useQuery();
	const createRole = api.customRole.create.useMutation();
	const updateRole = api.customRole.update.useMutation();
	const form = useForm<FormValues>({
		resolver: zodResolver(createRoleSchema(t) as any) as any,
		defaultValues: { role: "" },
	});
	const [permissions, setPermissions] = useState<RolePermissions>({});

	useEffect(() => {
		if (!open) return;
		form.reset({ role: role?.role ?? "" });
		setPermissions(role ? { ...role.permissions } : {});
	}, [form, open, role]);

	const onToggle = (resource: string, action: string) => {
		setPermissions((current) => {
			const actions = current[resource] ?? [];
			const nextActions = actions.includes(action)
				? actions.filter((item) => item !== action)
				: [...actions, action];
			return {
				...current,
				[resource]: nextActions,
			};
		});
	};

	const onSubmit = async (values: FormValues) => {
		try {
			if (role) {
				await updateRole.mutateAsync({
					roleName: role.role,
					newRoleName:
						values.role.trim() !== role.role ? values.role.trim() : undefined,
					permissions,
				});
			} else {
				await createRole.mutateAsync({
					roleName: values.role.trim(),
					permissions,
				});
			}
			toast.success(
				role
					? t("settings.users.roles.toast.updated")
					: t("settings.users.roles.toast.created"),
			);
			setOpen(false);
			await onSuccess();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("settings.users.roles.toast.error"),
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className="max-h-[85vh] sm:max-w-5xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{role
							? t("settings.users.roles.editTitle")
							: t("settings.users.roles.createTitle")}
					</DialogTitle>
					<DialogDescription>
						{t("settings.users.roles.dialogDescription")}
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						id="handle-role-form"
						onSubmit={form.handleSubmit(onSubmit)}
						className="space-y-4"
					>
						<FormField
							control={form.control}
							name="role"
							render={({ field }) => (
								<FormItem>
									<FormLabel>{t("settings.users.roles.roleLabel")}</FormLabel>
									<FormControl>
										<Input
											{...field}
											readOnly={!!role}
											className={role ? "bg-muted" : undefined}
											placeholder="developer"
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						{catalog ? (
							<PermissionEditor
								catalog={catalog as Record<string, readonly string[]>}
								permissions={permissions}
								onToggle={onToggle}
							/>
						) : null}
						<DialogFooter>
							<Button type="button" variant="outline" onClick={() => setOpen(false)}>
								{t("settings.common.cancel")}
							</Button>
							<Button
								type="submit"
								isPending={role ? updateRole.isPending : createRole.isPending}
							>
								{role
									? t("settings.users.roles.save")
									: t("settings.users.roles.create")}
							</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}

export const ManageCustomRoles = () => {
	const { t } = useTranslation("settings");
	const { data: roles = [], refetch, isLoading } = api.customRole.all.useQuery();
	const deleteRole = api.customRole.remove.useMutation();

	const refresh = async () => {
		await refetch();
	};

	return (
		<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto w-full">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader>
					<div className="flex items-center justify-between gap-4">
						<div>
							<CardTitle className="text-xl flex flex-row gap-2">
								<ShieldCheck className="size-6 text-muted-foreground self-center" />
								{t("settings.users.roles.title")}
							</CardTitle>
							<CardDescription>
								{t("settings.users.roles.description")}
							</CardDescription>
						</div>
						<RoleDialog
							onSuccess={refresh}
							trigger={
								<Button>
									<PlusIcon className="mr-2 size-4" />
									{t("settings.users.roles.add")}
								</Button>
							}
						/>
					</div>
				</CardHeader>
				<CardContent className="border-t pt-6">
					{isLoading ? (
						<div className="flex items-center justify-center py-10">
							<Loader2 className="size-5 animate-spin text-muted-foreground" />
						</div>
					) : roles.length === 0 ? (
						<div className="text-center py-8 text-muted-foreground">
							{t("settings.users.roles.empty")}
						</div>
					) : (
						<div className="grid gap-3">
							{(roles as RoleItem[]).map((role) => {
								const totalPermissions = Object.values(role.permissions).flat().length;
								const enabledResources = Object.entries(role.permissions).filter(
									([, actions]) => actions.length > 0,
								);

								return (
									<div
										key={role.role}
										className="rounded-lg border bg-muted/20 p-4 space-y-3"
									>
										<div className="flex items-start justify-between gap-2">
											<div className="flex items-center gap-2.5 min-w-0">
												<div className="rounded-md bg-primary/10 p-1.5 shrink-0">
													<ShieldCheck className="size-4 text-primary" />
												</div>
												<div className="min-w-0">
													<div className="flex items-center gap-2">
														<p className="font-semibold text-sm truncate">{role.role}</p>
														<MembersBadge role={role.role} />
													</div>
													<p className="text-xs text-muted-foreground">
														{enabledResources.length} resources · {totalPermissions} permissions
													</p>
												</div>
											</div>
											<div className="flex items-center gap-1.5 shrink-0">
												<RoleDialog
													role={role}
													onSuccess={refresh}
													trigger={
														<Button variant="outline" size="sm" className="h-7 text-xs">
															<Pencil className="mr-1 size-3.5" />
															{t("settings.users.roles.editTitle")}
														</Button>
													}
												/>
												<DialogAction
													title={t("settings.users.roles.deleteTitle")}
													description={t("settings.users.roles.deleteDescription", {
														role: role.role,
													})}
													type="destructive"
													onClick={async () => {
														try {
															await deleteRole.mutateAsync({ roleName: role.role });
															toast.success(t("settings.users.roles.toast.deleted"));
															await refresh();
														} catch (error) {
															toast.error(
																error instanceof Error
																	? error.message
																	: t("settings.users.roles.toast.error"),
															);
														}
													}}
												>
													<Button variant="ghost" size="icon" className="h-7 w-7">
														<Trash2 className="size-3.5 text-destructive" />
													</Button>
												</DialogAction>
											</div>
										</div>
										{enabledResources.length > 0 ? (
											<div className="flex flex-wrap gap-1.5 pt-1 border-t">
												{enabledResources.map(([resource, actions]) => (
													<div
														key={resource}
														className="flex items-center gap-1 rounded-md bg-background border px-2 py-1"
													>
														<span className="text-xs font-medium">
															{resource}
														</span>
														<span className="text-xs text-muted-foreground">·</span>
														<span className="text-xs text-muted-foreground">
															{actions.join(", ")}
														</span>
													</div>
												))}
											</div>
										) : null}
									</div>
								);
							})}
						</div>
					)}
				</CardContent>
			</div>
		</Card>
	);
};
