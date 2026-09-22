import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planMode from "../src/plan-mode.js";
import { createGitRepository, hasGit, withGuardMode } from "./git-fixture.js";
import { builtinTool, createMockContext, createMockPi } from "./support.js";

type ToolResultPatch = {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
};

async function setupPlanMode(options: {
	cwd: string;
	enabled: boolean;
	activeTools?: string[];
}): Promise<{
	mock: ReturnType<typeof createMockPi>;
	ctx: never;
	notifications: Array<{ message: string; level?: string }>;
}> {
	const mock = createMockPi({
		activeTools: options.activeTools ?? ["read", "bash"],
		allTools: (options.activeTools ?? ["read", "bash"]).map((name) => builtinTool(name)),
	});
	planMode(mock.pi);
	const { ctx, notifications } = createMockContext({
		cwd: options.cwd,
		sessionManager: {
			getEntries: () =>
				options.enabled
					? [{ type: "custom", customType: "plan-mode-state", data: { enabled: true } }]
					: [],
		},
	});
	for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);
	return { mock, ctx, notifications };
}

async function preflightToolCall(
	mock: ReturnType<typeof createMockPi>,
	ctx: never,
	event: Record<string, unknown>,
): Promise<unknown> {
	let result: unknown;
	for (const handler of mock.events.get("tool_call") ?? []) {
		result = await handler(event, ctx);
	}
	return result;
}

async function deliverToolResult(
	mock: ReturnType<typeof createMockPi>,
	ctx: never,
	event: Record<string, unknown>,
): Promise<ToolResultPatch | undefined> {
	let patch: ToolResultPatch | undefined;
	for (const handler of mock.events.get("tool_result") ?? []) {
		patch = (await handler(
			{
				type: "tool_result",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "output" }],
				...event,
			},
			ctx,
		)) as ToolResultPatch | undefined;
	}
	return patch;
}

test("an allowed shell command that writes is rolled back and reported to the model", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "full");
	const { mock, ctx, notifications } = await setupPlanMode({ cwd: directory, enabled: true });

	// The command passes the static judge, which is the only reason the guard exists.
	const verdict = await preflightToolCall(mock, ctx, {
		toolName: "bash",
		toolCallId: "call-write",
		input: { command: "git status --short" },
	});
	assert.equal(verdict, undefined, "the command itself is allowed");

	// What the command did while it was running.
	fs.writeFileSync(path.join(directory, "sneaky.txt"), "written by a read-only command\n");
	fs.writeFileSync(path.join(directory, "tracked.txt"), "overwritten\n");

	const patch = await deliverToolResult(mock, ctx, { toolCallId: "call-write" });
	assert.equal(patch?.isError, true, "the result is marked as an error");
	const text = (patch?.content ?? []).map((block) => block.text).join("\n");
	assert.match(text, /Plan mode is read-only/);
	assert.match(text, /created: sneaky\.txt/);
	assert.match(text, /modified: tracked\.txt/);
	assert.match(text, /Side effects outside the file system/);
	assert.equal(fs.existsSync(path.join(directory, "sneaky.txt")), false);
	assert.equal(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"), "committed\n");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /Plan mode guard: 2 path\(s\) changed/);
});

test("PI_PLAN_GUARD=detect reports the change without reverting it", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "detect");
	const { mock, ctx } = await setupPlanMode({ cwd: directory, enabled: true });

	await preflightToolCall(mock, ctx, {
		toolName: "bash",
		toolCallId: "call-detect",
		input: { command: "git status --short" },
	});
	fs.writeFileSync(path.join(directory, "tracked.txt"), "detect mode keeps this\n");
	const patch = await deliverToolResult(mock, ctx, { toolCallId: "call-detect" });
	assert.equal(patch?.isError, true);
	assert.match((patch?.content ?? [])[1]?.text ?? "", /PI_PLAN_GUARD=detect/);
	assert.equal(
		fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"),
		"detect mode keeps this\n",
	);
});

test("PI_PLAN_GUARD=off leaves the shell path exactly as it was", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-int-off-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "off");
	const { mock, ctx } = await setupPlanMode({ cwd: directory, enabled: true });

	await preflightToolCall(mock, ctx, {
		toolName: "bash",
		toolCallId: "call-off",
		input: { command: "ls" },
	});
	fs.writeFileSync(path.join(directory, "written.txt"), "written\n");
	const patch = await deliverToolResult(mock, ctx, { toolCallId: "call-off" });
	assert.equal(patch, undefined);
	assert.equal(fs.readFileSync(path.join(directory, "written.txt"), "utf8"), "written\n");
});

test("the guard stays out of the way when plan mode is off or the call was blocked", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-int-skip-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

	const inactive = await setupPlanMode({ cwd: directory, enabled: false });
	await preflightToolCall(inactive.mock, inactive.ctx, {
		toolName: "bash",
		toolCallId: "call-inactive",
		input: { command: "rm -rf build" },
	});
	fs.writeFileSync(path.join(directory, "inactive.txt"), "written\n");
	assert.equal(
		await deliverToolResult(inactive.mock, inactive.ctx, { toolCallId: "call-inactive" }),
		undefined,
	);
	assert.equal(fs.existsSync(path.join(directory, "inactive.txt")), true);

	const active = await setupPlanMode({ cwd: directory, enabled: true });
	const blocked = (await preflightToolCall(active.mock, active.ctx, {
		toolName: "bash",
		toolCallId: "call-blocked",
		input: { command: "rm -rf build" },
	})) as { block?: boolean } | undefined;
	assert.equal(blocked?.block, true, "the static judge still refuses the command");
	fs.writeFileSync(path.join(directory, "blocked.txt"), "written\n");
	assert.equal(
		await deliverToolResult(active.mock, active.ctx, { toolCallId: "call-blocked" }),
		undefined,
	);
	assert.equal(fs.existsSync(path.join(directory, "blocked.txt")), true);
});

test("a call without a tool call id is never snapshotted", async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-int-noid-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "full");
	const { mock, ctx } = await setupPlanMode({ cwd: directory, enabled: true });

	await preflightToolCall(mock, ctx, { toolName: "bash", input: { command: "ls" } });
	fs.writeFileSync(path.join(directory, "untracked-write.txt"), "written\n");
	assert.equal(await deliverToolResult(mock, ctx, { toolCallId: "call-unknown" }), undefined);
	assert.equal(fs.existsSync(path.join(directory, "untracked-write.txt")), true);
});

test("session shutdown drops snapshots whose tool result never arrived", async (t) => {
	if (!hasGit()) return t.skip("git is not available");
	const directory = createGitRepository();
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	withGuardMode(t, "full");
	const { mock, ctx } = await setupPlanMode({ cwd: directory, enabled: true });

	await preflightToolCall(mock, ctx, {
		toolName: "bash",
		toolCallId: "call-interrupted",
		input: { command: "git status --short" },
	});
	for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);

	// A result that arrives after the session is gone must not roll anything back.
	fs.writeFileSync(path.join(directory, "tracked.txt"), "after shutdown\n");
	assert.equal(await deliverToolResult(mock, ctx, { toolCallId: "call-interrupted" }), undefined);
	assert.equal(fs.readFileSync(path.join(directory, "tracked.txt"), "utf8"), "after shutdown\n");
});
