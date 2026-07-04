#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "node_modules", ".cache", "pi-plan-mode-test");
const tsc = path.join(
	root,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsc.cmd" : "tsc",
);

fs.rmSync(outDir, { recursive: true, force: true });

const testDirectory = path.join(root, "test");
if (!fs.existsSync(testDirectory) || findFiles(testDirectory, ".test.ts").length === 0) {
	console.error("Missing test files.");
	process.exit(1);
}

run(tsc, ["-p", "tsconfig.test.json"]);

const testFiles = findFiles(outDir, ".test.js");
if (testFiles.length === 0) {
	console.error("No compiled test files found.");
	process.exit(1);
}

run(process.execPath, ["--test", ...testFiles]);

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) {
		console.error(result.error.message);
		process.exit(1);
	}
	if (result.status !== 0) process.exit(result.status ?? 1);
}

function findFiles(directory, suffix) {
	if (!fs.existsSync(directory)) return [];
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...findFiles(entryPath, suffix));
		else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath);
	}
	return files.sort();
}
