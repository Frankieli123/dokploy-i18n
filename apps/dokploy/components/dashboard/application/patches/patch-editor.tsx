import {
	ArrowLeft,
	ChevronRight,
	File,
	Folder,
	Loader2,
	Save,
	Trash2,
} from "lucide-react";
import { useTranslation } from "next-i18next";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/shared/code-editor";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, type RouterOutputs } from "@/utils/api";
import { CreateFileDialog } from "./create-file-dialog";

interface Props {
	id: string;
	type: "application" | "compose";
	repoPath: string;
	onClose: () => void;
}

type DirectoryEntry = {
	name: string;
	path: string;
	type: "file" | "directory";
	children?: DirectoryEntry[];
};

type PatchItem = RouterOutputs["patch"]["byEntityId"][number];

export const PatchEditor = ({ id, type, repoPath, onClose }: Props) => {
	const { t } = useTranslation("common");
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState("");
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		new Set(),
	);

	const utils = api.useUtils();
	const { data: directories, isPending: isDirLoading } =
		api.patch.readRepoDirectories.useQuery(
			{ id, type, repoPath },
			{ enabled: !!repoPath },
		);

	const { data: patches } = api.patch.byEntityId.useQuery(
		{ id, type },
		{ enabled: !!id },
	);

	const { mutateAsync: saveAsPatch, isPending: isSavingPatch } =
		api.patch.saveFileAsPatch.useMutation();
	const { mutateAsync: markForDeletion, isPending: isMarkingDeletion } =
		api.patch.markFileForDeletion.useMutation();
	const updatePatch = api.patch.update.useMutation();

	const { data: fileData, isFetching: isFileLoading } =
		api.patch.readRepoFile.useQuery(
			{
				id,
				type,
				filePath: selectedFile || "",
			},
			{ enabled: !!selectedFile },
		);

	useEffect(() => {
		if (fileData !== undefined) {
			setFileContent(fileData);
		}
	}, [fileData]);

	const existingPatch = patches?.find(
		(p: PatchItem) => p.filePath === selectedFile,
	);
	const selectedDeletePatch =
		existingPatch?.type === "delete" ? existingPatch : undefined;

	const mergedDirectories = useMemo(() => {
		const cloneEntries = (entries: DirectoryEntry[]): DirectoryEntry[] =>
			entries.map((entry) => ({
				...entry,
				children: entry.children ? cloneEntries(entry.children) : undefined,
			}));

		const root = cloneEntries(directories ?? []);
		const index = new Map<string, DirectoryEntry>();

		const visit = (entries: DirectoryEntry[]) => {
			for (const entry of entries) {
				index.set(entry.path, entry);
				if (entry.children) {
					visit(entry.children);
				}
			}
		};

		visit(root);

		for (const currentPatch of patches ?? []) {
			const parts = currentPatch.filePath.split("/").filter(Boolean);
			let currentEntries = root;
			let currentPath = "";

			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				if (!part) continue;
				const isFile = i === parts.length - 1;
				currentPath = currentPath ? `${currentPath}/${part}` : part;

				let existing = index.get(currentPath);
				if (!existing) {
					existing = {
						name: part,
						path: currentPath,
						type: isFile ? "file" : "directory",
						children: isFile ? undefined : [],
					};
					currentEntries.push(existing);
					index.set(currentPath, existing);
				}

				if (!isFile) {
					existing.children ??= [];
					currentEntries = existing.children;
				}
			}
		}

		return root;
	}, [directories, patches]);

	const handleFileSelect = (filePath: string) => {
		setSelectedFile(filePath);
	};

	const toggleFolder = (folderPath: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(folderPath)) {
				next.delete(folderPath);
			} else {
				next.add(folderPath);
			}
			return next;
		});
	};

	const handleSave = () => {
		if (!selectedFile) return;
		void saveAsPatch({
			id,
			type,
			filePath: selectedFile,
			content: fileContent,
			patchType: existingPatch?.type === "create" ? "create" : "update",
		})
			.then(async () => {
				toast.success(t("patches.toast.updated"));
				await utils.patch.byEntityId.invalidate({ id, type });
			})
			.catch(() => {
				toast.error(t("patches.toast.updateError"));
			});
	};

	const handleMarkForDeletion = () => {
		if (!selectedFile) return;
		void markForDeletion({ id, type, filePath: selectedFile })
			.then(async () => {
				toast.success(t("patches.toast.markedForDeletion"));
				await utils.patch.byEntityId.invalidate({ id, type });
			})
			.catch(() => {
				toast.error(t("patches.toast.updateError"));
			});
	};

	const handleCreateFile = useCallback(
		(folderPath: string, filename: string, content: string) => {
			const filePath = folderPath ? `${folderPath}/${filename}` : filename;
			void saveAsPatch({
				id,
				type,
				filePath,
				content,
				patchType: "create",
			})
				.then(async () => {
					setSelectedFile(filePath);
					setFileContent(content);
					toast.success(t("patches.toast.created"));
					await utils.patch.byEntityId.invalidate({ id, type });
				})
				.catch(() => {
					toast.error(t("patches.toast.createError"));
				});
		},
		[id, saveAsPatch, t, type, utils],
	);

	const handleUnmarkDeletion = () => {
		if (!selectedDeletePatch) return;
		void updatePatch
			.mutateAsync({
				patchId: selectedDeletePatch.patchId,
				type: "update",
				content: fileData || "",
			})
			.then(async () => {
				toast.success(t("patches.toast.updated"));
				await utils.patch.byEntityId.invalidate({ id, type });
			})
			.catch(() => {
				toast.error(t("patches.toast.updateError"));
			});
	};

	const hasChanges = fileData !== undefined && fileContent !== fileData;

	const renderTree = useCallback(
		(entries: DirectoryEntry[], depth = 0) =>
			entries
				.sort((a, b) => {
					if (a.type !== b.type) {
						return a.type === "directory" ? -1 : 1;
					}
					return a.name.localeCompare(b.name);
				})
				.map((entry) => {
					const isExpanded = expandedFolders.has(entry.path);
					const isSelected = selectedFile === entry.path;

					if (entry.type === "directory") {
						return (
							<div key={entry.path}>
								<div className="group flex items-center">
									<button
										type="button"
										onClick={() => toggleFolder(entry.path)}
										className="flex-1 flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 rounded-md transition-colors text-left min-w-0"
										style={{ paddingLeft: `${depth * 12 + 8}px` }}
									>
										<ChevronRight
											className={`h-4 w-4 shrink-0 transition-transform ${
												isExpanded ? "rotate-90" : ""
											}`}
										/>
										<Folder className="h-4 w-4 shrink-0 text-blue-500" />
										<span className="truncate">{entry.name}</span>
									</button>
									<CreateFileDialog
										folderPath={entry.path}
										onCreate={(filename, content) =>
											handleCreateFile(entry.path, filename, content)
										}
									/>
								</div>
								{isExpanded && entry.children && (
									<div>{renderTree(entry.children, depth + 1)}</div>
								)}
							</div>
						);
					}

					const isMarkedForDeletion = patches?.some(
						(p: PatchItem) => p.filePath === entry.path && p.type === "delete",
					);

					return (
						<button
							type="button"
							key={entry.path}
							onClick={() => handleFileSelect(entry.path)}
							className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50 rounded-md transition-colors ${
								isSelected ? "bg-muted" : ""
							} ${isMarkedForDeletion ? "text-destructive" : ""}`}
							style={{ paddingLeft: `${depth * 12 + 28}px` }}
						>
							<File className="h-4 w-4 shrink-0 text-muted-foreground" />
							<span className="truncate">{entry.name}</span>
							{isMarkedForDeletion && (
								<Trash2 className="h-3 w-3 shrink-0 text-destructive ml-auto" />
							)}
						</button>
					);
				}),
		[expandedFolders, handleCreateFile, patches, selectedFile],
	);

	return (
		<Card className="bg-background overflow-hidden">
			<CardHeader className="flex flex-row items-center justify-between pb-4">
				<div className="flex items-center gap-4">
					<Button variant="ghost" size="icon" onClick={onClose}>
						<ArrowLeft className="h-4 w-4" />
					</Button>
					<div>
						<CardTitle>{t("patches.editor.title")}</CardTitle>
						<CardDescription>
							{selectedFile
								? t("patches.editor.editing", { filePath: selectedFile })
								: t("patches.editor.selectFile")}
						</CardDescription>
					</div>
				</div>
				{selectedFile && (
					<div className="flex items-center gap-2">
						{selectedDeletePatch ? (
							<Button
								variant="outline"
								size="sm"
								onClick={handleUnmarkDeletion}
								isPending={updatePatch.isPending}
							>
								{t("patches.button.unmarkDelete")}
							</Button>
						) : (
							<>
								<Button
									variant="outline"
									size="sm"
									onClick={handleMarkForDeletion}
									isPending={isMarkingDeletion}
								>
									<Trash2 className="mr-2 h-4 w-4" />
									{t("patches.button.markDelete")}
								</Button>
								<Button
									onClick={handleSave}
									disabled={!hasChanges}
									isPending={isSavingPatch}
								>
									<Save className="mr-2 h-4 w-4" />
									{t("patches.button.savePatch")}
								</Button>
							</>
						)}
					</div>
				)}
			</CardHeader>
			<CardContent className="p-0">
				<div className="grid grid-cols-[250px_1fr] border-t h-[600px]">
					<div className="border-r h-full overflow-hidden">
						<ScrollArea className="h-full">
							<div className="p-2 space-y-1">
								<div className="group flex items-center gap-2 px-2 py-1.5 mb-1">
									<CreateFileDialog
										folderPath=""
										alwaysVisible
										onCreate={(filename, content) =>
											handleCreateFile("", filename, content)
										}
									/>
									<span className="text-xs text-muted-foreground">
										{t("patches.editor.newFileInRoot")}
									</span>
								</div>
								{isDirLoading ? (
									<div className="flex items-center justify-center py-8">
										<Loader2 className="h-6 w-6 animate-spin" />
									</div>
								) : mergedDirectories.length > 0 ? (
									renderTree(mergedDirectories)
								) : (
									<div className="text-sm text-muted-foreground p-4">
										{t("patches.editor.noFiles")}
									</div>
								)}
							</div>
						</ScrollArea>
					</div>
					<div className="h-full overflow-hidden relative">
						{isFileLoading ? (
							<div className="flex items-center justify-center h-full">
								<Loader2 className="h-6 w-6 animate-spin" />
							</div>
						) : selectedFile ? (
							<CodeEditor
								value={fileContent}
								onChange={(value) => setFileContent(value ?? "")}
								className="h-full w-full"
								wrapperClassName="h-full"
								lineWrapping
							/>
						) : (
							<div className="flex items-center justify-center h-full text-muted-foreground">
								{t("patches.editor.selectFile")}
							</div>
						)}
					</div>
				</div>
			</CardContent>
		</Card>
	);
};

