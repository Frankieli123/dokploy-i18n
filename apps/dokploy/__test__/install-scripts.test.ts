import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scriptNames = [
	"install.sh",
	"install-china.sh",
	"install-data.sh",
	"install-data-china.sh",
];
const scripts = scriptNames.map((name) => ({
	name,
	content: readFileSync(`${repositoryRoot}${name}`, "utf8"),
}));

describe("installation scripts", () => {
	it("keeps the Traefik recovery function aligned", () => {
		const functions = scripts.map(
			({ content }) =>
				content.match(/ {4}ensure_traefik\(\) \{[\s\S]*?\n {4}\}/)?.[0],
		);

		expect(functions.every(Boolean)).toBe(true);
		expect(new Set(functions).size).toBe(1);
	});

	it.each(scripts)("validates Traefik startup in $name", ({ content }) => {
		expect(content).not.toMatch(/sleep 4/);
		expect(content).not.toMatch(/touch .*traefik\.yml/);
		expect(content).toContain("TRAEFIK_INSTALL_TIMEOUT");
		expect(content).toContain("DOKPLOY_HOST_ETC_DIR");
		expect(content).toContain("Traefik is not publishing ports 80 and 443");
	});

	it.each(scripts)("keeps release metadata current in $name", ({ content }) => {
		expect(content).toContain("--env-rm RELEASE_TAG");
		expect(content).toContain('--env-add "RELEASE_TAG=$VERSION_TAG"');
	});
});
