import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlanGuard, type GuardSettlement, resolveGuardMode } from "../src/plan-guard.js";
import { createGitRepository, git, hasGit, withGuardMode } from "./git-fixture.js";

function changedNames(
	settlement: GuardSettlement,
): Map<string, { kind: string; restorable: boolean }> {
	return new Map(
		settlement.changes.map((change) => [
			path.basename(change.path),
			{ kind: change.kind, restorable: change.restorable },
		]),
	);
}

function guardTempDirectories(): Set<string> {
	return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("pi-plan-guard-")));
}

/** A pid that belongs to no process: the only case where an old directory is provably debris. */
function exitedPid(): number | undefined {
	for (let attempt = 0; attempt < 5; attempt++) {
		const pid = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" }).pid;
		if (pid === undefined || pid <= 0) continue;
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
		}
	}
	return undefined;
}

test("resolveGuardMode defaults to full and is not switched off by a typo", () => {
	assert.equal(resolveGuardMode(undefined), "full");
	assert.equal(resolveGuardMode(""), "full");
	assert.equal(resolveGuardMode(" flull "), "full");
	assert.equal(resolveGuardMode("off"), "off");
	assert.equal(resolveGuardMode(" OFF "), "off");
	assert.equal(resolveGuardMode("detect"), "detect");
});

test("git backend restores created, modified and deleted paths, untracked ones included", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	// State that must survive the rollback: an uncommitted edit and an untracked file,
	// i.e. exactly the work a user would lose if the guard restored HEAD instead.
	fs.writeFileSync(path.join(directory, "tracked.txt"), "user edit, not committed\n");
	fs.writeFileSync(path.join(directory, "scratch.txt"), "user scratch\n");
	const indexPath = path.join(directory, ".git", "index");
	const indexBefore = fs.readFileSync(indexPath);
	const statusBefore = git(directory, ["status", "--porcelain"]);

	const guard = createPlanGuard(directory);
	const handle = await guard.begin();
	// What a mutating command would have done between the snapshot and the settle.
	fs.writeFileSync(path.join(directory, "tracked.txt"), "command wrote\n");
	fs.writeFileSync(path.join(directory, "scratch.txt"), "command clobbered\n");
	fs.writeFileSync(path.join(directory, "created.txt"), "new\n");
	fs.rmSync(path.join(directory, "removed.txt"));
	fs.mkdirSync(path.join(directory, "nested", "deep"), { recursive: true });
	fs.writeFileSync(path.join(directory, "nested", "deep", "file.txt"), "x\n");

	const settlement = await handle.settle();
	const changes = changedNames(settlement);
	assert.equal(settlement.mode, "full");
	assert.equal(changes.get("tracked.txt")?.kind, "modified");
	assert.equal(changes.get("scratch.txt")?.kind, "modified");
	assert.equal(changes.get("created.txt")?.kind, "created");
	assert.equal(changes.get("removed.txt")?.kind, "deleted");
	assert.equal(changes.get("file.txt")?.kind, "created");
	assert.deepEqual(settlement.unrestorable, []);
	assert.deepEqual(settlement.notes, []);
	assert.equal(
		fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"),
		"user edit, not committed\n",
		"the pre-call content comes back, not HEAD",
	);
	assert.equal(fs.readFileSync(path.join(directory, "scratch.txt"), "utf8"), "user scratch\n");
	assert.equal(fs.readFileSync(path.join(directory, "removed.txt"), "utf8"), "remove me\n");
	assert.equal(fs.existsSync(path.join(directory, "created.txt")), false);
	assert.equal(
		fs.existsSync(path.join(directory, "nested")),
		false,
		"emptied directories are pruned",
	);
	// The staging area belongs to the user: the guard snapshots through its own index.
	assert.deepEqual(fs.readFileSync(indexPath), indexBefore, "the user index stays untouched");
	assert.equal(git(directory, ["status", "--porcelain"]), statusBefore);
	assert.deepEqual(
		[...settlement.restored].sort(),
		[
			path.join(directory, "created.txt"),
			path.join(directory, "nested", "deep", "file.txt"),
			path.join(directory, "removed.txt"),
			path.join(directory, "scratch.txt"),
			path.join(directory, "tracked.txt"),
		].sort(),
	);

	const before = guardTempDirectories();
	guard.dispose();
	assert.deepEqual(
		[...guardTempDirectories()].filter((name) => !before.has(name)),
		[],
		"dispose() removes the temporary index directory",
	);
});

