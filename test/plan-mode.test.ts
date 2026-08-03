import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planMode, {
	canSelectToolInPlanMode,
	completePlanArguments,
	isPlanFileTarget,
	isSafeCommand,
	normalizePlanModeQuestionParams,
	readPlanFile,
	withoutPlanModeQuestionTool,
	withRequiredPlanModeTools,
} from "../src/plan-mode.js";
import { builtinTool, createMockContext, createMockPi, extensionTool } from "./support.js";

test("plan-mode registers flag, question tool, command, and safety hooks", () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	assert.ok(mock.flags.has("plan"));
	assert.equal(mock.tools[0]?.name, "plan_mode_question");
	assert.ok(mock.commands.has("plan"));
	assert.equal(typeof mock.commands.get("plan")?.getArgumentCompletions, "function");
	assert.ok(mock.events.has("tool_call"));
	assert.ok(mock.events.has("before_agent_start"));
});

test("completePlanArguments suggests management tokens only", () => {
	assert.deepEqual(
		completePlanArguments("")?.map((item) => item.label),
		["exit", "off", "tools"],
	);
	assert.deepEqual(
		completePlanArguments("to")?.map((item) => item.value),
		["tools"],
	);
	assert.equal(completePlanArguments("tools "), null);
	assert.equal(completePlanArguments("write a plan"), null);
	assert.equal(completePlanArguments("unknown"), null);
});

test("tool selection allows safe built-ins and non-built-ins only", () => {
	type PlanTool = Parameters<typeof canSelectToolInPlanMode>[0];
	assert.equal(canSelectToolInPlanMode(builtinTool("read") as PlanTool), true);
	assert.equal(canSelectToolInPlanMode(builtinTool("edit") as PlanTool), false);
	assert.equal(canSelectToolInPlanMode(extensionTool("custom") as PlanTool), true);
	assert.deepEqual(withRequiredPlanModeTools(["read", "plan_mode_question", "read"]), [
		"read",
		"edit",
		"write",
		"plan_mode_question",
	]);
	assert.deepEqual(withoutPlanModeQuestionTool(["read", "plan_mode_question"]), ["read"]);
});

test("isSafeCommand permits read-only commands and blocks mutating commands", () => {
	assert.equal(isSafeCommand("git status --short"), true);
	assert.equal(isSafeCommand("sed -n '1,20p' file.ts"), true);
	assert.equal(isSafeCommand("rm -rf build"), false);
	assert.equal(isSafeCommand("npm install"), false);
	assert.equal(isSafeCommand(""), false);
});

test("normalizePlanModeQuestionParams validates question shape", () => {
	const result = normalizePlanModeQuestionParams({
		questions: [
			{
				id: "scope",
				header: "Scope",
				question: "How broad?",
				options: [
					{ label: "Small", description: "Only the bug." },
					{ label: "Broad", description: "Include nearby cleanup." },
				],
			},
		],
	});

	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
	assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
		ok: false,
		error: "questions must contain 1-3 items",
	});
});

test("readPlanFile returns trimmed content or undefined", (t) => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
	const planPath = path.join(tmpDir, "pi_plan.md");

	assert.equal(readPlanFile(tmpDir), undefined);

	fs.writeFileSync(planPath, "  \n  \n  ", "utf-8");
	assert.equal(readPlanFile(tmpDir), undefined);

	fs.writeFileSync(planPath, "# My Plan\n\nDetails here.\n", "utf-8");
	assert.equal(readPlanFile(tmpDir), "# My Plan\n\nDetails here.");
});

test("isPlanFileTarget matches pi_plan.md only", () => {
	const cwd = "/home/user/project";
	assert.equal(isPlanFileTarget(cwd, { path: "pi_plan.md" }), true);
	assert.equal(isPlanFileTarget(cwd, { path: "./pi_plan.md" }), true);
	assert.equal(isPlanFileTarget(cwd, { path: path.join(cwd, "pi_plan.md") }), true);
	assert.equal(isPlanFileTarget(cwd, { path: "other.md" }), false);
	assert.equal(isPlanFileTarget(cwd, { path: "sub/pi_plan.md" }), false);
	assert.equal(isPlanFileTarget(cwd, { path: 42 }), false);
	assert.equal(isPlanFileTarget(cwd, {}), false);
	assert.equal(isPlanFileTarget(cwd, "string"), false);
});

test("isPlanFileTarget refuses a symlinked plan file", (t) => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const target = path.join(tmpDir, "real.md");
	fs.writeFileSync(target, "secret", "utf-8");
	const link = path.join(tmpDir, "pi_plan.md");
	fs.symlinkSync(target, link);
	assert.equal(isPlanFileTarget(tmpDir, { path: "pi_plan.md" }), false);

	fs.rmSync(link);
	assert.equal(isPlanFileTarget(tmpDir, { path: "pi_plan.md" }), true);
});

