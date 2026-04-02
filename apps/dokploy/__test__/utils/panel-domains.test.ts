import {
	buildPanelTraefikHostRule,
	buildPanelTrustedOrigins,
	parsePanelDomainsInput,
} from "@dokploy/server/utils/panel-domains";
import { describe, expect, it } from "vitest";

describe("panel domain parsing", () => {
	it("parses a single https domain", () => {
		const parsed = parsePanelDomainsInput("https://panel.example.com");

		expect(parsed.https).toBe(true);
		expect(parsed.primaryHost).toBe("panel.example.com");
		expect(parsed.additionalHosts).toEqual([]);
		expect(parsed.domainsDisplay).toBe("https://panel.example.com");
	});

	it("parses multiple domains, trims spaces, and deduplicates", () => {
		const parsed = parsePanelDomainsInput(
			" https://panel.example.com , https://admin.example.com, https://panel.example.com/ ",
		);

		expect(parsed.hosts).toEqual([
			"panel.example.com",
			"admin.example.com",
		]);
		expect(parsed.additionalHosts).toEqual(["admin.example.com"]);
		expect(parsed.domainsDisplay).toBe(
			"https://panel.example.com,https://admin.example.com",
		);
	});

	it("rejects missing schemes", () => {
		expect(() =>
			parsePanelDomainsInput("panel.example.com,admin.example.com"),
		).toThrow(/full URLs/i);
	});

	it("rejects ports", () => {
		expect(() =>
			parsePanelDomainsInput("https://panel.example.com:8443"),
		).toThrow(/ports are not supported/i);
	});

	it("rejects paths", () => {
		expect(() => parsePanelDomainsInput("https://panel.example.com/app")).toThrow(
			/paths, query strings, and hashes are not supported/i,
		);
	});

	it("rejects mixed protocols", () => {
		expect(() =>
			parsePanelDomainsInput(
				"https://panel.example.com,http://admin.example.com",
			),
		).toThrow(/same protocol/i);
	});
});

describe("panel domain helpers", () => {
	it("builds explicit OR rules for Traefik", () => {
		expect(
			buildPanelTraefikHostRule(["panel.example.com", "admin.example.com"]),
		).toBe("Host(`panel.example.com`) || Host(`admin.example.com`)");
	});

	it("builds trusted origins for all allowed panel hosts", () => {
		expect(
			buildPanelTrustedOrigins({
				serverIp: "1.2.3.4",
				host: "panel.example.com",
				additionalHosts: ["admin.example.com"],
				https: true,
			}),
		).toEqual([
			"http://1.2.3.4:3000",
			"https://panel.example.com",
			"https://admin.example.com",
		]);
	});
});