test("the git backend does not cover gitignored files (documented limitation)", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(directory, ".gitignore"), "ignored.txt\n");
	fs.writeFileSync(path.join(directory, "ignored.txt"), "user ignored\n");

	const guard = createPlanGuard(directory);
	const handle = await guard.begin();
	fs.writeFileSync(path.join(directory, "ignored.txt"), "command wrote here too\n");
	const settlement = await handle.settle();
	assert.equal(
		changedNames(settlement).has("ignored.txt"),
		false,
		"an ignored path is outside the snapshot the README describes",
	);
	assert.equal(
		fs.readFileSync(path.join(directory, "ignored.txt"), "utf8"),
		"command wrote here too\n",
	);
	guard.dispose();
});

test("without git the content snapshot restores what it can and reports the rest", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-files-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.writeFileSync(path.join(directory, "small.txt"), "before\n");
	fs.writeFileSync(path.join(directory, "gone.txt"), "keep\n");
	const oversized = "x".repeat(2 * 1024 * 1024);
	fs.writeFileSync(path.join(directory, "big.bin"), oversized);

	const guard = createPlanGuard(directory);
	const handle = await guard.begin();
	fs.writeFileSync(path.join(directory, "small.txt"), "after\n");
	fs.rmSync(path.join(directory, "gone.txt"));
	fs.writeFileSync(path.join(directory, "added.txt"), "new\n");
	fs.writeFileSync(path.join(directory, "big.bin"), `${oversized}y`);

	const settlement = await handle.settle();
	const changes = changedNames(settlement);
	assert.equal(changes.get("small.txt")?.kind, "modified");
	assert.equal(changes.get("gone.txt")?.kind, "deleted");
	assert.equal(changes.get("added.txt")?.kind, "created");
	assert.equal(changes.get("big.bin")?.kind, "modified");
	assert.equal(changes.get("big.bin")?.restorable, false, "a file over the budget is detect-only");
	assert.equal(fs.readFileSync(path.join(directory, "small.txt"), "utf8"), "before\n");
	assert.equal(fs.readFileSync(path.join(directory, "gone.txt"), "utf8"), "keep\n");
	assert.equal(fs.existsSync(path.join(directory, "added.txt")), false);
	assert.equal(
		fs.statSync(path.join(directory, "big.bin")).size,
		oversized.length + 1,
		"an unrestorable path is reported, never guessed at",
	);
	assert.deepEqual(
		settlement.unrestorable.map((absolute) => path.basename(absolute)),
		["big.bin"],
	);
	guard.dispose();
});

test("detect mode reports the change set and leaves the files alone", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "detect");

	const guard = createPlanGuard(directory);
	const handle = await guard.begin();
	fs.writeFileSync(path.join(directory, "tracked.txt"), "command wrote\n");
	fs.writeFileSync(path.join(directory, "created.txt"), "new\n");
	const settlement = await handle.settle();
	const changes = changedNames(settlement);
	assert.equal(settlement.mode, "detect");
	assert.deepEqual(settlement.restored, []);
	assert.equal(changes.get("tracked.txt")?.kind, "modified");
	assert.equal(changes.get("created.txt")?.kind, "created");
	assert.equal(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"), "command wrote\n");
	assert.equal(fs.existsSync(path.join(directory, "created.txt")), true);
	guard.dispose();
});

test("off mode never snapshots or settles anything", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-off-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "off");

	const guard = createPlanGuard(directory);
	const handle = await guard.begin();
	fs.writeFileSync(path.join(directory, "written.txt"), "written\n");
	const settlement = await handle.settle();
	assert.deepEqual(settlement.changes, []);
	assert.equal(fs.existsSync(path.join(directory, "written.txt")), true);
	guard.dispose();
});