test("tool_call gating: write/edit to pi_plan.md allowed, others blocked", async (t) => {
	const mock = createMockPi({
		activeTools: ["read", "bash"],
		allTools: [builtinTool("read"), builtinTool("bash"), builtinTool("edit"), builtinTool("write")],
	});
	planMode(mock.pi);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
	const { ctx } = createMockContext({
		cwd: tmpDir,
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true },
				},
			],
		},
	});

	const sessionStartHandlers = mock.events.get("session_start") ?? [];
	for (const handler of sessionStartHandlers) await handler({}, ctx);

	const toolCallHandlers = mock.events.get("tool_call") ?? [];

	for (const handler of toolCallHandlers) {
		// write to pi_plan.md → allowed
		const writePlan = await handler(
			{ toolName: "write", input: { path: "pi_plan.md", content: "# Plan" } },
			ctx,
		);
		assert.equal(writePlan, undefined, "write to pi_plan.md should be allowed");

		// write to other.md → blocked
		const writeOther = (await handler(
			{ toolName: "write", input: { path: "other.md", content: "x" } },
			ctx,
		)) as { block?: boolean };
		assert.equal(writeOther.block, true, "write to other.md should be blocked");

		// edit to pi_plan.md → allowed
		const editPlan = await handler(
			{ toolName: "edit", input: { path: "pi_plan.md", oldText: "a", newText: "b" } },
			ctx,
		);
		assert.equal(editPlan, undefined, "edit to pi_plan.md should be allowed");

		// edit to sub/pi_plan.md → blocked
		const editSub = (await handler(
			{ toolName: "edit", input: { path: "sub/pi_plan.md", oldText: "a", newText: "b" } },
			ctx,
		)) as { block?: boolean };
		assert.equal(editSub.block, true, "edit to sub/pi_plan.md should be blocked");

		// mutating bash still blocked
		const bashRm = (await handler(
			{ toolName: "bash", input: { command: "rm -rf build" } },
			ctx,
		)) as { block?: boolean };
		assert.equal(bashRm.block, true, "mutating bash should be blocked");
	}
});

test("Implement this plan appends user extra input from ready menu", async (t) => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	let selectCalls = 0;
	const selectValues = ["Implement this plan"];
	const { ctx } = createMockContext({
		cwd: tmpDir,
		hasUI: true,
		select: async () => selectValues[selectCalls++] ?? undefined,
		editor: async () => "Also add tests",
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true },
				},
			],
		},
	});

	const sessionStartHandlers = mock.events.get("session_start") ?? [];
	for (const handler of sessionStartHandlers) await handler({}, ctx);

	// Write plan file after session_start so agent_end detects a change
	fs.writeFileSync(path.join(tmpDir, "pi_plan.md"), "# Fix bug\n\nSteps here.", "utf-8");

	const agentEndHandlers = mock.events.get("agent_end") ?? [];
	for (const handler of agentEndHandlers) {
		await handler(
			{
				messages: [{ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }],
			},
			ctx,
		);
	}

	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(selectCalls, 1);
	assert.equal(mock.sentUserMessages.length, 1);
	const sent = mock.sentUserMessages[0]?.text ?? "";
	assert.ok(sent.includes("Implement this proposed plan now"));
	assert.ok(sent.includes("Additional instructions from user:\nAlso add tests"));
	assert.ok(sent.includes("# Fix bug"));
});

test("Cancelling implementation input returns to ready menu", async (t) => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	let selectCalls = 0;
	const selectValues = ["Implement this plan", "Exit Plan mode"];
	const { ctx } = createMockContext({
		cwd: tmpDir,
		hasUI: true,
		select: async () => selectValues[selectCalls++] ?? undefined,
		editor: async () => undefined,
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true },
				},
			],
		},
	});

	const sessionStartHandlers = mock.events.get("session_start") ?? [];
	for (const handler of sessionStartHandlers) await handler({}, ctx);

	fs.writeFileSync(path.join(tmpDir, "pi_plan.md"), "# Fix bug\n\nSteps here.", "utf-8");

	const agentEndHandlers = mock.events.get("agent_end") ?? [];
	for (const handler of agentEndHandlers) await handler({ messages: [] }, ctx);

	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(selectCalls, 2);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("agent_end with unchanged plan file does not re-show the ready menu", async (t) => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	// Plan file exists before session_start, so the session-start sync adopts it.
	fs.writeFileSync(path.join(tmpDir, "pi_plan.md"), "# Fix bug\n\nSteps here.", "utf-8");

	let selectCalls = 0;
	const { ctx } = createMockContext({
		cwd: tmpDir,
		hasUI: true,
		select: async () => {
			selectCalls++;
			return undefined;
		},
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true },
				},
			],
		},
	});

	const sessionStartHandlers = mock.events.get("session_start") ?? [];
	for (const handler of sessionStartHandlers) await handler({}, ctx);

	const agentEndHandlers = mock.events.get("agent_end") ?? [];
	for (const handler of agentEndHandlers) await handler({ messages: [] }, ctx);

	await new Promise((resolve) => setTimeout(resolve, 50));

	assert.equal(selectCalls, 0);
});

test("deleting the plan file clears plan-ready state", async (t) => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const planPath = path.join(tmpDir, "pi_plan.md");
	fs.writeFileSync(planPath, "# Fix bug\n\nSteps here.", "utf-8");

	const { ctx, statuses } = createMockContext({
		cwd: tmpDir,
		hasUI: true,
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: true },
				},
			],
		},
	});

	const sessionStartHandlers = mock.events.get("session_start") ?? [];
	for (const handler of sessionStartHandlers) await handler({}, ctx);
	assert.equal(statuses.get("plan-mode"), "plan ready");

	fs.rmSync(planPath);

	const beforeAgentStartHandlers = mock.events.get("before_agent_start") ?? [];
	for (const handler of beforeAgentStartHandlers) await handler({ systemPrompt: "" }, ctx);
	assert.equal(statuses.get("plan-mode"), "plan active");
});
