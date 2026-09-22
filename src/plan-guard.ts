import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runtime write guard for plan mode.
 *
 * The static command judge in plan-mode.ts decides what plan mode *allows*. That
 * decision is a prediction about a shell command's side effects, and a prediction that
 * is wrong once is a write that already happened. This module is the second layer:
 * snapshot the working tree before a guarded shell call, compare afterwards, and undo
 * whatever changed. A missed judgement then degrades from "plan mode wrote into your
 * repository" to "the call was reported as an error and its writes were rolled back".
 *
 * Concurrency: pi preflights every sibling tool call of one assistant message before it
 * executes any of them (pi-agent-core agent-loop.js `executeToolCallsParallel`), so the
 * guard must not hold anything across the preflight phase — a lock taken here would
 * deadlock the batch. Snapshots are therefore independent per call, and only the
 * "compare and restore" step is serialized. Two concurrent violating calls can each see
 * the other's writes in their change set; both are violations, both rollbacks restore a
 * pre-call state, and the work tree converges to the state it had before the batch.
 */
export type GuardMode = "off" | "detect" | "full";

export type GuardChangeKind = "created" | "modified" | "deleted";

export interface GuardChange {
	/** Absolute path. */
	path: string;
	kind: GuardChangeKind;
	/** False when the snapshot did not keep enough to put the path back. */
	restorable: boolean;
}

export interface GuardSettlement {
	mode: Exclude<GuardMode, "off">;
	changes: GuardChange[];
	/** Paths the guard put back (absolute). */
	restored: string[];
	/** Paths that changed but could not be restored (absolute). */
	unrestorable: string[];
	/** Why a snapshot or restore was degraded; empty when the guard ran at full strength. */
	notes: string[];
}

export interface GuardHandle {
	/** Diff against the snapshot and, in "full" mode, restore the captured state. Never throws. */
	settle(): Promise<GuardSettlement>;
}

export interface PlanGuard {
	/** Snapshot the working tree for one shell call. Never throws. */
	begin(): Promise<GuardHandle>;
	/** Drop temporary state (temp index files, fallback snapshot memory). */
	dispose(): void;
}

/** Optional seams used by tests to observe the serialized section. */
export interface PlanGuardOptions {
	/** Awaited at the start of every settle, inside the settle lock. */
	duringSettle?: () => Promise<void> | void;
}

const CONTENT_FILE_LIMIT = 1024 * 1024;
const CONTENT_TOTAL_LIMIT = 32 * 1024 * 1024;
const ENTRY_LIMIT = 20000;
const RESTORE_BATCH_SIZE = 500;
const GIT_TIMEOUT_MS = 20000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";

/**
 * Directories the fallback snapshot does not descend into. They are either VCS
 * bookkeeping or dependency/build caches whose file count would blow the budget, and a
 * plan-mode command has no reason to legitimately write inside them.
 */
const SKIP_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	"target",
]);

/**
 * `PI_PLAN_GUARD`: `off` disables the guard, `detect` reports without restoring, `full`
 * (default) reports and restores. Anything unrecognized — including a typo — keeps the
 * guard at `full`: this layer exists to catch judge misses, so a broken setting must not
 * be able to silently switch it off.
 */
export function resolveGuardMode(value: string | undefined): GuardMode {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "off") return "off";
	if (normalized === "detect") return "detect";
	return "full";
}

type CommandResult = { code: number; stdout: string; stderr: string; spawnFailed: boolean };

function runCommand(
	file: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
	return new Promise((resolve) => {
		execFile(
			file,
			args,
			{
				cwd: options.cwd,
				env: options.env ?? process.env,
				timeout: GIT_TIMEOUT_MS,
				maxBuffer: GIT_MAX_BUFFER,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
					resolve({ code: -1, stdout: "", stderr: String(stderr), spawnFailed: true });
					return;
				}
				const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
				resolve({ code, stdout, stderr, spawnFailed: false });
			},
		);
	});
}

