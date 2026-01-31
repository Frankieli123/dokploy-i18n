import crypto from "node:crypto";

export const ALL_MOUNTS_VOLUME_NAME = "dokploy_all_mounts";

export const normalizeAllMountsVolumeName = (value: string): string => {
	const trimmed = value.trim();
	const lower = trimmed.toLowerCase();

	if (lower === ALL_MOUNTS_VOLUME_NAME) return ALL_MOUNTS_VOLUME_NAME;
	if (
		lower === "all" ||
		lower === "all_mounts" ||
		lower === "all-mounts" ||
		lower === "allmounts" ||
		lower === "all mounts" ||
		trimmed === "*" ||
		trimmed === "全部" ||
		trimmed === "所有" ||
		trimmed === "全量" ||
		trimmed === "全部挂载" ||
		trimmed === "所有挂载"
	) {
		return ALL_MOUNTS_VOLUME_NAME;
	}
	return trimmed;
};

export const isAllMountsVolumeName = (value: string): boolean =>
	normalizeAllMountsVolumeName(value) === ALL_MOUNTS_VOLUME_NAME;

export const isBindPath = (value: string) => {
	return (
		value.startsWith("/") ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		/^[a-zA-Z]:[\\/]/.test(value)
	);
};

export const getBackupBaseName = (source: string) => {
	if (!isBindPath(source)) return source;

	const normalized = source.replace(/\\/g, "/");
	const baseName =
		normalized.split("/").filter(Boolean).pop()?.trim() || "bind";
	const safeBaseName = baseName
		.replace(/[^a-zA-Z0-9_.-]+/g, "_")
		.slice(0, 32);
	const hash = crypto
		.createHash("sha256")
		.update(normalized)
		.digest("hex")
		.slice(0, 12);

	return `bind-${safeBaseName}-${hash}`;
};
