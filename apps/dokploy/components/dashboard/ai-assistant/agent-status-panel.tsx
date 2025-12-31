"use client";

import { CheckCircle2, Circle, Loader2, Play, XCircle } from "lucide-react";
import { useTranslation } from "next-i18next";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export type AgentStepStatus =
	| "pending"
	| "in-progress"
	| "completed"
	| "failed";

export interface AgentStep {
	id: string;
	description: string;
	status: AgentStepStatus;
}

interface AgentStatusPanelProps {
	runId: string;
	status: "planning" | "executing" | "paused" | "completed" | "failed";
	goal: string;
	plan: AgentStep[];
	currentStep: number;
	onApprove?: () => void;
	onCancel?: () => void;
}

export function AgentStatusPanel({
	status,
	goal,
	plan,
	currentStep,
	onApprove,
	onCancel,
}: AgentStatusPanelProps) {
	const { t } = useTranslation("common");
	const progress = plan.length > 0 ? (currentStep / plan.length) * 100 : 0;

	return (
		<div className="rounded-lg border bg-card text-card-foreground shadow-sm mb-4">
			<div className="p-4 space-y-4">
				<div className="flex items-start justify-between">
						<div className="space-y-1">
							<h3 className="font-semibold leading-none tracking-tight">
								{t("ai.agent.statusTitle")}
							</h3>
							<p className="text-sm text-muted-foreground">{goal}</p>
						</div>
					<div className="flex items-center gap-2">
							{status === "paused" && onApprove && (
								<Button size="sm" onClick={onApprove} className="h-8">
									<Play className="mr-2 h-4 w-4" />
									{t("common.continue")}
								</Button>
							)}
						{onCancel && status !== "completed" && status !== "failed" && (
							<Button
								size="sm"
								variant="destructive"
								onClick={onCancel}
									className="h-8"
								>
									<XCircle className="mr-2 h-4 w-4" />
									{t("common.cancel")}
								</Button>
							)}
					</div>
				</div>

				<div className="space-y-2">
						<div className="flex justify-between text-xs text-muted-foreground">
							<span>{t("ai.agent.progress")}</span>
							<span>{Math.round(progress)}%</span>
						</div>
					<Progress value={progress} className="h-2" />
				</div>

				<div className="space-y-2 max-h-[200px] overflow-y-auto pr-2">
					{plan.map((step, index) => (
						<div
							key={step.id}
							className={cn(
								"flex items-center gap-3 rounded-md p-2 text-sm transition-colors",
								index === currentStep && status === "executing"
									? "bg-accent"
									: "hover:bg-muted/50",
							)}
						>
							<div className="flex-shrink-0">
								{step.status === "completed" && (
									<CheckCircle2 className="h-4 w-4 text-green-500" />
								)}
								{step.status === "in-progress" && (
									<Loader2 className="h-4 w-4 animate-spin text-blue-500" />
								)}
								{step.status === "failed" && (
									<XCircle className="h-4 w-4 text-destructive" />
								)}
								{step.status === "pending" && (
									<Circle className="h-4 w-4 text-muted-foreground" />
								)}
							</div>
							<span
								className={cn(
									"flex-1",
									step.status === "completed" &&
										"text-muted-foreground line-through",
									index === currentStep && "font-medium",
								)}
							>
								{step.description}
							</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
