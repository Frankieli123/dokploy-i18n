import { ExecError } from "@dokploy/server/utils/process/ExecError";
import {
	getDokployDatabaseCreateCommand,
	preparePostgresDatabaseCreation,
} from "@dokploy/server/utils/restore/postgres-database";
import { expect, test, vi } from "vitest";

const success = { stdout: "", stderr: "" };
const mismatch = () =>
	new ExecError("Command execution failed", {
		command: "psql",
		stderr:
			'ERROR: template database "template1" has a collation version mismatch',
		exitCode: 1,
	});

test("creates the restored database with the selected template", () => {
	expect(getDokployDatabaseCreateCommand("postgres-id", "default")).toContain(
		'CREATE DATABASE dokploy;"',
	);
	expect(getDokployDatabaseCreateCommand("postgres-id", "template0")).toContain(
		'CREATE DATABASE dokploy TEMPLATE template0;"',
	);
});

test("uses the default database template when preflight succeeds", async () => {
	const execute = vi.fn().mockResolvedValue(success);

	await expect(
		preparePostgresDatabaseCreation("postgres-id", vi.fn(), execute),
	).resolves.toBe("default");

	expect(execute).toHaveBeenCalledWith(
		expect.stringContaining("CREATE DATABASE dokploy_restore_preflight;"),
	);
});

test("falls back to template0 on a template1 collation mismatch", async () => {
	const execute = vi
		.fn()
		.mockResolvedValueOnce(success)
		.mockRejectedValueOnce(mismatch())
		.mockResolvedValue(success);
	const emit = vi.fn();

	await expect(
		preparePostgresDatabaseCreation("postgres-id", emit, execute),
	).resolves.toBe("template0");

	expect(execute).toHaveBeenCalledWith(
		expect.stringContaining(
			"CREATE DATABASE dokploy_restore_preflight TEMPLATE template0;",
		),
	);
	expect(emit).toHaveBeenCalledWith(
		expect.stringContaining("template0 compatibility mode"),
	);
});

test("refreshes template0 when its collation version also mismatches", async () => {
	const execute = vi
		.fn()
		.mockResolvedValueOnce(success)
		.mockRejectedValueOnce(mismatch())
		.mockRejectedValueOnce(mismatch())
		.mockResolvedValue(success);

	await expect(
		preparePostgresDatabaseCreation("postgres-id", vi.fn(), execute),
	).resolves.toBe("template0");

	expect(execute).toHaveBeenCalledWith(
		expect.stringContaining(
			"ALTER DATABASE template0 REFRESH COLLATION VERSION;",
		),
	);
});

test("does not hide unrelated database creation errors", async () => {
	const error = new ExecError("permission denied", {
		command: "psql",
		stderr: "ERROR: permission denied to create database",
		exitCode: 1,
	});
	const execute = vi
		.fn()
		.mockResolvedValueOnce(success)
		.mockRejectedValueOnce(error);

	await expect(
		preparePostgresDatabaseCreation("postgres-id", vi.fn(), execute),
	).rejects.toBe(error);
});
