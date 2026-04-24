import { migration } from "./server/db/migration.ts";

try {
	await migration();
	process.exit(0);
} catch {
	process.exit(1);
}