function emptySettlement(mode: GuardMode, notes: string[] = []): GuardSettlement {
	return {
		mode: mode === "off" ? "detect" : mode,
		changes: [],
		restored: [],
		unrestorable: [],
		notes,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pruneEmptyParents(root: string, target: string): void {
	let current = path.dirname(target);
	while (current.startsWith(root) && current !== root) {
		try {
			if (fs.readdirSync(current).length > 0) return;
			fs.rmdirSync(current);
		} catch {
			return;
		}
		current = path.dirname(current);
	}
}

function writeFileAtomic(target: string, content: Buffer, mode: number | undefined): void {
	const temporary = `${target}.pi-plan-guard-${process.pid}-${Math.random().toString(36).slice(2)}`;
	fs.writeFileSync(temporary, content);
	if (mode !== undefined) fs.chmodSync(temporary, mode & 0o777);
	fs.renameSync(temporary, target);
}

interface FileEntry {
	kind: "file" | "directory" | "symlink";
	size: number;
	mtimeMs: number;
	mode: number;
	hash?: string;
	content?: Buffer;
	target?: string;
}

interface FileSnapshot {
	entries: Map<string, FileEntry>;
	notes: string[];
}

function captureFileSnapshot(root: string): FileSnapshot {
	const entries = new Map<string, FileEntry>();
	const notes: string[] = [];
	let contentBytes = 0;
	const stack = [root];
	let truncated = false;
	while (stack.length > 0) {
		const directory = stack.pop();
		if (directory === undefined) break;
		let children: fs.Dirent[];
		try {
			children = fs.readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			notes.push(`Could not read ${directory}: ${errorMessage(error)}`);
			continue;
		}
		for (const child of children) {
			const absolute = path.join(directory, child.name);
			if (entries.size >= ENTRY_LIMIT) {
				truncated = true;
				break;
			}
			if (child.isDirectory()) {
				if (SKIP_DIRECTORIES.has(child.name)) continue;
				entries.set(absolute, {
					kind: "directory",
					size: 0,
					mtimeMs: 0,
					mode: 0,
				});
				stack.push(absolute);
				continue;
			}
			if (child.isSymbolicLink()) {
				try {
					const target = fs.readlinkSync(absolute);
					const stat = fs.lstatSync(absolute);
					entries.set(absolute, {
						kind: "symlink",
						size: target.length,
						mtimeMs: stat.mtimeMs,
						mode: stat.mode,
						target,
					});
				} catch (error) {
					notes.push(`Could not read symlink ${absolute}: ${errorMessage(error)}`);
				}
				continue;
			}
			if (!child.isFile()) continue;
			try {
				const stat = fs.statSync(absolute);
				const entry: FileEntry = {
					kind: "file",
					size: stat.size,
					mtimeMs: stat.mtimeMs,
					mode: stat.mode,
				};
				if (stat.size <= CONTENT_FILE_LIMIT && contentBytes + stat.size <= CONTENT_TOTAL_LIMIT) {
					const content = fs.readFileSync(absolute);
					entry.content = content;
					entry.hash = crypto.createHash("sha256").update(content).digest("hex");
					contentBytes += content.length;
				}
				entries.set(absolute, entry);
			} catch (error) {
				notes.push(`Could not read ${absolute}: ${errorMessage(error)}`);
			}
		}
		if (truncated) break;
	}
	if (truncated) {
		notes.push(
			`Only the first ${ENTRY_LIMIT} entries were snapshotted; the rest of the tree is unprotected.`,
		);
	}
	return { entries, notes };
}

function fileEntryChanged(before: FileEntry, after: FileEntry): boolean {
	if (before.kind !== after.kind) return true;
	if (before.kind === "symlink") return before.target !== after.target;
	if (before.kind === "directory") return false;
	if (before.hash !== undefined && after.hash !== undefined) return before.hash !== after.hash;
	return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function restoreFilePaths(
	mode: Exclude<GuardMode, "off">,
	root: string,
	before: FileSnapshot,
	after: FileSnapshot,
	changes: GuardChange[],
): { restored: string[]; unrestorable: string[] } {
	const restored: string[] = [];
	const unrestorable: string[] = [];
	if (mode !== "full") {
		for (const change of changes) if (!change.restorable) unrestorable.push(change.path);
		return { restored, unrestorable };
	}
	for (const change of changes) {
		const absolute = change.path;
		const previous = before.entries.get(absolute);
		const current = after.entries.get(absolute);
		try {
			if (previous === undefined || change.kind === "created") {
				// A path that did not exist before the call: remove whatever the command
				// created there, including a directory tree that replaced nothing.
				fs.rmSync(absolute, { recursive: true, force: true });
				pruneEmptyParents(root, absolute);
				restored.push(absolute);
				continue;
			}
			if (previous.kind === "directory") {
				if (current === undefined || current.kind !== "directory") {
					fs.mkdirSync(absolute, { recursive: true });
					restored.push(absolute);
				} else restored.push(absolute);
				continue;
			}
			if (previous.kind === "symlink") {
				if (previous.target === undefined) {
					unrestorable.push(absolute);
					continue;
				}
				fs.mkdirSync(path.dirname(absolute), { recursive: true });
				fs.rmSync(absolute, { recursive: true, force: true });
				fs.symlinkSync(previous.target, absolute);
				restored.push(absolute);
				continue;
			}
			if (previous.content === undefined) {
				unrestorable.push(absolute);
				continue;
			}
			if (current !== undefined && current.kind === "directory") {
				fs.rmSync(absolute, { recursive: true, force: true });
			}
			fs.mkdirSync(path.dirname(absolute), { recursive: true });
			writeFileAtomic(absolute, previous.content, previous.mode);
			restored.push(absolute);
		} catch (error) {
			unrestorable.push(absolute);
			before.notes.push(`Could not restore ${absolute}: ${errorMessage(error)}`);
		}
	}
	return { restored, unrestorable };
}

type GitTreeEntry = { mode: string };

async function gitRun(
	root: string,
	args: string[],
	extraEnv: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
	return runCommand("git", ["-C", root, ...args], {
		cwd: root,
		env: { ...process.env, ...extraEnv },
	});
}

async function gitToplevel(cwd: string): Promise<string | undefined> {
	const result = await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
	if (result.code !== 0) return undefined;
	const trimmed = result.stdout.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

async function gitCapture(
	root: string,
	indexFile: string,
	seed?: string,
): Promise<string | undefined> {
	if (seed !== undefined) {
		// Seed from an existing index so `git add` can reuse its stat cache and only hash
		// files that actually changed. Without a seed every file in the repository is
		// re-hashed on every guarded call.
		try {
			if (fs.existsSync(seed)) fs.copyFileSync(seed, indexFile);
		} catch {
			// A missing or unreadable seed only costs time, not correctness.
		}
	}
	const env = { GIT_INDEX_FILE: indexFile };
	const added = await gitRun(root, ["add", "-A", "--", "."], env);
	if (added.code !== 0) return undefined;
	const written = await gitRun(root, ["write-tree"], env);
	if (written.code !== 0) return undefined;
	const tree = written.stdout.trim();
	return tree.length > 0 ? tree : undefined;
}

async function gitUserIndexPath(root: string): Promise<string | undefined> {
	const result = await gitRun(root, ["rev-parse", "--git-path", "index"]);
	if (result.code !== 0) return undefined;
	const value = result.stdout.trim();
	if (value.length === 0) return undefined;
	return path.isAbsolute(value) ? value : path.resolve(root, value);
}

async function gitChangedPaths(
	root: string,
	beforeTree: string,
	afterTree: string,
): Promise<{ path: string; kind: GuardChangeKind }[] | undefined> {
	const result = await gitRun(root, [
		"diff-tree",
		"-r",
		"-z",
		"--no-renames",
		"--name-status",
		beforeTree,
		afterTree,
	]);
	if (result.code !== 0) return undefined;
	const fields = result.stdout.split("\0");
	const changes: { path: string; kind: GuardChangeKind }[] = [];
	for (let index = 0; index + 1 < fields.length; index += 2) {
		const status = fields[index];
		const file = fields[index + 1];
		if (status === undefined || file === undefined || file.length === 0) continue;
		const kind: GuardChangeKind = status.startsWith("A")
			? "created"
			: status.startsWith("D")
				? "deleted"
				: "modified";
		changes.push({ path: file, kind });
	}
	return changes;
}

async function gitTreeEntries(
	root: string,
	tree: string,
): Promise<Map<string, GitTreeEntry> | undefined> {
	const result = await gitRun(root, ["ls-tree", "-r", "-z", tree]);
	if (result.code !== 0) return undefined;
	const entries = new Map<string, GitTreeEntry>();
	for (const record of result.stdout.split("\0")) {
		if (record.length === 0) continue;
		const separator = record.indexOf("\t");
		if (separator === -1) continue;
		const header = record.slice(0, separator).split(" ");
		const mode = header[0];
		const type = header[1];
		const file = record.slice(separator + 1);
		if (mode === undefined || type === undefined || file.length === 0) continue;
		// Submodule entries are recorded as commits: the guard can see that they moved but
		// cannot put a submodule work tree back, so they are reported as unrestorable.
		if (type !== "blob" && type !== "commit") continue;
		entries.set(file, { mode });
	}
	return entries;
}

export function createPlanGuard(cwd: string, options: PlanGuardOptions = {}): PlanGuard {
	let temporaryDirectory: string | undefined;
	let settleChain: Promise<unknown> = Promise.resolve();
	let sequence = 0;

	function tempDirectory(): string {
		if (temporaryDirectory === undefined) {
			temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-guard-"));
		}
		return temporaryDirectory;
	}

	// The settle lock is what keeps two rollbacks from interleaving. It is held only
	// inside settle(), never across a tool call's execution: pi awaits every sibling
	// preflight before executing any sibling, so a lock held there would deadlock.
	function withSettleLock<T>(work: () => Promise<T>): Promise<T> {
		const run = settleChain.then(work, work);
		settleChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async function gitRestore(
		root: string,
		beforeTree: string,
		beforeEntries: Map<string, GitTreeEntry>,
		changes: GuardChange[],
	): Promise<{ restored: string[]; unrestorable: string[] }> {
		const restored: string[] = [];
		const unrestorable: string[] = [];
		const indexFile = path.join(tempDirectory(), `restore-${sequence++}.index`);
		const env = { GIT_INDEX_FILE: indexFile };
		const reload = await gitRun(root, ["read-tree", beforeTree], env);
		if (reload.code !== 0) {
			for (const change of changes) unrestorable.push(change.path);
			return { restored, unrestorable };
		}
		const toCheckout: string[] = [];
		for (const change of changes) {
			const absolute = path.resolve(root, change.path);
			const previous = beforeEntries.get(change.path);
			if (previous === undefined) {
				try {
					fs.rmSync(absolute, { recursive: true, force: true });
					pruneEmptyParents(root, absolute);
					restored.push(absolute);
				} catch {
					unrestorable.push(absolute);
				}
				continue;
			}
			if (previous.mode === GITLINK_MODE) {
				unrestorable.push(absolute);
				continue;
			}
			if (previous.mode !== SYMLINK_MODE) {
				try {
					// A directory tree where a file used to be blocks `checkout-index`.
					if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
						fs.rmSync(absolute, { recursive: true, force: true });
					}
					fs.mkdirSync(path.dirname(absolute), { recursive: true });
				} catch {
					// checkout-index reports the final failure below.
				}
			}
			toCheckout.push(change.path);
		}
		for (let index = 0; index < toCheckout.length; index += RESTORE_BATCH_SIZE) {
			const batch = toCheckout.slice(index, index + RESTORE_BATCH_SIZE);
			const checkedOut = await gitRun(root, ["checkout-index", "-f", "--", ...batch], env);
			for (const file of batch) {
				const absolute = path.resolve(root, file);
				if (checkedOut.code === 0 && fs.existsSync(absolute)) restored.push(absolute);
				else unrestorable.push(absolute);
			}
		}
		try {
			fs.rmSync(indexFile, { force: true });
		} catch {
			// Temporary index files are also removed by dispose().
		}
		return { restored, unrestorable };
	}

	return {
		async begin(): Promise<GuardHandle> {
			const mode = resolveGuardMode(process.env.PI_PLAN_GUARD);
			if (mode === "off") {
				return { settle: async () => emptySettlement("detect") };
			}
			const root = await gitToplevel(cwd);
			if (root === undefined) {
				let snapshot: FileSnapshot;
				try {
					snapshot = captureFileSnapshot(cwd);
				} catch (error) {
					return {
						settle: async () =>
							emptySettlement(mode, [`Could not snapshot ${cwd}: ${errorMessage(error)}`]),
					};
				}
				return {
					settle: async () =>
						withSettleLock(async () => {
							await options.duringSettle?.();
							let after: FileSnapshot;
							try {
								after = captureFileSnapshot(cwd);
							} catch (error) {
								return emptySettlement(mode, [
									`Could not re-read ${cwd} after the call: ${errorMessage(error)}`,
								]);
							}
							const changes: GuardChange[] = [];
							for (const [absolute, entry] of after.entries) {
								const previous = snapshot.entries.get(absolute);
								if (previous === undefined) {
									changes.push({
										path: absolute,
										kind: "created",
										restorable: entry.kind !== "directory",
									});
								} else if (fileEntryChanged(previous, entry)) {
									changes.push({
										path: absolute,
										kind: "modified",
										restorable: previous.kind !== "file" || previous.content !== undefined,
									});
								}
							}
							for (const [absolute, entry] of snapshot.entries) {
								if (after.entries.has(absolute)) continue;
								changes.push({
									path: absolute,
									kind: "deleted",
									restorable: entry.kind !== "file" || entry.content !== undefined,
								});
							}
							const notes = [...snapshot.notes];
							const { restored, unrestorable } = restoreFilePaths(
								mode,
								cwd,
								snapshot,
								after,
								changes,
							);
							notes.push(...snapshot.notes.filter((note) => !notes.includes(note)));
							return { mode, changes, restored, unrestorable, notes };
						}),
				};
			}
			const indexFile = path.join(tempDirectory(), `pre-${sequence++}.index`);
			const seed = await gitUserIndexPath(root);
			const beforeTree = await gitCapture(root, indexFile, seed);
			if (beforeTree === undefined) {
				return {
					settle: async () =>
						emptySettlement(mode, [
							`Could not snapshot the git work tree at ${root}; this call was not guarded.`,
						]),
				};
			}
			return {
				settle: async () =>
					withSettleLock(async () => {
						await options.duringSettle?.();
						const postIndex = path.join(tempDirectory(), `post-${sequence++}.index`);
						const afterTree = await gitCapture(root, postIndex, indexFile);
						if (afterTree === undefined) {
							return emptySettlement(mode, [
								`Could not re-read the git work tree at ${root}; this call was not checked.`,
							]);
						}
						const changed = await gitChangedPaths(root, beforeTree, afterTree);
						if (changed === undefined) {
							return emptySettlement(mode, [
								`Could not diff the git work tree at ${root}; this call was not checked.`,
							]);
						}
						const beforeEntries = await gitTreeEntries(root, beforeTree);
						const changes: GuardChange[] = changed.map((change) => ({
							path: change.path,
							kind: change.kind,
							restorable: beforeEntries?.get(change.path)?.mode !== GITLINK_MODE,
						}));
						if (changes.length === 0) {
							for (const file of [indexFile, postIndex]) {
								try {
									fs.rmSync(file, { force: true });
								} catch {
									// dispose() cleans up whatever is left.
								}
							}
							return { mode, changes, restored: [], unrestorable: [], notes: [] };
						}
						if (mode !== "full") {
							return {
								mode,
								changes,
								restored: [],
								unrestorable: changes
									.filter((change) => !change.restorable)
									.map((change) => change.path),
								notes: [],
							};
						}
						const { restored, unrestorable } = await gitRestore(
							root,
							beforeTree,
							beforeEntries ?? new Map(),
							changes,
						);
						const notes: string[] = [];
						// Re-read once to prove the work tree matches the snapshot again; a
						// guard that claims to have restored and did not is worse than no guard.
						const verifyIndex = path.join(tempDirectory(), `verify-${sequence++}.index`);
						const verifiedTree = await gitCapture(root, verifyIndex, postIndex);
						if (verifiedTree !== undefined && verifiedTree !== beforeTree) {
							const remaining = await gitChangedPaths(root, beforeTree, verifiedTree);
							if (remaining !== undefined && remaining.length > 0) {
								notes.push(
									`${remaining.length} path(s) still differ from the snapshot after restoring.`,
								);
								for (const entry of remaining) {
									const absolute = path.resolve(root, entry.path);
									if (!unrestorable.includes(absolute)) unrestorable.push(absolute);
								}
							}
						}
						for (const file of [indexFile, postIndex, verifyIndex]) {
							try {
								fs.rmSync(file, { force: true });
							} catch {
								// dispose() cleans up whatever is left.
							}
						}
						return { mode, changes, restored, unrestorable, notes };
					}),
			};
		},
		dispose(): void {
			if (temporaryDirectory === undefined) return;
			try {
				fs.rmSync(temporaryDirectory, { recursive: true, force: true });
			} catch {
				// Nothing to do: the directory lives in the OS temp dir.
			}
			temporaryDirectory = undefined;
		},
	};
}
