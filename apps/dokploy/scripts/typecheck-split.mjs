import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const appRoot = resolve(scriptDir, "..");
const tscBin = resolve(appRoot, "node_modules/typescript/bin/tsc");
const tmpDir = resolve(
	appRoot,
	".tmp/typecheck-split",
	`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);
const baseConfigPath = resolve(appRoot, "tsconfig.ui.json");
const roots = [
	"components/dashboard",
	"components/layouts",
	"components/ui",
	"hooks",
	"lib",
	"types",
	"utils",
];
const ignore = new Set(["node_modules", ".next", ".tmp", "dist"]);
const filePattern = /\.(ts|tsx)$/;
const testPattern = /\.test\.tsx?$/;
const maxFilesPerChunk = 6;
const sharedIncludes = ["types/**/*.ts", "types/**/*.tsx", "types/**/*.d.ts"];

function isTsFile(name) {
	return filePattern.test(name) && !testPattern.test(name);
}

function countFiles(dir) {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (ignore.has(entry.name)) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			count += countFiles(full);
			continue;
		}
		if (isTsFile(entry.name)) count += 1;
	}
	return count;
}

function chunkFromDir(absDir, chunks) {
	const total = countFiles(absDir);
	if (total === 0) return;

	const relDir = relative(appRoot, absDir).replaceAll("\\", "/");
	if (total <= maxFilesPerChunk) {
		chunks.push({
			name: relDir.replace(/[\\/[\]]+/g, "-"),
			include: [`${relDir}/**/*.ts`, `${relDir}/**/*.tsx`],
		});
		return;
	}

	for (const entry of readdirSync(absDir, { withFileTypes: true })) {
		if (ignore.has(entry.name)) continue;
		const full = join(absDir, entry.name);
		const rel = relative(appRoot, full).replaceAll("\\", "/");
		if (entry.isDirectory()) {
			chunkFromDir(full, chunks);
			continue;
		}
		if (isTsFile(entry.name)) {
			chunks.push({
				name: rel.replace(/[\\/.[\]]+/g, "-"),
				include: [rel],
			});
		}
	}
}

function buildChunks() {
	const chunks = [];
	for (const root of roots) {
		const abs = resolve(appRoot, root);
		if (!statExists(abs)) continue;
		const stats = statSync(abs);
		if (stats.isDirectory()) {
			chunkFromDir(abs, chunks);
		} else if (stats.isFile()) {
			const rel = relative(appRoot, abs).replaceAll("\\", "/");
			chunks.push({
				name: rel.replace(/[\\/.[\]]+/g, "-"),
				include: [rel],
			});
		}
	}
	return chunks;
}

function statExists(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function writeChunkConfig(chunk) {
	const file = join(tmpDir, `${chunk.name}.json`);
	const relBase = relative(tmpDir, baseConfigPath).replaceAll("\\", "/");
	const relInclude = ["next-env.d.ts", ...chunk.include].map((entry) =>
		relative(tmpDir, resolve(appRoot, entry)).replaceAll("\\", "/"),
	);
	writeFileSync(
		file,
		JSON.stringify(
			{
				extends: relBase,
				include: [
					...relInclude,
					...sharedIncludes.map((entry) =>
						relative(tmpDir, resolve(appRoot, entry)).replaceAll("\\", "/"),
					),
				],
			},
			null,
			2,
		),
	);
	return file;
}

function runChunk(configPath) {
	const result = spawnSync(
		process.execPath,
		["--max-old-space-size=3072", tscBin, "--noEmit", "-p", configPath],
		{
			cwd: appRoot,
			stdio: "pipe",
			encoding: "utf8",
		},
	);
	return result;
}

function main() {
	mkdirSync(tmpDir, { recursive: true });

	let chunks = buildChunks();
	const filter = process.env.TYPECHECK_SPLIT_FILTER;
	if (filter) {
		const matcher = new RegExp(filter, "i");
		chunks = chunks.filter((chunk) => matcher.test(chunk.name));
	}
	const limit = Number(process.env.TYPECHECK_SPLIT_LIMIT ?? "");
	if (Number.isFinite(limit) && limit > 0) {
		chunks = chunks.slice(0, limit);
	}
	if (chunks.length === 0) {
		console.log("No split typecheck chunks found.");
		return;
	}

	const failures = [];
	for (const chunk of chunks) {
		const configPath = writeChunkConfig(chunk);
		process.stdout.write(`typecheck ${chunk.name}\n`);
		const result = runChunk(configPath);
		if (result.status !== 0) {
			failures.push({
				name: chunk.name,
				output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
			});
		}
	}

	if (failures.length > 0) {
		for (const failure of failures) {
			console.error(`\n[${failure.name}]`);
			console.error(failure.output);
		}
		process.exit(1);
	}

	console.log(`Split typecheck passed (${chunks.length} chunks).`);
}

main();
