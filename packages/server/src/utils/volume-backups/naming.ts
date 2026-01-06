import crypto from "node:crypto";

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
