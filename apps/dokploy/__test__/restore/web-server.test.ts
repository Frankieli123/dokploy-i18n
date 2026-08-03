import { mkdtemp } from "node:fs/promises";
import { getS3Credentials } from "@dokploy/server/utils/backups/utils";
import { execAsync } from "@dokploy/server/utils/process/execAsync";
import {
	getDokployDatabaseCreateCommand,
	preparePostgresDatabaseCreation,
} from "@dokploy/server/utils/restore/postgres-database";
import { restoreWebServerBackup } from "@dokploy/server/utils/restore/web-server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
	mkdtemp: vi.fn(),
}));

vi.mock("@dokploy/server/constants", () => ({
	IS_CLOUD: false,
	paths: () => ({ BASE_PATH: "/etc/dokploy" }),
}));

vi.mock("@dokploy/server/utils/backups/utils", () => ({
	getS3Credentials: vi.fn(),
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(),
}));

vi.mock("@dokploy/server/utils/restore/postgres-database", () => ({
	getDokployDatabaseCreateCommand: vi.fn(),
	preparePostgresDatabaseCreation: vi.fn(),
}));

const migrationCommand = "node -r dotenv/config dist/migration.mjs";

const configureCommands = (migrationError?: Error, hasAuthSecret = false) => {
	vi.mocked(execAsync).mockImplementation(async (command) => {
		if (command === migrationCommand && migrationError) throw migrationError;
		if (command.startsWith("ls -la ")) return { stdout: "files", stderr: "" };
		if (command.startsWith("test -d ")) return { stdout: "ok", stderr: "" };
		if (command.includes("filesystem/secrets/better-auth-secret")) {
			return { stdout: hasAuthSecret ? "ok" : "", stderr: "" };
		}
		if (command.includes("database.sql.gz") && command.includes("head -n 1")) {
			return { stdout: "/tmp/dokploy-restore-test/database.sql", stderr: "" };
		}
		if (command.includes("database.sql.gz || true")) {
			return { stdout: "", stderr: "" };
		}
		if (command.includes("database.sql || true")) {
			return { stdout: "/tmp/dokploy-restore-test/database.sql", stderr: "" };
		}
		if (command.startsWith('docker ps --filter "name=dokploy-postgres"')) {
			return { stdout: "postgres-container\n", stderr: "" };
		}
		return { stdout: "", stderr: "" };
	});
};

describe("restoreWebServerBackup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(mkdtemp).mockResolvedValue("/tmp/dokploy-restore-test");
		vi.mocked(getS3Credentials).mockReturnValue([]);
		vi.mocked(preparePostgresDatabaseCreation).mockResolvedValue("default");
		vi.mocked(getDokployDatabaseCreateCommand).mockReturnValue(
			"create database command",
		);
		configureCommands();
	});

	it("runs migrations after restoring an older database", async () => {
		const logs: string[] = [];

		await restoreWebServerBackup(
			{ bucket: "backups" } as never,
			"web-server.dump.zip",
			(log) => logs.push(log),
		);

		const commands = vi
			.mocked(execAsync)
			.mock.calls.map(([command]) => command);
		const restoreIndex = commands.findIndex((command) =>
			command.includes("pg_restore -v -U dokploy -d dokploy"),
		);
		const migrationIndex = commands.indexOf(migrationCommand);

		expect(restoreIndex).toBeGreaterThanOrEqual(0);
		expect(migrationIndex).toBeGreaterThan(restoreIndex);
		expect(logs).toContain("Running database migrations...");
		expect(logs).toContain("Restore completed successfully!");
		expect(logs).toContain(
			"Legacy backup detected, restoring the compatible auth secret...",
		);
		expect(
			commands.some(
				(command) =>
					command.includes("better-auth-secret-123456789") &&
					command.includes("chmod 600"),
			),
		).toBe(true);
	});

	it("does not report success when migrations fail", async () => {
		configureCommands(new Error("migration failed"));
		const logs: string[] = [];
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		try {
			await expect(
				restoreWebServerBackup(
					{ bucket: "backups" } as never,
					"web-server.dump.zip",
					(log) => logs.push(log),
				),
			).rejects.toThrow("migration failed");
		} finally {
			consoleError.mockRestore();
		}

		expect(logs).not.toContain("Restore completed successfully!");
		expect(logs.some((log) => log.includes("migration failed"))).toBe(true);
	});

	it("preserves the auth secret included in newer backups", async () => {
		configureCommands(undefined, true);
		const logs: string[] = [];

		await restoreWebServerBackup(
			{ bucket: "backups" } as never,
			"web-server.dump.zip",
			(log) => logs.push(log),
		);

		expect(logs).not.toContain(
			"Legacy backup detected, restoring the compatible auth secret...",
		);
		expect(
			vi
				.mocked(execAsync)
				.mock.calls.some(([command]) =>
					command.includes("better-auth-secret-123456789"),
				),
		).toBe(false);
	});
});
