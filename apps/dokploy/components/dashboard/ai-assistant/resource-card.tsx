"use client";

import {
	AppWindow,
	Database,
	ExternalLink,
	FileKey,
	Globe,
	MoreVertical,
	Server,
} from "lucide-react";
import Link from "next/link";
import { useTranslation } from "next-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type ResourceType =
	| "application"
	| "database"
	| "server"
	| "domain"
	| "certificate";

export interface ResourceData {
	id: string;
	name: string;
	status: string;
	type: ResourceType;
	details?: Record<string, string | number>;
	url?: string;
}

interface ResourceCardProps {
	type: ResourceType;
	resource: ResourceData;
	actions?: {
		label: string;
		onClick: () => void;
		icon?: React.ReactNode;
		variant?: "default" | "destructive" | "outline" | "ghost";
	}[];
}

const iconMap: Record<
	ResourceType,
	React.ComponentType<{ className?: string }>
> = {
	application: AppWindow,
	database: Database,
	server: Server,
	domain: Globe,
	certificate: FileKey,
};

const statusColorMap: Record<
	string,
	"default" | "secondary" | "destructive" | "outline"
> = {
	running: "default",
	active: "default",
	healthy: "default",
	stopped: "secondary",
	inactive: "secondary",
	error: "destructive",
	failed: "destructive",
};

export function ResourceCard({ type, resource, actions }: ResourceCardProps) {
	const { t } = useTranslation("common");
	const Icon = iconMap[type] || AppWindow;

	return (
		<Card className="w-full">
			<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
				<div className="flex items-center gap-2">
					<div className="p-2 bg-primary/10 rounded-md">
						<Icon className="h-4 w-4 text-primary" />
					</div>
					<CardTitle className="text-sm font-medium">{resource.name}</CardTitle>
				</div>
				<Badge
					variant={statusColorMap[resource.status.toLowerCase()] || "outline"}
				>
					{resource.status}
				</Badge>
			</CardHeader>
			<CardContent>
				{resource.details && (
					<div className="grid grid-cols-2 gap-2 mb-4">
						{Object.entries(resource.details).map(([key, value]) => (
							<div key={key} className="flex flex-col space-y-1">
								<span className="text-xs text-muted-foreground capitalize">
									{key.replace(/_/g, " ")}
								</span>
								<span
									className="text-sm font-medium truncate"
									title={String(value)}
								>
									{value}
								</span>
							</div>
						))}
					</div>
				)}

				<div className="flex items-center justify-between mt-4">
					{resource.url ? (
						<Link href={resource.url} passHref>
								<Button variant="outline" size="sm" className="h-8">
									<ExternalLink className="mr-2 h-3 w-3" />
									{t("common.view")}
								</Button>
							</Link>
						) : (
						<div />
					)}

					{actions && actions.length > 0 && (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="ghost" size="sm" className="h-8 w-8 p-0">
									<MoreVertical className="h-4 w-4" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								{actions.map((action, idx) => (
									<DropdownMenuItem
										key={idx}
										onClick={action.onClick}
										className={
											action.variant === "destructive" ? "text-destructive" : ""
										}
									>
										{action.icon && <span className="mr-2">{action.icon}</span>}
										{action.label}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
