import path from "node:path";
import { paths } from "../../constants";

const normalizePosixPath = (value: string) =>
	value.trim().replace(/\\/g, "/").replace(/\/+$/, "");

export const resolveVolumeBackupDockerPath = (
	volumeBackupPath: string,
	serverId?: string | null,
) => {
	if (serverId) return volumeBackupPath;

	const hostEtcPath = process.env.DOKPLOY_HOST_ETC_DIR
		? normalizePosixPath(process.env.DOKPLOY_HOST_ETC_DIR)
		: "";
	if (!hostEtcPath) return volumeBackupPath;

	const containerBasePath = normalizePosixPath(paths(false).BASE_PATH);
	const normalizedBackupPath = normalizePosixPath(volumeBackupPath);
	const relativePath = path.posix.relative(
		containerBasePath,
		normalizedBackupPath,
	);

	if (
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		path.posix.isAbsolute(relativePath)
	) {
		return volumeBackupPath;
	}

	return relativePath
		? path.posix.join(hostEtcPath, relativePath)
		: hostEtcPath;
};
