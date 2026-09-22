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
 *
 * Permission bits: git records only 0644/0755, and `checkout-index` writes files under the
 * process umask, so a rollback that only replaced content would hand a 0600 secret back
 * world-readable. The guard reads the real modes of its snapshot's paths before the call
 * and puts them back afterwards (see captureWorkTreeModes).
 */
export type GuardMode = "off" | "detect" | "full";

export type GuardChangeKind = "created" | "modified" | "deleted";

export interface GuardChange {
	/** Absolute path. */
	path: string;
	kind: GuardChangeKind;
	/** False when the snapshot did not keep enough to put the path back. */
	restorable: boolean;
	/** True when only the permission bits moved: the content is unchanged. */
	permissionOnly?: boolean;
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
/** The mode map costs one lstat per snapshot path; a larger tree is reported as degraded. */
const MODE_MAP_LIMIT = 20000;
const MODE_TYPE_MASK = 0o170000;
const MODE_FILE_TYPE = 0o100000;
const MODE_PERMISSION_MASK = 0o7777;
/** No live guarded call holds its working directory for an hour: a call holds it for one command. */
const STALE_DIRECTORY_MS = 60 * 60 * 1000;
/**
 * Working directories belong to one process each, and their name carries that pid. A name
 * without one comes from an older layout and is only removed once it is far older than any
 * plausible session.
 */
const ANCIENT_DIRECTORY_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_PREFIX = "pi-plan-guard-";

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

/**
 * `PI_PLAN_GUARD_MODES=off` skips the per-call permission-bit map, which costs one lstat
 * per snapshot path. It exists for large work trees: without the map a rollback falls back
 * to git's own 100644/100755, and a plain `chmod` is neither detected nor reversed.
 */
export function planGuardModesEnabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() !== "off";
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
	if (mode !== undefined) fs.chmodSync(temporary, mode & MODE_PERMISSION_MASK);
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
	/** Directories whose contents could not be read: the paths below them were never compared. */
	unreadable: Set<string>;
}

function captureFileSnapshot(root: string): FileSnapshot {
	const entries = new Map<string, FileEntry>();
	const notes: string[] = [];
	const unreadable = new Set<string>();
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
			// Distinguish "cannot look inside" from "the directory is gone": a later comparison
			// must not read the contents it never saw as deleted.
			unreadable.add(directory);
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
	return { entries, notes, unreadable };
}

/** The unreadable directory a path lives in, if the snapshot never saw what is below it. */
function unreadableParent(snapshot: FileSnapshot, absolute: string): string | undefined {
	for (const directory of snapshot.unreadable) {
		if (absolute === directory || absolute.startsWith(`${directory}${path.sep}`)) return directory;
	}
	return undefined;
}

