export interface PanelDomainRecord {
	host?: string | null;
	additionalHosts?: string[] | null;
	https?: boolean | null;
	serverIp?: string | null;
}

export interface ParsedPanelDomains {
	protocol: "http:" | "https:";
	https: boolean;
	hosts: string[];
	primaryHost: string;
	additionalHosts: string[];
	domainsDisplay: string;
}

const supportedProtocols = new Set(["http:", "https:"]);

export const getPanelHosts = ({
	host,
	additionalHosts,
}: Pick<PanelDomainRecord, "host" | "additionalHosts">) => {
	const values = [host, ...(additionalHosts ?? [])]
		.map((value) => value?.trim().toLowerCase())
		.filter((value): value is string => !!value);

	return [...new Set(values)];
};

export const formatPanelDomainsDisplay = ({
	host,
	additionalHosts,
	https,
}: Pick<PanelDomainRecord, "host" | "additionalHosts" | "https">) => {
	const protocol = https ? "https" : "http";
	const hosts = getPanelHosts({ host, additionalHosts });

	return hosts.map((value) => `${protocol}://${value}`).join(",");
};

export const parsePanelDomainsInput = (input: string): ParsedPanelDomains => {
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
		protocol,
		https: protocol === "https:",
		hosts,
		primaryHost: hosts[0]!,
		additionalHosts: hosts.slice(1),
		domainsDisplay: hosts
			.map((value) => `${protocol === "https:" ? "https" : "http"}://${value}`)
			.join(","),
	};
};

export const buildPanelTraefikHostRule = (hosts: string[]) => {
	const values = [...new Set(hosts.map((value) => value.trim()).filter(Boolean))];

	if (values.length === 0) {
		throw new Error("At least one host is required");
	}

	return values.map((value) => `Host(\`${value}\`)`).join(" || ");
};

export const buildPanelTrustedOrigins = ({
	serverIp,
	host,
	additionalHosts,
	https,
}: PanelDomainRecord) => {
	const origins = new Set<string>();

	if (serverIp) {
		origins.add(`http://${serverIp}:3000`);
	}

	const protocol = https ? "https" : "http";
	for (const value of getPanelHosts({ host, additionalHosts })) {
		origins.add(`${protocol}://${value}`);
	}

	return [...origins];
};
