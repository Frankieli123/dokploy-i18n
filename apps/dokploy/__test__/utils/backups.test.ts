import {
	buildS3ObjectPath,
	buildS3RemotePath,
	joinS3Path,
	normalizeS3Path,
} from "@dokploy/server/utils/backups/utils";
import { describe, expect, test } from "vitest";

describe("normalizeS3Path", () => {
	test("should handle empty and whitespace-only prefix", () => {
		expect(normalizeS3Path("")).toBe("");
		expect(normalizeS3Path("/")).toBe("");
		expect(normalizeS3Path("  ")).toBe("");
		expect(normalizeS3Path("\t")).toBe("");
		expect(normalizeS3Path("\n")).toBe("");
		expect(normalizeS3Path(" \n \t ")).toBe("");
	});

	test("should trim whitespace from prefix", () => {
		expect(normalizeS3Path(" prefix")).toBe("prefix/");
		expect(normalizeS3Path("prefix ")).toBe("prefix/");
		expect(normalizeS3Path(" prefix ")).toBe("prefix/");
		expect(normalizeS3Path("\tprefix\t")).toBe("prefix/");
		expect(normalizeS3Path(" prefix/nested ")).toBe("prefix/nested/");
	});

	test("should remove leading slashes", () => {
		expect(normalizeS3Path("/prefix")).toBe("prefix/");
		expect(normalizeS3Path("///prefix")).toBe("prefix/");
	});

	test("should remove trailing slashes", () => {
		expect(normalizeS3Path("prefix/")).toBe("prefix/");
		expect(normalizeS3Path("prefix///")).toBe("prefix/");
	});

	test("should remove both leading and trailing slashes", () => {
		expect(normalizeS3Path("/prefix/")).toBe("prefix/");
		expect(normalizeS3Path("///prefix///")).toBe("prefix/");
	});

	test("should handle nested paths", () => {
		expect(normalizeS3Path("prefix/nested")).toBe("prefix/nested/");
		expect(normalizeS3Path("/prefix/nested/")).toBe("prefix/nested/");
		expect(normalizeS3Path("///prefix/nested///")).toBe("prefix/nested/");
	});

	test("should preserve middle slashes", () => {
		expect(normalizeS3Path("prefix/nested/deep")).toBe("prefix/nested/deep/");
		expect(normalizeS3Path("/prefix/nested/deep/")).toBe("prefix/nested/deep/");
	});

	test("should handle special characters", () => {
		expect(normalizeS3Path("prefix-with-dashes")).toBe("prefix-with-dashes/");
		expect(normalizeS3Path("prefix_with_underscores")).toBe(
			"prefix_with_underscores/",
		);
		expect(normalizeS3Path("prefix.with.dots")).toBe("prefix.with.dots/");
	});

	test("should handle the cases from the bug report", () => {
		expect(normalizeS3Path("instance-backups/")).toBe("instance-backups/");
		expect(normalizeS3Path("/instance-backups/")).toBe("instance-backups/");
		expect(normalizeS3Path("instance-backups")).toBe("instance-backups/");
	});
});

describe("joinS3Path", () => {
	test("should normalize and join segments", () => {
		expect(joinS3Path("app", "prefix/nested")).toBe("app/prefix/nested");
		expect(joinS3Path(" app ", "/prefix/", "file.sql.gz")).toBe(
			"app/prefix/file.sql.gz",
		);
		expect(joinS3Path("", "/", "file.sql.gz")).toBe("file.sql.gz");
	});
});

describe("buildS3RemotePath", () => {
	test("should build remote path with optional segments", () => {
		expect(buildS3RemotePath("bucket")).toBe(":s3:bucket");
		expect(buildS3RemotePath("bucket", "app", "prefix")).toBe(
			":s3:bucket/app/prefix",
		);
	});
});

describe("buildS3ObjectPath", () => {
	test("should build object path with optional segments", () => {
		expect(buildS3ObjectPath("backup.sql.gz", "app", "prefix")).toBe(
			"app/prefix/backup.sql.gz",
		);
		expect(buildS3ObjectPath("backup.sql.gz", "", "/")).toBe("backup.sql.gz");
	});
});
