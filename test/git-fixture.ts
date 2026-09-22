import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runs git in a fixture repository and returns its stdout. */
export function git(directory: string, args: string[]): string {
	return execFileSync("git", args, { cwd: directory, encoding: "utf8" });
}

/** The guard's git backend is optional in real life; its tests are too. */
export function hasGit(): boolean {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * A throwaway repository with one commit and a known pair of files, so a test can tell
 * "restored to the pre-call state" apart from "reset to HEAD".
 */
export function createGitRepository(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-git-"));
	git(directory, ["init", "--quiet"]);
	git(directory, ["config", "user.email", "guard@example.com"]);
	git(directory, ["config", "user.name", "Plan Guard Test"]);
	git(directory, ["config", "commit.gpgsign", "false"]);
	fs.writeFileSync(path.join(directory, "tracked.txt"), "committed\n");
	fs.writeFileSync(path.join(directory, "removed.txt"), "remove me\n");
	git(directory, ["add", "--all"]);
	git(directory, ["commit", "--quiet", "-m", "initial"]);
	return directory;
}

/** Pins `PI_PLAN_GUARD` for one test and restores the previous value afterwards. */
export function withGuardMode(context: { after(fn: () => void): void }, value: string): void {
	const previous = process.env.PI_PLAN_GUARD;
	process.env.PI_PLAN_GUARD = value;
	context.after(() => {
		if (previous === undefined) delete process.env.PI_PLAN_GUARD;
		else process.env.PI_PLAN_GUARD = previous;
	});
}