test("settles never interleave, and a sibling snapshot during a settle does not wait", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const events: string[] = [];
	let active = 0;
	let maxActive = 0;
	let releaseFirstSettle: (() => void) | undefined;
	const firstSettleGate = new Promise<void>((resolve) => {
		releaseFirstSettle = resolve;
	});
	const guard = createPlanGuard(directory, {
		duringSettle: async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			events.push("settle-enter");
			if (events.filter((entry) => entry === "settle-enter").length === 1) await firstSettleGate;
			events.push("settle-exit");
			active -= 1;
		},
	});
	const first = await guard.begin();
	const second = await guard.begin();
	const firstSettled = first.settle().then(() => events.push("first-settled"));
	const secondSettled = second.settle().then(() => events.push("second-settled"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(events, ["settle-enter"], "the second settle queues behind the first");
	// pi awaits every sibling preflight before executing any sibling, so a snapshot
	// taken while a settle is in flight must not block on that settle's lock.
	const third = await guard.begin();
	assert.deepEqual(events, ["settle-enter"]);
	releaseFirstSettle?.();
	await Promise.all([firstSettled, secondSettled]);
	assert.equal(maxActive, 1, "two settlements must never run at the same time");
	assert.deepEqual(
		events.filter((entry) => entry === "settle-enter" || entry === "settle-exit"),
		["settle-enter", "settle-exit", "settle-enter", "settle-exit"],
	);
	assert.deepEqual(events.slice(-2).sort(), ["first-settled", "second-settled"]);
	await third.settle();
	guard.dispose();
});

test("a rollback does not leak into the change set of a call that started earlier", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const guard = createPlanGuard(directory);
	// Both preflights run before either command executes, which is why the second
	// snapshot still describes the pre-call world when the first rollback runs.
	const first = await guard.begin();
	const second = await guard.begin();

	fs.writeFileSync(path.join(directory, "tracked.txt"), "first command wrote\n");
	const firstSettlement = await first.settle();
	assert.equal(changedNames(firstSettlement).get("tracked.txt")?.kind, "modified");
	assert.equal(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"), "committed\n");

	fs.writeFileSync(path.join(directory, "added-by-second.txt"), "new\n");
	const secondSettlement = await second.settle();
	assert.deepEqual(
		[...changedNames(secondSettlement).keys()],
		["added-by-second.txt"],
		"the first call's rollback is not attributed to the second call",
	);
	assert.equal(fs.existsSync(path.join(directory, "added-by-second.txt")), false);
	guard.dispose();
});

test("a rollback puts the permission bits back and a bare chmod is a change", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const secret = path.join(directory, "secret.env");
	const script = path.join(directory, "run.sh");
	const privateFile = path.join(directory, "private.txt");
	fs.writeFileSync(secret, "secret\n");
	fs.chmodSync(secret, 0o600);
	fs.writeFileSync(script, "#!/bin/sh\n");
	fs.chmodSync(script, 0o700);
	fs.writeFileSync(privateFile, "keep\n");
	fs.chmodSync(privateFile, 0o640);

	const guard = createPlanGuard(directory);
	const handle = await guard.begin();
	// What a missed judgement would have done: content, content plus permissions, and a
	// bare chmod that never touches a byte.
	fs.writeFileSync(secret, "leaked\n");
	fs.chmodSync(secret, 0o666);
	fs.writeFileSync(script, "tampered\n");
	fs.chmodSync(script, 0o777);
	fs.chmodSync(privateFile, 0o644);

	const settlement = await handle.settle();
	const changes = changedNames(settlement);
	assert.equal(changes.get("secret.env")?.kind, "modified");
	assert.equal(changes.get("run.sh")?.kind, "modified");
	assert.equal(
		changes.get("private.txt")?.kind,
		"modified",
		"a chmod with unchanged content is still a write",
	);
	assert.equal(
		settlement.changes.find((change) => change.path.endsWith("private.txt"))?.permissionOnly,
		true,
	);
	assert.equal(fs.readFileSync(secret, "utf8"), "secret\n");
	assert.equal(
		fs.statSync(secret).mode & 0o7777,
		0o600,
		"a 0600 secret does not come back world-readable",
	);
	assert.equal(fs.statSync(script).mode & 0o7777, 0o700);
	assert.equal(fs.statSync(privateFile).mode & 0o7777, 0o640);
	assert.deepEqual(settlement.unrestorable, []);
	assert.deepEqual(settlement.notes, []);
	guard.dispose();
});

