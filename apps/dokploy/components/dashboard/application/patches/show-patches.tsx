import { File, FilePlus2, Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, type RouterOutputs } from "@/utils/api";
import { EditPatchDialog } from "./edit-patch-dialog";
import { PatchEditor } from "./patch-editor";

interface Props {
	id: string;
	type: "application" | "compose";
}

type PatchItem = RouterOutputs["patch"]["byEntityId"][number];

export const ShowPatches = ({ id, type }: Props) => {
	const { t } = useTranslation("common");
	const [repoPath, setRepoPath] = useState<string | null>(null);
	const [isLoadingRepo, setIsLoadingRepo] = useState(false);

	const utils = api.useUtils();
	const { data: patches, isLoading: isPatchesLoading } =
		api.patch.byEntityId.useQuery({ id, type }, { enabled: !!id });

	const ensureRepo = api.patch.ensureRepo.useMutation();
	const togglePatch = api.patch.toggleEnabled.useMutation();
	const deletePatch = api.patch.delete.useMutation();

	const handleCloseEditor = () => {
		setRepoPath(null);
	};

	if (repoPath) {
		return (
			<PatchEditor
				id={id}
				type={type}
				repoPath={repoPath}
				onClose={handleCloseEditor}
			/>
		);
	}

	const handleOpenEditor = async () => {
		setIsLoadingRepo(true);
		await ensureRepo
			.mutateAsync({ id, type })
			.then((result) => {
				setRepoPath(result);
			})
			.catch((err) => {
				toast.error(err.message || t("patches.toast.repoError"));
			})
			.finally(() => {
				setIsLoadingRepo(false);
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-center justify-between">
				<div>
					<CardTitle>{t("patches.card.title")}</CardTitle>
					<CardDescription>{t("patches.card.description")}</CardDescription>
				</div>
				{patches && patches.length > 0 && (
					<Button onClick={handleOpenEditor} isLoading={isLoadingRepo}>
						<FilePlus2 className="mr-2 h-4 w-4" />
						{t("patches.button.create")}
					</Button>
				)}
			</CardHeader>
			<CardContent>
				{isPatchesLoading ? (
					<div className="flex items-center justify-center py-8">
						<Loader2 className="h-6 w-6 animate-spin" />
					</div>
				) : patches?.length === 0 ? (
					<div className="flex min-h-[40vh] w-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
						<div className="rounded-full bg-muted p-4">
							<FilePlus2 className="h-10 w-10 text-muted-foreground" />
						</div>
						<div className="space-y-1 text-center">
							<p className="text-sm font-medium">{t("patches.empty.title")}</p>
							<p className="max-w-sm text-sm text-muted-foreground">
								{t("patches.empty.description")}
							</p>
						</div>
						<Button onClick={handleOpenEditor} isLoading={isLoadingRepo}>
							<FilePlus2 className="mr-2 h-4 w-4" />
							{t("patches.button.create")}
						</Button>
					</div>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("patches.table.filePath")}</TableHead>
								<TableHead className="w-[80px]">
									{t("patches.table.type")}
								</TableHead>
								<TableHead className="w-[100px]">
									{t("patches.table.enabled")}
								</TableHead>
								<TableHead className="w-[100px]">
									{t("patches.table.actions")}
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{patches?.map((patch: PatchItem) => (
								<TableRow key={patch.patchId}>
									<TableCell className="font-mono text-sm">
										<div className="flex items-center gap-2">
											<File className="h-4 w-4 text-muted-foreground shrink-0" />
											{patch.filePath}
										</div>
									</TableCell>
									<TableCell>
										<Badge
											variant={
												patch.type === "delete"
													? "destructive"
													: patch.type === "create"
														? "default"
														: "secondary"
											}
											className="font-normal"
										>
											{t(`patches.type.${patch.type}`)}
										</Badge>
									</TableCell>
									<TableCell>
										<Switch
											checked={patch.enabled}
											onCheckedChange={(checked) => {
												void togglePatch
													.mutateAsync({
														patchId: patch.patchId,
														enabled: checked,
													})
													.then(async () => {
														toast.success(
															checked
																? t("patches.toast.enabled")
																: t("patches.toast.disabled"),
														);
														await utils.patch.byEntityId.invalidate({
															id,
															type,
														});
													})
													.catch((err) => {
														toast.error(
															err.message || t("patches.toast.updateError"),
														);
													});
											}}
										/>
									</TableCell>
									<TableCell>
										<div className="flex items-center gap-1">
											{(patch.type === "update" ||
												patch.type === "create") && (
												<EditPatchDialog
													patchId={patch.patchId}
													entityId={id}
													type={type}
												/>
											)}
											<Button
												variant="ghost"
												size="icon"
												onClick={() => {
													void deletePatch
														.mutateAsync({ patchId: patch.patchId })
														.then(async () => {
															toast.success(t("patches.toast.deleted"));
															await utils.patch.byEntityId.invalidate({
																id,
																type,
															});
														})
														.catch((err) => {
															toast.error(
																err.message || t("patches.toast.deleteError"),
															);
														});
												}}
												title={t("button.delete")}
											>
												<Trash2 className="h-4 w-4 text-destructive" />
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
};
