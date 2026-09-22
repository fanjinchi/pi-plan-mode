import assert from "node:assert/strict";
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
