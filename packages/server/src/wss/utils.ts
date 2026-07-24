import os from "node:os";
import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { publicIpv4, publicIpv6 } from "public-ip";

export const getShell = () => {
	switch (os.platform()) {
		case "win32":
			return "powershell.exe";
		case "darwin":
			return "zsh";
		default:
			return "bash";
	}
};

export const isValidTail = (tail: string): boolean => {
	return (
		/^\d+$/.test(tail) &&
		Number.parseInt(tail, 10) <= 10000 &&
		Number.parseInt(tail, 10) >= 0
	);
};

export const isValidSince = (since: string): boolean => {
	return since === "all" || /^\d+[smhd]$/.test(since);
};

export const isValidSearch = (search: string): boolean => {
	return /^[a-zA-Z0-9 ._-]{0,500}$/.test(search);
};

export const readValidDirectory = (
	directory: string,
	serverId?: string | null,
) => {
	const { BASE_PATH } = paths(!!serverId);

	const resolvedBase = path.resolve(BASE_PATH);
	const resolvedDir = path.resolve(directory);

	return (
		resolvedDir === resolvedBase ||
		resolvedDir.startsWith(resolvedBase + path.sep)
	);
};

export const getPublicIpWithFallback = async () => {
	const options = {
		onlyHttps: true,
		timeout: 1500,
	};
	// @ts-ignore
	let ip = null;
	try {
		ip = await publicIpv4(options);
	} catch (error) {
		console.log(
			"Error obtaining public IPv4 address, falling back to IPv6",
			// @ts-ignore
			error.message,
		);
		try {
			ip = await publicIpv6(options);
		} catch (error) {
			// @ts-ignore
			console.error("Error obtaining public IPv6 address", error.message);
			ip = null;
		}
	}
	return ip;
};
