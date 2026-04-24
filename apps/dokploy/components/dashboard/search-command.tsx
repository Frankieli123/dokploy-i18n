"use client";

import { BookIcon, CircuitBoard, GlobeIcon, Loader2 } from "lucide-react";
import { useRouter } from "next/router";
import { useTranslation } from "next-i18next";
import React, { useMemo } from "react";
import {
	extractServices,
	type Services,
} from "@/components/dashboard/settings/users/add-permissions";
import {
	MariadbIcon,
	MongodbIcon,
	MysqlIcon,
	PostgresqlIcon,
	RedisIcon,
} from "@/components/icons/data-tools-icons";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import { api } from "@/utils/api";
import { useDebounce } from "@/utils/hooks/use-debounce";
import { StatusTooltip } from "../shared/status-tooltip";

type SearchServices = Services & {
	environmentId: string;
	environmentName: string;
};

const extractAllServicesFromProject = (project: {
	environments?: Array<{
		environmentId: string;
		name: string;
		[key: string]: unknown;
	}>;
}) =>
	(project.environments ?? []).flatMap((environment) =>
		extractServices(environment as Parameters<typeof extractServices>[0]).map(
			(service) => ({
				...service,
				environmentId: environment.environmentId,
				environmentName: environment.name,
			}),
		),
	);

const SERVICE_TYPES = [
	"application",
	"compose",
	"mariadb",
	"mongo",
	"mysql",
	"postgres",
	"redis",
] as const;

const getPreferredEnvironment = (
	environments?: Array<{
		environmentId: string;
		name: string;
		isDefault?: boolean | null;
	}>,
) =>
	environments?.find((environment) => environment.isDefault) ||
	environments?.find((environment) => environment.name === "production") ||
	environments?.[0];

const getServiceIcon = (type: Services["type"]) => {
	if (type === "postgres") {
		return <PostgresqlIcon className="h-6 w-6 mr-2" />;
	}
	if (type === "redis") {
		return <RedisIcon className="h-6 w-6 mr-2" />;
	}
	if (type === "mariadb") {
		return <MariadbIcon className="h-6 w-6 mr-2" />;
	}
	if (type === "mongo") {
		return <MongodbIcon className="h-6 w-6 mr-2" />;
	}
	if (type === "mysql") {
		return <MysqlIcon className="h-6 w-6 mr-2" />;
	}
	if (type === "application") {
		return <GlobeIcon className="h-6 w-6 mr-2" />;
	}
	return <CircuitBoard className="h-6 w-6 mr-2" />;
};

