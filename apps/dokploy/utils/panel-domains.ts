export interface ParsedPanelDomainsInput {
	https: boolean;
	hosts: string[];
	domainsDisplay: string;
}

const supportedProtocols = new Set(["http:", "https:"]);

export const parsePanelDomainsInput = (
	input: string,
): ParsedPanelDomainsInput => {
	const entries = input
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);

	if (entries.length === 0) {
		throw new Error("Add at least one domain");
	}

	let protocol: "http:" | "https:" | null = null;
	const hosts: string[] = [];

	for (const entry of entries) {
		let url: URL;

		try {
			url = new URL(entry);
		} catch {
			throw new Error(
				"Use full URLs separated by commas, for example https://panel.example.com,https://admin.example.com",
			);
		}

		if (!supportedProtocols.has(url.protocol)) {
			throw new Error("Only http:// and https:// URLs are supported");
		}

		if (protocol && protocol !== url.protocol) {
			throw new Error("All panel domains must use the same protocol");
		}

		protocol = url.protocol as "http:" | "https:";

		if (url.username || url.password) {
			throw new Error("Domains cannot include credentials");
		}

		if (url.port) {
			throw new Error("Custom ports are not supported for panel domains");
		}

		if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
			throw new Error(
				"Paths, query strings, and hashes are not supported for panel domains",
			);
		}

		const host = url.hostname.trim().toLowerCase();

		if (!host) {
			throw new Error("Domain host is required");
		}

		if (!hosts.includes(host)) {
			hosts.push(host);
		}
	}

	if (!protocol || hosts.length === 0) {
		throw new Error("Add at least one domain");
	}

	return {
		https: protocol === "https:",
		hosts,
		domainsDisplay: hosts
			.map((value) => `${protocol === "https:" ? "https" : "http"}://${value}`)
			.join(","),
	};
};

export const parsePanelDomainsInputSafe = (input: string) => {
	try {
		return parsePanelDomainsInput(input);
	} catch {
		return null;
	}
};

export const parsePanelDomainsInputResult = (input: string) => {
	try {
		return {
			data: parsePanelDomainsInput(input),
			error: null,
		};
	} catch (error) {
		return {
			data: null,
			error:
				error instanceof Error ? error.message : "Invalid panel domain list",
		};
	}
};

export const formatPanelDomainsDisplay = ({
	host,
	additionalHosts,
	https,
}: {
	host?: string | null;
	additionalHosts?: string[] | null;
	https?: boolean | null;
}) => {
	const protocol = https ? "https" : "http";
	const values = [host, ...(additionalHosts ?? [])]
		.map((value) => value?.trim().toLowerCase())
		.filter((value): value is string => !!value);

	return [...new Set(values)]
		.map((value) => `${protocol}://${value}`)
		.join(",");
};