test("without git the content snapshot restores permission bits too", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-files-mode-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const secret = path.join(directory, "secret.env");
	const privateFile = path.join(directory, "private.txt");
	fs.writeFileSync(secret, "secret\n");
	fs.chmodSync(secret, 0o600);
	fs.writeFileSync(privateFile, "keep\n");
	fs.chmodSync(privateFile, 0o640);

	const guard = createPlanGuard(directory);
	const handle = await guard.begin();
	fs.writeFileSync(secret, "leaked\n");
	fs.chmodSync(secret, 0o666);
	fs.chmodSync(privateFile, 0o644);

	const settlement = await handle.settle();
	assert.equal(fs.readFileSync(secret, "utf8"), "secret\n");
	assert.equal(fs.statSync(secret).mode & 0o7777, 0o600);
	assert.equal(fs.statSync(privateFile).mode & 0o7777, 0o640);
	assert.equal(
		settlement.changes.find((change) => change.path.endsWith("private.txt"))?.permissionOnly,
		true,
	);
	assert.deepEqual(settlement.unrestorable, []);
	guard.dispose();
});

test("the sweep removes only directories whose owner is gone", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-sweep-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);
	const makeDirectory = (prefix: string, age: Date): string => {
		const created = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		fs.writeFileSync(path.join(created, "pre-0.index"), "debris from a killed session");
		fs.utimesSync(created, age, age);
		t.after(() => fs.rmSync(created, { recursive: true, force: true }));
		return created;
	};
	const deadPid = exitedPid();
	if (deadPid === undefined) return t.skip("could not observe an exited pid");
	// A live session holds its directory for as long as it lives, however old it gets: an
	// mtime says nothing about whether the owner is still working.
	const own = makeDirectory(`pi-plan-guard-${process.pid}-`, hoursAgo(2));
	const foreign = makeDirectory(`pi-plan-guard-${process.ppid}-`, hoursAgo(2));
	const dead = makeDirectory(`pi-plan-guard-${deadPid}-`, hoursAgo(2));
	const deadAndFresh = makeDirectory(`pi-plan-guard-${deadPid}-`, hoursAgo(0));
	// Names from the older layout carry no pid, so only the far larger threshold applies.
	const pidlessRecent = makeDirectory("pi-plan-guard-old-layout-", hoursAgo(2));
	const pidlessAncient = makeDirectory("pi-plan-guard-old-layout-", hoursAgo(25));

	const guard = createPlanGuard(directory);
	assert.equal(fs.existsSync(own), true, "a live guard's directory survives the sweep");
	assert.equal(fs.existsSync(foreign), true, "a live pid this process may not signal survives too");
	assert.equal(fs.existsSync(dead), false, "a directory whose owner exited is removed");
	assert.equal(fs.existsSync(deadAndFresh), true, "but not before it is old enough to be debris");
	assert.equal(fs.existsSync(pidlessRecent), true, "a pid-less name is not removed on age alone");
	assert.equal(
		fs.existsSync(pidlessAncient),
		false,
		"a pid-less name is removed once it is ancient",
	);
	guard.dispose();
});

test("a guard whose working directory disappears recreates it and keeps guarding", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "full");
	const guard = createPlanGuard(directory);
	t.after(() => guard.dispose());

	const first = await guard.begin();
	await first.settle();
	const workingDirectory = fs
		.readdirSync(os.tmpdir())
		.find((name) => name.startsWith(`pi-plan-guard-${process.pid}-`));
	assert.ok(workingDirectory !== undefined, "the first call allocated a working directory");
	fs.rmSync(path.join(os.tmpdir(), workingDirectory), { recursive: true, force: true });

	// Everything after this has to keep working: a guard that fails for the rest of the
	// session because one directory was removed is worse than no guard at all.
	const second = await guard.begin();
	fs.writeFileSync(path.join(directory, "written.txt"), "command wrote\n");
	const settlement = await second.settle();
	assert.equal(changedNames(settlement).get("written.txt")?.kind, "created");
	assert.equal(
		fs.existsSync(path.join(directory, "written.txt")),
		false,
		"the write is still detected and rolled back",
	);
	assert.equal(settlement.notes.length, 1, "the missing directory is reported exactly once");
	assert.match(settlement.notes[0] ?? "", /working directory .* disappeared/);

	const third = await guard.begin();
	fs.writeFileSync(path.join(directory, "written.txt"), "again\n");
	const thirdSettlement = await third.settle();
	assert.equal(changedNames(thirdSettlement).get("written.txt")?.kind, "created");
	assert.deepEqual(thirdSettlement.notes, [], "and the note does not repeat on every later call");
});

