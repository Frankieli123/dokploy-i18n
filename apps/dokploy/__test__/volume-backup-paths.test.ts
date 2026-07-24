import { backupVolume } from "@dokploy/server/utils/volume-backups/backup";
import { resolveVolumeBackupDockerPath } from "@dokploy/server/utils/volume-backups/host-path";
import { getBackupBaseName } from "@dokploy/server/utils/volume-backups/naming";
import { restoreVolume } from "@dokploy/server/utils/volume-backups/restore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/constants", () => ({
	paths: () => ({
		BASE_PATH: "/etc/dokploy",
		VOLUME_BACKUPS_PATH: "/etc/dokploy/volume-backups",
		VOLUME_BACKUP_LOCK_PATH: "/etc/dokploy/volume-backup-lock",
	}),
}));

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: vi.fn(async () => ({ appName: "demo" })),
}));

vi.mock("@dokploy/server/services/compose", () => ({
	findComposeById: vi.fn(async () => ({
		appName: "frps",
		composeType: "docker-compose",
	})),
}));

vi.mock("@dokploy/server/services/destination", () => ({
	findDestinationById: vi.fn(async () => ({ bucket: "backups" })),
}));

vi.mock("@dokploy/server/utils/backups/utils", () => ({
	buildS3ObjectPath: vi.fn((fileName: string) => fileName),
	getS3Credentials: vi.fn(() => []),
}));

const originalHostEtcDir = process.env.DOKPLOY_HOST_ETC_DIR;

beforeEach(() => {
	process.env.DOKPLOY_HOST_ETC_DIR = "/data/dokploy";
});

afterEach(() => {
	if (originalHostEtcDir === undefined) {
		delete process.env.DOKPLOY_HOST_ETC_DIR;
	} else {
		process.env.DOKPLOY_HOST_ETC_DIR = originalHostEtcDir;
	}
});

describe("volume backup Docker paths", () => {
	it("maps local container backup paths to the Docker host mount", () => {
		expect(
			resolveVolumeBackupDockerPath("/etc/dokploy/volume-backups/bind-frps"),
		).toBe("/data/dokploy/volume-backups/bind-frps");
	});

	it("keeps remote and unrelated paths unchanged", () => {
		expect(
			resolveVolumeBackupDockerPath(
				"/etc/dokploy/volume-backups/bind-frps",
				"remote-server",
			),
		).toBe("/etc/dokploy/volume-backups/bind-frps");
		expect(resolveVolumeBackupDockerPath("/tmp/bind-frps")).toBe(
			"/tmp/bind-frps",
		);

		delete process.env.DOKPLOY_HOST_ETC_DIR;
		expect(
			resolveVolumeBackupDockerPath("/etc/dokploy/volume-backups/bind-frps"),
		).toBe("/etc/dokploy/volume-backups/bind-frps");
	});

	it("uses the host path for backup helper containers", async () => {
		const command = await backupVolume({
			appName: "demo-backup",
			application: { appName: "demo", serverId: null },
			destination: { bucket: "backups" },
			prefix: "",
			serviceType: "application",
			turnOff: false,
			volumeName: "data",
		} as never);

		expect(command).toContain(
			"-v '/data/dokploy/volume-backups/demo-backup':/backup",
		);
		expect(command).toContain('"/etc/dokploy/volume-backups/demo-backup/');
	});

	it("restores bind data through the host path and detects the target on the Docker host", async () => {
		const targetPath = "/var/lib/docker/volumes/frps";
		const backupBaseName = getBackupBaseName(targetPath);
		const command = await restoreVolume(
			"compose-id",
			"destination-id",
			targetPath,
			"frps/archive.tar",
			"",
			"compose",
		);

		expect(command).toContain(
			`-v '/data/dokploy/volume-backups/${backupBaseName}':/backup`,
		);
		expect(command).toContain(
			`"/etc/dokploy/volume-backups/${backupBaseName}/frps/archive.tar"`,
		);
		expect(command).toContain(
			'--mount "type=bind,source=$TARGET_PATH,target=/target,readonly"',
		);
		expect(command).toContain("ubuntu test -d /target");
		expect(command).toContain("ubuntu test -f /target");
		expect(command).toContain("trap cleanup_tmp EXIT");
		expect(command).not.toContain('[ -d "$TARGET_PATH" ]');
	});

	it("does not rewrite remote server backup paths", async () => {
		const targetPath = "/var/lib/docker/volumes/frps";
		const backupBaseName = getBackupBaseName(targetPath);
		const command = await restoreVolume(
			"compose-id",
			"destination-id",
			targetPath,
			"frps/archive.tar",
			"remote-server",
			"compose",
		);

		expect(command).toContain(
			`-v '/etc/dokploy/volume-backups/${backupBaseName}':/backup`,
		);
	});
});
