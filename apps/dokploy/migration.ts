import { migration } from "./server/db/migration.ts";

try {
	await migration();
} catch {
	process.exitCode = 1;
}