test("a directory that cannot be read after the call is unverified, not deleted", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-unreadable-"));
	const sealed = path.join(directory, "sealed");
	fs.mkdirSync(sealed);
	fs.writeFileSync(path.join(sealed, "inside.txt"), "inside\n");
	fs.writeFileSync(path.join(directory, "gone.txt"), "gone\n");
	t.after(() => {
		try {
			fs.chmodSync(sealed, 0o700);
		} catch {
			// Already removed with the rest of the fixture.
		}
		fs.rmSync(directory, { recursive: true, force: true });
	});
	// No repository, so this exercises the content snapshot and its comparison.
	withGuardMode(t, "full");
	const guard = createPlanGuard(directory);
	t.after(() => guard.dispose());

	const handle = await guard.begin();
	fs.chmodSync(sealed, 0o000);
	fs.rmSync(path.join(directory, "gone.txt"));
	const settlement = await handle.settle();
	fs.chmodSync(sealed, 0o700);

	const changes = changedNames(settlement);
	assert.equal(changes.get("gone.txt")?.kind, "deleted", "a real deletion is still reported");
	assert.equal(changes.get("inside.txt"), undefined, "an unreadable directory is not a deletion");
	assert.ok(
		settlement.unrestorable.some((entry) => entry.endsWith("inside.txt")),
		"its contents are reported as unverified instead",
	);
	assert.ok(
		settlement.notes.some((note) => /After the call: Could not read .*sealed/.test(note)),
		"and the note says which directory could not be read",
	);
	assert.equal(
		fs.readFileSync(path.join(directory, "gone.txt"), "utf8"),
		"gone\n",
		"the deletion is still undone",
	);
});

test("an ordinary call in a clean repository produces no notes at all", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "full");
	const guard = createPlanGuard(directory);
	t.after(() => guard.dispose());

	const handle = await guard.begin();
	const settlement = await handle.settle();
	assert.deepEqual(settlement.changes, []);
	assert.deepEqual(
		settlement.notes,
		[],
		"watching git's stderr must not turn a quiet snapshot into a note",
	);
});

test("PI_PLAN_GUARD_MODES=off skips the permission map and nothing else", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const previous = process.env.PI_PLAN_GUARD_MODES;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_PLAN_GUARD_MODES;
		else process.env.PI_PLAN_GUARD_MODES = previous;
	});
	withGuardMode(t, "full");
	process.env.PI_PLAN_GUARD_MODES = "off";
	const guard = createPlanGuard(directory);
	t.after(() => guard.dispose());

	const handle = await guard.begin();
	fs.chmodSync(path.join(directory, "tracked.txt"), 0o600);
	fs.writeFileSync(path.join(directory, "written.txt"), "written\n");
	const settlement = await handle.settle();
	const changes = changedNames(settlement);
	assert.equal(changes.get("written.txt")?.kind, "created", "content changes are still caught");
	assert.equal(
		changes.get("tracked.txt"),
		undefined,
		"without the map a bare chmod is invisible, which is what the switch trades away",
	);
	assert.deepEqual(settlement.notes, [], "and the missing map is not reported as a failure");
	assert.equal(fs.existsSync(path.join(directory, "written.txt")), false);
});

test("no temporary directory survives a snapshot, a settle and a dispose", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const previousMode = process.env.PI_PLAN_GUARD;
	t.after(() => {
		if (previousMode === undefined) delete process.env.PI_PLAN_GUARD;
		else process.env.PI_PLAN_GUARD = previousMode;
	});
	for (const mode of ["off", "detect", "full"]) {
		const baseline = guardTempDirectories();
		process.env.PI_PLAN_GUARD = mode;
		const guard = createPlanGuard(directory);
		const handle = await guard.begin();
		fs.writeFileSync(path.join(directory, "written.txt"), "written\n");
		await handle.settle();
		const created = [...guardTempDirectories()].filter((name) => !baseline.has(name));
		if (mode === "off") {
			assert.deepEqual(created, [], "off mode never creates a directory");
		} else {
			assert.equal(created.length, 1, `${mode} mode creates exactly one working directory`);
			const workingDirectory = created[0];
			assert.ok(workingDirectory);
			assert.deepEqual(
				fs.readdirSync(path.join(os.tmpdir(), workingDirectory)),
				[],
				`${mode} mode removes its index files when the settle ends`,
			);
		}
		guard.dispose();
		assert.deepEqual(
			[...guardTempDirectories()].filter((name) => !baseline.has(name)),
			[],
			`dispose() removes the working directory in ${mode} mode`,
		);
		fs.rmSync(path.join(directory, "written.txt"), { force: true });
	}
});
