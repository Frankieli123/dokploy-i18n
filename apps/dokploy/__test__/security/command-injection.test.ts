import { safeDockerLoginCommand } from "@dokploy/server/services/registry";
import {
	getMariadbBackupCommand,
	getMongoBackupCommand,
	getMysqlBackupCommand,
	getPostgresBackupCommand,
	getS3Credentials,
} from "@dokploy/server/utils/backups/utils";
import { createCommand } from "@dokploy/server/utils/builders/compose";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";
import { buildRemoteDocker } from "@dokploy/server/utils/providers/docker";
import {
	getMariadbRestoreCommand,
	getMongoRestoreCommand,
	getMysqlRestoreCommand,
	getPostgresRestoreCommand,
} from "@dokploy/server/utils/restore/utils";
import { parse } from "shell-quote";
import { describe, expect, it } from "vitest";

const PAYLOAD = "value; touch /tmp/dokploy-pwned";

const leaksPayloadAsShellSyntax = (command: string) =>
	parse(command).some(
		(token) =>
			typeof token !== "string" &&
			JSON.stringify(token).includes("dokploy-pwned"),
	);

describe("shell command escaping", () => {
	it("escapes custom Git URL, branch, and output path", async () => {
		const command = await cloneGitRepository({
			appName: "demo-app",
			customGitUrl: "https://example.com/repo.git; touch /tmp/dokploy-pwned",
			customGitBranch: PAYLOAD,
			customGitSSHKeyId: null,
			enableSubmodules: false,
			serverId: null,
			outputPathOverride: "/tmp/demo; touch /tmp/dokploy-pwned",
		});

		expect(leaksPayloadAsShellSyntax(command)).toBe(false);
		expect(command).toContain("git clone");
	});

	it("escapes Docker image and registry credentials", async () => {
		const command = await buildRemoteDocker({
			dockerImage: PAYLOAD,
			registryUrl: "registry.example.com; touch /tmp/dokploy-pwned",
			username: PAYLOAD,
			password: PAYLOAD,
		} as unknown as Parameters<typeof buildRemoteDocker>[0]);

		expect(leaksPayloadAsShellSyntax(command)).toBe(false);
		expect(
			leaksPayloadAsShellSyntax(
				safeDockerLoginCommand(PAYLOAD, PAYLOAD, PAYLOAD),
			),
		).toBe(false);
	});

	it("rejects shell control characters in custom Compose commands", () => {
		const compose = {
			command: "compose up -d; touch /tmp/dokploy-pwned",
		} as unknown as Parameters<typeof createCommand>[0];

		expect(() => createCommand(compose)).toThrow(
			"shell control characters are not allowed",
		);
	});

	it("escapes database backup and restore credentials", () => {
		const commands = [
			getPostgresBackupCommand(PAYLOAD, PAYLOAD),
			getMariadbBackupCommand(PAYLOAD, PAYLOAD, PAYLOAD),
			getMysqlBackupCommand(PAYLOAD, PAYLOAD),
			getMongoBackupCommand(PAYLOAD, PAYLOAD, PAYLOAD),
			getPostgresRestoreCommand(PAYLOAD, PAYLOAD),
			getMariadbRestoreCommand(PAYLOAD, PAYLOAD, PAYLOAD),
			getMysqlRestoreCommand(PAYLOAD, PAYLOAD),
			getMongoRestoreCommand(PAYLOAD, PAYLOAD, PAYLOAD),
		];

		for (const command of commands) {
			expect(leaksPayloadAsShellSyntax(command)).toBe(false);
		}
	});

	it("preserves Mongo all-databases backup and restore behavior", () => {
		expect(getMongoBackupCommand("*", "user", "password")).not.toContain(
			"-d \"$DB_NAME\"",
		);
		expect(getMongoRestoreCommand("*", "user", "password")).not.toContain(
			"--db \"$DB_NAME\"",
		);
	});

	it("escapes S3 credential flags", () => {
		const flags = getS3Credentials({
			accessKey: PAYLOAD,
			secretAccessKey: PAYLOAD,
			region: PAYLOAD,
			endpoint: PAYLOAD,
			provider: PAYLOAD,
		} as Parameters<typeof getS3Credentials>[0]);

		for (const flag of flags) {
			expect(leaksPayloadAsShellSyntax(flag)).toBe(false);
		}
	});
});