export const SearchCommand = () => {
	const router = useRouter();
	const [open, setOpen] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const debouncedSearch = useDebounce(search, 300);
	const { data: session } = api.user.session.useQuery();
	const { data } = api.project.all.useQuery(undefined, {
		enabled: !!session,
	});
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { t } = useTranslation("common");
	const trimmedSearch = debouncedSearch.trim();
	const remoteSearchEnabled = !!session && open && trimmedSearch.length > 0;

	const formatEnvName = (envName?: string) =>
		envName === "production" ? t("environment.default.production") : envName;

	const projectSearch = api.project.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);
	const applicationSearch = api.application.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);
	const composeSearch = api.compose.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);
	const mariadbSearch = api.mariadb.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);
	const mongoSearch = api.mongo.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);
	const mysqlSearch = api.mysql.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);
	const postgresSearch = api.postgres.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);
	const redisSearch = api.redis.search.useQuery(
		{
			q: trimmedSearch,
			limit: 20,
			offset: 0,
		},
		{
			enabled: remoteSearchEnabled,
		},
	);

	const remoteProjects = useMemo(() => {
		if (!remoteSearchEnabled) {
			return [];
		}

		return (projectSearch.data?.items ?? [])
			.map((project: any) => {
				const target = getPreferredEnvironment(project.environments);
				if (!target) {
					return null;
				}
				return {
					projectId: project.projectId,
					name: project.name,
					environmentId: target.environmentId,
					environmentName: target.name,
				};
			})
			.filter(Boolean);
	}, [projectSearch.data?.items, remoteSearchEnabled]);

	const remoteServices = useMemo(() => {
		if (!remoteSearchEnabled) {
			return [];
		}

		const allItems = [
			...(applicationSearch.data?.items ?? []).map((item: any) => ({
				type: "application" as const,
				id: item.applicationId,
				projectId: item.projectId,
				projectName: item.projectName,
				name: item.name,
				status: item.applicationStatus,
				environmentId: item.environmentId,
				environmentName: item.environmentName,
			})),
			...(composeSearch.data?.items ?? []).map((item: any) => ({
				type: "compose" as const,
				id: item.composeId,
				projectId: item.projectId,
				projectName: item.projectName,
				name: item.name,
				status: item.composeStatus,
				environmentId: item.environmentId,
				environmentName: item.environmentName,
			})),
			...(mariadbSearch.data?.items ?? []).map((item: any) => ({
				type: "mariadb" as const,
				id: item.mariadbId,
				projectId: item.projectId,
				projectName: item.projectName,
				name: item.name,
				status: item.applicationStatus,
				environmentId: item.environmentId,
				environmentName: item.environmentName,
			})),
			...(mongoSearch.data?.items ?? []).map((item: any) => ({
				type: "mongo" as const,
				id: item.mongoId,
				projectId: item.projectId,
				projectName: item.projectName,
				name: item.name,
				status: item.applicationStatus,
				environmentId: item.environmentId,
				environmentName: item.environmentName,
			})),
			...(mysqlSearch.data?.items ?? []).map((item: any) => ({
				type: "mysql" as const,
				id: item.mysqlId,
				projectId: item.projectId,
				projectName: item.projectName,
				name: item.name,
				status: item.applicationStatus,
				environmentId: item.environmentId,
				environmentName: item.environmentName,
			})),
			...(postgresSearch.data?.items ?? []).map((item: any) => ({
				type: "postgres" as const,
				id: item.postgresId,
				projectId: item.projectId,
				projectName: item.projectName,
				name: item.name,
				status: item.applicationStatus,
				environmentId: item.environmentId,
				environmentName: item.environmentName,
			})),
			...(redisSearch.data?.items ?? []).map((item: any) => ({
				type: "redis" as const,
				id: item.redisId,
				projectId: item.projectId,
				projectName: item.projectName,
				name: item.name,
				status: item.applicationStatus,
				environmentId: item.environmentId,
				environmentName: item.environmentName,
			})),
		];

		return allItems.filter(
			(item) =>
				SERVICE_TYPES.includes(item.type) &&
				!!item.projectId &&
				!!item.projectName &&
				!!item.environmentName,
		);
	}, [
		applicationSearch.data?.items,
		composeSearch.data?.items,
		mariadbSearch.data?.items,
		mongoSearch.data?.items,
		mysqlSearch.data?.items,
		postgresSearch.data?.items,
		redisSearch.data?.items,
		remoteSearchEnabled,
	]);

	const isRemoteSearching =
		remoteSearchEnabled &&
		[
			projectSearch,
			applicationSearch,
			composeSearch,
			mariadbSearch,
			mongoSearch,
			mysqlSearch,
			postgresSearch,
			redisSearch,
		].some((query) => query.isLoading || query.isFetching);

	React.useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.key === "j" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpen((open) => !open);
			}
		};

		document.addEventListener("keydown", down);
		return () => document.removeEventListener("keydown", down);
	}, []);

	return (
		<div>
			<CommandDialog open={open} onOpenChange={setOpen}>
				<CommandInput
					placeholder={"Search projects or settings"}
					value={search}
					onValueChange={setSearch}
				/>
				<CommandList>
					<CommandEmpty>
						{isRemoteSearching ? (
							<div className="flex items-center justify-center gap-2">
								<Loader2 className="size-4 animate-spin" />
								<span>Searching...</span>
							</div>
						) : trimmedSearch ? (
							"No results found."
						) : (
							"No projects added yet. Click on Create project."
						)}
					</CommandEmpty>
					<CommandGroup heading={"Projects"}>
						<CommandList>
							{(trimmedSearch ? remoteProjects : data)?.map((project: any) => {
								const targetEnvironment = trimmedSearch
									? {
											environmentId: project.environmentId,
											name: project.environmentName,
										}
									: getPreferredEnvironment(project.environments);

								if (!targetEnvironment) return null;

								return (
									<CommandItem
										key={project.projectId}
										onSelect={() => {
											router.push(
												`/dashboard/project/${project.projectId}/environment/${targetEnvironment.environmentId}`,
											);
											setOpen(false);
										}}
									>
										<BookIcon className="size-4 text-muted-foreground mr-2" />
										{project.name} /{" "}
										{formatEnvName(targetEnvironment.name)}
									</CommandItem>
								);
							})}
						</CommandList>
					</CommandGroup>
					<CommandSeparator />
					<CommandGroup heading={"Services"}>
						<CommandList>
							{(trimmedSearch
								? remoteServices
								: (data ?? []).flatMap((project: any) =>
										extractAllServicesFromProject(project).map((application) => ({
											...application,
											projectId: project.projectId,
											projectName: project.name,
										})),
									)
							)?.map((application: any) => (
									<CommandItem
										key={`${application.type}-${application.id}`}
										onSelect={() => {
											router.push(
												`/dashboard/project/${application.projectId}/environment/${application.environmentId}/services/${application.type}/${application.id}`,
											);
											setOpen(false);
										}}
									>
										{getServiceIcon(application.type)}
										<span className="flex-grow">
											{application.projectName} /{" "}
											{formatEnvName(application.environmentName)} /{" "}
											{application.name}
											<div style={{ display: "none" }}>{application.id}</div>
										</span>
										<div>
											<StatusTooltip status={application.status} />
										</div>
									</CommandItem>
								))}
						</CommandList>
					</CommandGroup>
					<CommandSeparator />
					<CommandGroup heading={"Application"} hidden={true}>
						<CommandItem
							onSelect={() => {
								router.push("/dashboard/projects");
								setOpen(false);
							}}
						>
							Projects
						</CommandItem>
						<CommandItem
							onSelect={() => {
								router.push("/dashboard/deployments");
								setOpen(false);
							}}
						>
							{t("tabs.deployments")}
						</CommandItem>
						{!isCloud && (
							<>
								<CommandItem
									onSelect={() => {
										router.push("/dashboard/monitoring");
										setOpen(false);
									}}
								>
									Monitoring
								</CommandItem>
								<CommandItem
									onSelect={() => {
										router.push("/dashboard/traefik");
										setOpen(false);
									}}
								>
									Traefik
								</CommandItem>
								<CommandItem
									onSelect={() => {
										router.push("/dashboard/docker");
										setOpen(false);
									}}
								>
									Docker
								</CommandItem>
								<CommandItem
									onSelect={() => {
										router.push("/dashboard/requests");
										setOpen(false);
									}}
								>
									Requests
								</CommandItem>
							</>
						)}
						<CommandItem
							onSelect={() => {
								router.push("/dashboard/settings/server");
								setOpen(false);
							}}
						>
							Settings
						</CommandItem>
					</CommandGroup>
				</CommandList>
			</CommandDialog>
		</div>
	);
};
