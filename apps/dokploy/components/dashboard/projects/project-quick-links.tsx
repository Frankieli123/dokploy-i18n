import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { StatusTooltip } from "@/components/shared/status-tooltip";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/utils/api";

type DomainItem = {
	domainId: string;
	host: string;
	path?: string | null;
	https?: boolean | null;
};

type ApplicationItem = {
	applicationId: string;
	name: string;
	applicationStatus?: string | null;
	domains: DomainItem[];
};

type ComposeItem = {
	composeId: string;
	name: string;
	composeStatus?: string | null;
	domains: DomainItem[];
};

type EnvironmentItem = {
	applications: ApplicationItem[];
	compose: ComposeItem[];
};

interface Props {
	projectId: string;
	hasDeployableServices: boolean;
}

const buildDomainUrl = (domain: DomainItem) =>
	`${domain.https ? "https" : "http"}://${domain.host}${domain.path || ""}`;

export const ProjectQuickLinks = ({ projectId, hasDeployableServices }: Props) => {
	const { t } = useTranslation("common");
	const [open, setOpen] = useState(false);
	const { data, isLoading } = api.project.quickLinks.useQuery(
		{ projectId },
		{ enabled: open && hasDeployableServices },
	);

	const environments = (data?.environments ?? []) as EnvironmentItem[];
	const haveServicesWithDomains = environments.some(
		(env) => env.applications.length > 0 || env.compose.length > 0,
	);

	if (!hasDeployableServices) {
		return null;
	}

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					className="absolute -right-3 -top-3 size-9 translate-y-1 rounded-full p-0 opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100"
					size="sm"
					variant="default"
				>
					<ExternalLinkIcon className="size-3.5" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				className="w-[200px] space-y-2 overflow-y-auto max-h-[400px]"
				onClick={(e) => e.stopPropagation()}
			>
				{isLoading ? (
					<div className="px-2 py-1.5 text-xs text-muted-foreground">
						{t("loading")}
					</div>
				) : !haveServicesWithDomains ? (
					<div className="px-2 py-1.5 text-xs text-muted-foreground">
						{t("project.empty")}
					</div>
				) : null}
				{environments.some((env) => env.applications.length > 0) && (
					<DropdownMenuGroup>
						<DropdownMenuLabel>{t("project.applications")}</DropdownMenuLabel>
						{environments.map((env) =>
							env.applications.map((app) => (
								<div key={app.applicationId}>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuLabel className="font-normal capitalize text-xs flex items-center justify-between">
											{app.name}
											<StatusTooltip status={app.applicationStatus as any} />
										</DropdownMenuLabel>
										<DropdownMenuSeparator />
										{app.domains.map((domain) => (
											<DropdownMenuItem key={domain.domainId} asChild>
												<Link
													className="space-x-4 text-xs cursor-pointer justify-between"
													target="_blank"
													href={buildDomainUrl(domain)}
												>
													<span className="truncate">{domain.host}</span>
													<ExternalLinkIcon className="size-4 shrink-0" />
												</Link>
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</div>
							)),
						)}
					</DropdownMenuGroup>
				)}

				{environments.some((env) => env.compose.length > 0) && (
					<DropdownMenuGroup>
						<DropdownMenuLabel>{t("project.compose")}</DropdownMenuLabel>
						{environments.map((env) =>
							env.compose.map((comp) => (
								<div key={comp.composeId}>
									<DropdownMenuSeparator />
									<DropdownMenuGroup>
										<DropdownMenuLabel className="font-normal capitalize text-xs flex items-center justify-between">
											{comp.name}
											<StatusTooltip status={comp.composeStatus as any} />
										</DropdownMenuLabel>
										<DropdownMenuSeparator />
										{comp.domains.map((domain) => (
											<DropdownMenuItem key={domain.domainId} asChild>
												<Link
													className="space-x-4 text-xs cursor-pointer justify-between"
													target="_blank"
													href={buildDomainUrl(domain)}
												>
													<span className="truncate">{domain.host}</span>
													<ExternalLinkIcon className="size-4 shrink-0" />
												</Link>
											</DropdownMenuItem>
										))}
									</DropdownMenuGroup>
								</div>
							)),
						)}
					</DropdownMenuGroup>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