function fileContentChanged(before: FileEntry, after: FileEntry): boolean {
	if (before.kind !== after.kind) return true;
	if (before.kind === "symlink") return before.target !== after.target;
	if (before.kind === "directory") return false;
	if (before.hash !== undefined && after.hash !== undefined) return before.hash !== after.hash;
	return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function fileEntryChanged(before: FileEntry, after: FileEntry): boolean {
	if (fileContentChanged(before, after)) return true;
	// A file whose content is identical but whose mode moved is still a write in plan mode:
	// widening 0600 to 0644 is a real change, and the fallback snapshot can see it.
	return (before.mode & MODE_PERMISSION_MASK) !== (after.mode & MODE_PERMISSION_MASK);
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
			if (change.permissionOnly === true) {
				// The content never moved, so putting the permission bits back is the repair.
				if (previous === undefined || previous.kind !== "file") {
					unrestorable.push(absolute);
					continue;
				}
				fs.chmodSync(absolute, previous.mode & MODE_PERMISSION_MASK);
				restored.push(absolute);
				continue;
			}
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
): Promise<{ tree: string; note?: string } | undefined> {
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
	if (tree.length === 0) return undefined;
	// `git add` exits 0 while writing warnings for whatever it could not read (an unreadable
	// directory, for instance), which makes the snapshot silently incomplete. The exit code
	// is all git tells us about success, so the first warning line is the one usable signal.
	const warning = added.stderr
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	return warning === undefined
		? { tree }
		: { tree, note: `The snapshot may be incomplete: ${warning}` };
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

async function gitIndexPaths(root: string, indexFile: string): Promise<string[] | undefined> {
	const result = await gitRun(root, ["ls-files", "-z"], { GIT_INDEX_FILE: indexFile });
	if (result.code !== 0) return undefined;
	return result.stdout.split("\0").filter((file) => file.length > 0);
}

/**
 * Reads the real permission bits of everything the snapshot covers. Git cannot answer
 * this question: its index stores 100644/100755 only, so a 0600 file and a 0644 file look
 * identical to `diff-tree`. Without this map a rollback would rewrite a 0600 secret under
 * the process umask (0644 with the usual 022) and call it restored.
 */
async function captureWorkTreeModes(
	root: string,
	indexFile: string,
): Promise<{ modes: Map<string, number>; note?: string }> {
	const paths = await gitIndexPaths(root, indexFile);
	if (paths === undefined) {
		return {
			modes: new Map(),
			note: "Permission bits were not recorded for this call: the snapshot's path list was unavailable.",
		};
	}
	if (paths.length > MODE_MAP_LIMIT) {
		return {
			modes: new Map(),
			note: `Permission bits were not recorded for this call: the work tree has ${paths.length} entries (limit ${MODE_MAP_LIMIT}).`,
		};
	}
	const modes = new Map<string, number>();
	for (const file of paths) {
		try {
			modes.set(file, fs.lstatSync(path.resolve(root, file)).mode);
		} catch {
			// A path that vanished between `add` and this stat has no mode to restore.
		}
	}
	return { modes };
}

/**
 * Paths whose content is untouched but whose permission bits moved. `diff-tree` cannot
 * report these (mode 100644 and 100755 only), so they are compared against the recorded
 * map instead: a plain `chmod` is invisible to git and would otherwise never be reversed.
 */
function permissionOnlyPaths(
	root: string,
	changed: { path: string }[],
	modes: Map<string, number>,
): string[] {
	if (modes.size === 0) return [];
	const touched = new Set(changed.map((change) => change.path));
	const moved: string[] = [];
	for (const [file, mode] of modes) {
		if (touched.has(file)) continue;
		// Regular files only: chmod on a symlink would hit its target instead.
		if ((mode & MODE_TYPE_MASK) !== MODE_FILE_TYPE) continue;
		let current: number;
		try {
			current = fs.lstatSync(path.resolve(root, file)).mode;
		} catch {
			continue;
		}
		if ((current & MODE_PERMISSION_MASK) !== (mode & MODE_PERMISSION_MASK)) moved.push(file);
	}
	return moved;
}

/** The pid recorded in a working directory's name, when the name carries one. */
function directoryOwner(name: string): number | undefined {
	const match = /^pi-plan-guard-(\d+)-/.exec(name);
	if (match === null || match[1] === undefined) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** `EPERM` means the process exists but belongs to someone else: still alive. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * A killed session cannot remove its own working directory, so creating a guard also drops
 * directories that are old enough to be debris *and* whose owner is provably gone. Age alone
 * is the wrong test: an idle session holds its directory for as long as it lives, and
 * deleting it would take that session's guard down with it. So the pid in the name decides —
 * a live pid (including one this process may not signal) keeps its directory, and a name
 * without a pid is only removed once it is far older than any session. A pid recycled by an
 * unrelated process keeps a dead directory around, which is the safe failure: leaving
 * garbage beats deleting a live guard's state.
 */
function sweepStaleDirectories(): void {
	let names: string[];
	try {
		names = fs.readdirSync(os.tmpdir());
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of names) {
		if (!name.startsWith(DIRECTORY_PREFIX)) continue;
		const candidate = path.join(os.tmpdir(), name);
		const owner = directoryOwner(name);
		try {
			const stat = fs.statSync(candidate);
			if (!stat.isDirectory()) continue;
			if (owner === undefined) {
				if (now - stat.mtimeMs >= ANCIENT_DIRECTORY_MS) {
					fs.rmSync(candidate, { recursive: true, force: true });
				}
				continue;
			}
			if (now - stat.mtimeMs < STALE_DIRECTORY_MS) continue;
			if (processAlive(owner)) continue;
			fs.rmSync(candidate, { recursive: true, force: true });
		} catch {
			// Another session may have removed it first, or it is not ours to remove.
		}
	}
}

export function createPlanGuard(cwd: string, options: PlanGuardOptions = {}): PlanGuard {
	let temporaryDirectory: string | undefined;
	let settleChain: Promise<unknown> = Promise.resolve();
	let sequence = 0;
	let disposed = false;
	/** Set when something removed the working directory underneath this guard. */
	let directoryNote: string | undefined;
	sweepStaleDirectories();

	/**
	 * The pid in the name lets a test, or a user staring at /tmp, tell which session a
	 * leftover directory belongs to. A guard that lost its directory (a sweep from an older
	 * version, a user emptying /tmp) recreates it here rather than failing every call for the
	 * rest of the session: the directory is bookkeeping, not state worth dying over.
	 */
	function tempDirectory(): string {
		if (temporaryDirectory !== undefined) {
			try {
				if (fs.statSync(temporaryDirectory).isDirectory()) return temporaryDirectory;
			} catch {
				// Gone: recreated below.
			}
		}
		const previous = temporaryDirectory;
		temporaryDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), `${DIRECTORY_PREFIX}${process.pid}-`),
		);
		if (previous !== undefined) {
			directoryNote = `The guard's working directory ${previous} disappeared; ${temporaryDirectory} replaced it for this call.`;
		}
		return temporaryDirectory;
	}

	/** Reported by the next settle, once: this describes an event, not the call it lands in. */
	function takeDirectoryNote(): string[] {
		if (directoryNote === undefined) return [];
		const note = directoryNote;
		directoryNote = undefined;
		return [note];
	}

	/**
	 * Temporary index files share one directory per guard, so dispose() drops them in one
	 * step. A settle that arrives after dispose() (the extension moved to another working
	 * directory) still runs, but it must not recreate a directory nothing would clean up:
	 * its file lands directly in the temp directory and is removed when the settle is done.
	 */
	function allocateTempFile(label: string): string {
		if (disposed) {
			return path.join(os.tmpdir(), `pi-plan-guard-${process.pid}-${label}-${sequence++}.index`);
		}
		return path.join(tempDirectory(), `${label}.index`);
	}

	function removeTempFiles(...files: string[]): void {
		for (const file of files) {
			try {
				fs.rmSync(file, { force: true });
			} catch {
				// dispose() removes the directory as a whole; a late file is retried here only.
			}
		}
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
		modes: Map<string, number>,
	): Promise<{ restored: string[]; unrestorable: string[]; notes: string[] }> {
		const restored: string[] = [];
		const unrestorable: string[] = [];
		const notes: string[] = [];
		const indexFile = allocateTempFile(`restore-${sequence++}`);
		try {
			const env = { GIT_INDEX_FILE: indexFile };
			const reload = await gitRun(root, ["read-tree", beforeTree], env);
			if (reload.code !== 0) {
				for (const change of changes) unrestorable.push(change.path);
				return { restored, unrestorable, notes };
			}
			const toCheckout: string[] = [];
			const permissionOnly: string[] = [];
			for (const change of changes) {
				const absolute = path.resolve(root, change.path);
				const previous = beforeEntries.get(change.path);
				if (change.permissionOnly === true) {
					// The content never moved, so putting the permission bits back is the repair.
					if (previous === undefined) unrestorable.push(absolute);
					else permissionOnly.push(change.path);
					continue;
				}
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
			const checkedOut = new Set<string>();
			for (let index = 0; index < toCheckout.length; index += RESTORE_BATCH_SIZE) {
				const batch = toCheckout.slice(index, index + RESTORE_BATCH_SIZE);
				const result = await gitRun(root, ["checkout-index", "-f", "--", ...batch], env);
				for (const file of batch) {
					const absolute = path.resolve(root, file);
					if (result.code === 0 && fs.existsSync(absolute)) {
						checkedOut.add(file);
						restored.push(absolute);
					} else unrestorable.push(absolute);
				}
			}
			// `checkout-index` writes content under the process umask, so the recorded mode is
			// applied afterwards — and read back, because a chmod that silently did not stick
			// must not be reported as a restore.
			const permissionOnlySet = new Set(permissionOnly);
			const failedModes: string[] = [];
			for (const file of [...checkedOut, ...permissionOnly]) {
				const absolute = path.resolve(root, file);
				const recorded = modes.get(file);
				// Regular files only: chmod on a symlink would change its target instead.
				if (recorded === undefined || (recorded & MODE_TYPE_MASK) !== MODE_FILE_TYPE) {
					if (permissionOnlySet.has(file)) {
						unrestorable.push(absolute);
						notes.push(
							`Could not restore the permission bits of ${absolute}: no mode was recorded for it.`,
						);
					}
					continue;
				}
				const wanted = recorded & MODE_PERMISSION_MASK;
				try {
					if ((fs.lstatSync(absolute).mode & MODE_PERMISSION_MASK) !== wanted) {
						fs.chmodSync(absolute, wanted);
					}
					if ((fs.lstatSync(absolute).mode & MODE_PERMISSION_MASK) !== wanted) {
						failedModes.push(absolute);
					} else if (permissionOnlySet.has(file)) {
						restored.push(absolute);
					}
				} catch {
					failedModes.push(absolute);
				}
			}
			for (const absolute of failedModes) {
				if (!unrestorable.includes(absolute)) unrestorable.push(absolute);
				notes.push(`Could not restore the permission bits of ${absolute}.`);
			}
			return { restored, unrestorable, notes };
		} finally {
			removeTempFiles(indexFile);
		}
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
									const permissionOnly = !fileContentChanged(previous, entry);
									changes.push({
										path: absolute,
										kind: "modified",
										restorable:
											permissionOnly || previous.kind !== "file" || previous.content !== undefined,
										permissionOnly,
									});
								}
							}
							const unverified: string[] = [];
							for (const [absolute, entry] of snapshot.entries) {
								if (after.entries.has(absolute)) continue;
								// A directory that could not be read after the call hides whatever is below it:
								// those paths are unverified, not deleted.
								if (unreadableParent(after, absolute) !== undefined) {
									unverified.push(absolute);
									continue;
								}
								changes.push({
									path: absolute,
									kind: "deleted",
									restorable: entry.kind !== "file" || entry.content !== undefined,
								});
							}
							// Notes from the re-read matter as much as the snapshot's: a subtree that could
							// not be read after the call was never compared, and silence would claim it was.
							const notes = [
								...takeDirectoryNote(),
								...snapshot.notes,
								...after.notes.map((note) => `After the call: ${note}`),
							];
							const { restored, unrestorable } = restoreFilePaths(
								mode,
								cwd,
								snapshot,
								after,
								changes,
							);
							for (const path of unverified) {
								if (!unrestorable.includes(path)) unrestorable.push(path);
							}
							for (const note of snapshot.notes) {
								if (!notes.includes(note)) notes.push(note);
							}
							return { mode, changes, restored, unrestorable, notes };
						}),
				};
			}
			const indexFile = allocateTempFile(`pre-${sequence++}`);
			const seed = await gitUserIndexPath(root);
			const beforeTree = await gitCapture(root, indexFile, seed);
			if (beforeTree === undefined) {
				removeTempFiles(indexFile);
				return {
					settle: async () =>
						emptySettlement(mode, [
							...takeDirectoryNote(),
							`Could not snapshot the git work tree at ${root}; this call was not guarded.`,
						]),
				};
			}
			const snapshotNotes = beforeTree.note === undefined ? [] : [beforeTree.note];
			// The real permission bits live nowhere git can see them, so they are read here,
			// before the command runs (see captureWorkTreeModes).
			const modes = planGuardModesEnabled(process.env.PI_PLAN_GUARD_MODES)
				? await captureWorkTreeModes(root, indexFile)
				: { modes: new Map<string, number>() };
			return {
				settle: async () =>
					withSettleLock(async () => {
						await options.duringSettle?.();
						const postIndex = allocateTempFile(`post-${sequence++}`);
						const verifyIndex = allocateTempFile(`verify-${sequence++}`);
						const notes: string[] = [
							...snapshotNotes,
							...takeDirectoryNote(),
							...(modes.note === undefined ? [] : [modes.note]),
						];
						try {
							const afterTree = await gitCapture(root, postIndex, indexFile);
							if (afterTree === undefined) {
								return emptySettlement(mode, [
									...notes,
									`Could not re-read the git work tree at ${root}; this call was not checked.`,
								]);
							}
							if (afterTree.note !== undefined && !notes.includes(afterTree.note)) {
								notes.push(afterTree.note);
							}
							const changed = await gitChangedPaths(root, beforeTree.tree, afterTree.tree);
							if (changed === undefined) {
								return emptySettlement(mode, [
									...notes,
									`Could not diff the git work tree at ${root}; this call was not checked.`,
								]);
							}
							const beforeEntries = await gitTreeEntries(root, beforeTree.tree);
							const changes: GuardChange[] = [
								...changed.map((change) => ({
									path: change.path,
									kind: change.kind,
									restorable: beforeEntries?.get(change.path)?.mode !== GITLINK_MODE,
								})),
								// A plain chmod moves no content, so diff-tree cannot report it; the modes
								// recorded before the call can.
								...permissionOnlyPaths(root, changed, modes.modes).map((file) => ({
									path: file,
									kind: "modified" as const,
									restorable: true,
									permissionOnly: true,
								})),
							];
							if (changes.length === 0) {
								return { mode, changes, restored: [], unrestorable: [], notes };
							}
							if (mode !== "full") {
								return {
									mode,
									changes,
									restored: [],
									unrestorable: changes
										.filter((change) => !change.restorable)
										.map((change) => change.path),
									notes,
								};
							}
							const restoral = await gitRestore(
								root,
								beforeTree.tree,
								beforeEntries ?? new Map(),
								changes,
								modes.modes,
							);
							notes.push(...restoral.notes);
							// Re-read once to prove the work tree matches the snapshot again; a
							// guard that claims to have restored and did not is worse than no guard.
							const verifiedTree = await gitCapture(root, verifyIndex, postIndex);
							if (
								verifiedTree !== undefined &&
								verifiedTree.note !== undefined &&
								!notes.includes(verifiedTree.note)
							) {
								notes.push(verifiedTree.note);
							}
							if (verifiedTree !== undefined && verifiedTree.tree !== beforeTree.tree) {
								const remaining = await gitChangedPaths(root, beforeTree.tree, verifiedTree.tree);
								if (remaining !== undefined && remaining.length > 0) {
									notes.push(
										`${remaining.length} path(s) still differ from the snapshot after restoring.`,
									);
									for (const entry of remaining) {
										const absolute = path.resolve(root, entry.path);
										if (!restoral.unrestorable.includes(absolute)) {
											restoral.unrestorable.push(absolute);
										}
									}
								}
							}
							return {
								mode,
								changes,
								restored: restoral.restored,
								unrestorable: restoral.unrestorable,
								notes,
							};
						} finally {
							removeTempFiles(indexFile, postIndex, verifyIndex);
						}
					}),
			};
		},
		dispose(): void {
			disposed = true;
			if (temporaryDirectory === undefined) return;
			try {
				fs.rmSync(temporaryDirectory, { recursive: true, force: true });
			} catch {
				// Nothing to do: the directory lives in the OS temp dir, and the stale-directory
				// sweep of the next guard picks it up if this session is killed here.
			}
			temporaryDirectory = undefined;
		},
	};
}
