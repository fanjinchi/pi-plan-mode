import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import planMode, {
	canSelectToolInPlanMode,
	completePlanArguments,
	isContextManagementTool,
	isDefaultPlanModeTool,
	isPlanFileTarget,
	isSafeCommand,
	isSafePowerShellCommand,
	normalizePlanModeQuestionParams,
	PLAN_EMBED_MAX_CHARS,
	readPlanFile,
	toolPolicyLabel,
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
		["exit", "off", "tools", "done"],
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
	// A shadowed edit/write is confined to the plan file, so it is not offered as
	// a per-session choice either.
	assert.equal(canSelectToolInPlanMode(extensionTool("edit") as PlanTool), false);
	assert.equal(canSelectToolInPlanMode(extensionTool("write") as PlanTool), false);
	assert.deepEqual(withRequiredPlanModeTools(["read", "plan_mode_question", "read"]), [
		"read",
		"edit",
		"write",
		"plan_mode_question",
	]);
	assert.deepEqual(withoutPlanModeQuestionTool(["read", "plan_mode_question"]), ["read"]);
});

test("isContextManagementTool recognizes ACP and pi-context tools by name", () => {
	type PlanTool = Parameters<typeof isContextManagementTool>[0];
	for (const name of [
		"compress",
		"decompress",
		"search_context",
		"acp_status",
		"context_checkpoint",
		"context_timeline",
		"context_compact",
	]) {
		assert.equal(isContextManagementTool(extensionTool(name) as PlanTool), true, name);
	}
	assert.equal(isContextManagementTool(builtinTool("read") as PlanTool), false);
	assert.equal(isContextManagementTool(extensionTool("unrelated") as PlanTool), false);
});

test("isDefaultPlanModeTool covers safe tool names, context tools, and read-only defaults", () => {
	type PlanTool = Parameters<typeof isDefaultPlanModeTool>[0];
	assert.equal(isDefaultPlanModeTool(extensionTool("compress") as PlanTool), true);
	assert.equal(isDefaultPlanModeTool(extensionTool("lsp_diagnostics") as PlanTool), true);
	assert.equal(isDefaultPlanModeTool(extensionTool("lsp_fix") as PlanTool), false);
	assert.equal(isDefaultPlanModeTool(extensionTool("unrelated") as PlanTool), false);
	// Delegation and read-only web access are default-on as well, but task-ask is
	// not: pi-tree-like-subagent only exposes it inside a task branch.
	for (const name of ["push-task", "resume-task", "web_search", "web_fetch"]) {
		assert.equal(
			isDefaultPlanModeTool(extensionTool(name) as PlanTool),
			true,
			`${name} is default-on`,
		);
	}
	assert.equal(isDefaultPlanModeTool(extensionTool("task-ask") as PlanTool), false);
	assert.equal(isDefaultPlanModeTool(extensionTool("mcp") as PlanTool), false);
	assert.equal(isDefaultPlanModeTool(extensionTool("ask_user_question") as PlanTool), false);
	// Safe names are matched by name, so an extension that replaces a built-in
	// (pi-fff replaces grep/find) keeps that capability enabled by default.
	assert.equal(isDefaultPlanModeTool(builtinTool("read") as PlanTool), true);
	assert.equal(isDefaultPlanModeTool(extensionTool("grep") as PlanTool), true);
	assert.equal(isDefaultPlanModeTool(extensionTool("find") as PlanTool), true);
	assert.equal(isDefaultPlanModeTool(extensionTool("ls") as PlanTool), true);
	assert.equal(isDefaultPlanModeTool(extensionTool("powershell") as PlanTool), false);
});

test("toolPolicyLabel reports the name-keyed policy for each tool group", () => {
	type PlanTool = Parameters<typeof toolPolicyLabel>[0];
	const extensionLabel = (name: string) => `user/extension ${path.join(os.tmpdir(), name)}`;
	assert.equal(toolPolicyLabel(builtinTool("read") as PlanTool), "built-in");
	assert.equal(toolPolicyLabel(builtinTool("bash") as PlanTool), "built-in limited");
	assert.equal(toolPolicyLabel(builtinTool("powershell") as PlanTool), "built-in blocked");
	assert.equal(toolPolicyLabel(builtinTool("edit") as PlanTool), "built-in plan-file only");
	assert.equal(toolPolicyLabel(extensionTool("compress") as PlanTool), "context management");
	assert.equal(
		toolPolicyLabel(extensionTool("edit") as PlanTool),
		`plan-file only: ${extensionLabel("edit")}`,
		"a shadowed edit is reported as plan-file only, not as user risk",
	);
	// A replaced safe name shows as an extension default instead of disappearing
	// behind a built-in label.
	assert.equal(
		toolPolicyLabel(extensionTool("grep") as PlanTool),
		`extension default: ${extensionLabel("grep")}`,
	);
	assert.equal(
		toolPolicyLabel(extensionTool("powershell") as PlanTool),
		`command filtered: ${extensionLabel("powershell")}`,
		"a shadowed shell is marked as filtered, not as an unbounded user risk",
	);
	assert.equal(
		toolPolicyLabel(extensionTool("bash") as PlanTool),
		`command filtered: ${extensionLabel("bash")}`,
		"a shadowed bash is filtered too, not a plain extension default",
	);
	assert.equal(
		toolPolicyLabel(extensionTool("mcp") as PlanTool),
		`user risk: ${extensionLabel("mcp")}`,
	);
});

test("context-management tools stay active by default in Plan mode", async (t) => {
	const mock = createMockPi({
		activeTools: ["read", "bash", "compress", "context_compact"],
		allTools: [
			builtinTool("read"),
			builtinTool("bash"),
			extensionTool("compress"),
			extensionTool("search_context"),
			extensionTool("context_compact"),
			extensionTool("lsp_diagnostics"),
			extensionTool("lsp_fix"),
			extensionTool("push-task"),
			extensionTool("resume-task"),
			extensionTool("task-ask"),
			extensionTool("web_search"),
			extensionTool("web_fetch"),
			extensionTool("unrelated"),
		],
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

	const active = mock.rawPi.getActiveTools();
	for (const name of ["compress", "search_context", "context_compact", "read", "bash"]) {
		assert.ok(active.includes(name), `${name} should be active in Plan mode by default`);
	}
	assert.ok(active.includes("lsp_diagnostics"), "read-only diagnostics are on by default");
	assert.ok(!active.includes("lsp_fix"), "mutating lsp_fix stays a user-risk opt-in");
	for (const name of ["push-task", "resume-task", "web_search", "web_fetch"]) {
		assert.ok(active.includes(name), `${name} is default-active in Plan mode`);
	}
	assert.ok(
		!active.includes("task-ask"),
		"task-ask stays off: the task plugin enables it inside a branch itself",
	);
	assert.ok(!active.includes("unrelated"), "unrelated extension tool stays disabled");
	assert.ok(active.includes("edit"), "edit stays required for the plan file");
	assert.ok(active.includes("write"), "write stays required for the plan file");
	assert.ok(active.includes("plan_mode_question"));
});

test("safe tool names stay default-active when an extension replaces the built-in", async (t) => {
	// pi-fff registers grep/find itself, so their sourceInfo.source flips from
	// "builtin" to "npm" after session_start. Plan mode keys the safe set on the
	// tool name, so a replaced search tool must stay enabled instead of silently
	// disappearing on the next apply.
	const mock = createMockPi({
		activeTools: ["read", "bash", "grep", "find"],
		allTools: [
			builtinTool("read"),
			builtinTool("bash"),
			extensionTool("grep"),
			extensionTool("find"),
			extensionTool("ls"),
			extensionTool("powershell"),
			extensionTool("unrelated"),
		],
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

	const active = mock.rawPi.getActiveTools();
	for (const name of ["read", "bash", "grep", "find", "ls"]) {
		assert.ok(active.includes(name), `${name} should stay active when an extension provides it`);
	}
	assert.ok(
		!active.includes("powershell"),
		"a shadowed non-safe name stays out of the default set",
	);
	assert.ok(!active.includes("unrelated"), "unrelated extension tool stays disabled");
});

test("tool_call gating also applies to extension tools that take over edit/write/bash", async (t) => {
	// Sandbox and wrapper extensions re-register built-in names; their edit/write
	// must stay locked to the plan file and their bash must still pass the
	// command allowlist, exactly like the built-ins they replace.
	const mock = createMockPi({
		activeTools: ["read", "grep"],
		allTools: [
			extensionTool("read"),
			extensionTool("grep"),
			extensionTool("edit"),
			extensionTool("write"),
			extensionTool("bash"),
			extensionTool("powershell"),
		],
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
		const writePlan = await handler(
			{ toolName: "write", input: { path: "pi_plan.md", content: "# Plan" } },
			ctx,
		);
		assert.equal(writePlan, undefined, "a shadowed write may still target pi_plan.md");

		const editSource = (await handler(
			{ toolName: "edit", input: { path: "src/index.ts", oldText: "a", newText: "b" } },
			ctx,
		)) as { block?: boolean };
		assert.equal(editSource.block, true, "a shadowed edit must not write project files");

		const bashMutating = (await handler(
			{ toolName: "bash", input: { command: "rm -rf build" } },
			ctx,
		)) as { block?: boolean };
		assert.equal(bashMutating.block, true, "a shadowed bash must still be command-filtered");

		const bashReadOnly = await handler(
			{ toolName: "bash", input: { command: "git status --short" } },
			ctx,
		);
		assert.equal(
			bashReadOnly,
			undefined,
			"a read-only command stays allowed through a shadowed bash",
		);

		const powershellMutating = (await handler(
			{ toolName: "powershell", input: { command: "Remove-Item -Recurse -Force build" } },
			ctx,
		)) as { block?: boolean };
		assert.equal(
			powershellMutating.block,
			true,
			"a shadowed powershell must be command-filtered too",
		);

		const powershellReadOnly = await handler(
			{ toolName: "powershell", input: { command: "git status --short" } },
			ctx,
		);
		assert.equal(
			powershellReadOnly,
			undefined,
			"a read-only command stays allowed through a shadowed powershell",
		);
	}
});

test("powershell gating uses the PowerShell allowlist dialect", async (t) => {
	// The POSIX allowlist matches whole command words, so a cmdlet fails every
	// stage while a native form that happens to parse as a POSIX head passes.
	// The powershell tool is judged by its own dialect instead, and that dialect
	// still accepts the POSIX forms because PowerShell runs them too.
	const mock = createMockPi({
		activeTools: ["read", "powershell"],
		allTools: [extensionTool("read"), extensionTool("powershell")],
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
		const run = async (command: string) => {
			const result = await handler({ toolName: "powershell", input: { command } }, ctx);
			return result as { block?: boolean } | undefined;
		};

		for (const command of [
			"Get-ChildItem -Recurse",
			"Get-Content pi_plan.md",
			"Get-Content pi_plan.md | Select-String -Pattern status",
			"Test-Path pi_plan.md",
			"git status --short",
			"cat pi_plan.md",
			"ls",
		]) {
			assert.equal((await run(command))?.block, undefined, `powershell must allow: ${command}`);
		}

		for (const command of [
			"Set-Content -Path pi_plan.md -Value x",
			"Out-File out.txt",
			"Remove-Item -Recurse -Force build",
			"New-Item -ItemType Directory build",
			"Copy-Item a.txt b.txt",
			"Invoke-Expression 'Remove-Item x'",
			"Frobnicate-Thing x",
			"rm -rf build",
			"Get-ChildItem; Remove-Item x",
			"Get-ChildItem $(Get-Location)",
			"Get-Content `$HOME",
			"@'\nRemove-Item x\n'@",
			"Get-ChildItem > out.txt",
			"Get-Content -EncodedCommand VABlAHMAdAA=",
			"Get-Content --% pi_plan.md",
			"Where-Object { Remove-Item x }",
			"& .\\script.ps1",
			". .\\script.ps1",
		]) {
			assert.equal((await run(command))?.block, true, `powershell must block: ${command}`);
		}
	}
});

test("isSafePowerShellCommand keeps the POSIX union and refuses PowerShell mutation", () => {
	assert.equal(isSafePowerShellCommand("Get-ChildItem -Recurse"), true);
	assert.equal(isSafePowerShellCommand("git status --short"), true);
	assert.equal(isSafePowerShellCommand("cat pi_plan.md"), true);
	// The dialect difference: a cmdlet is not a POSIX command word.
	assert.equal(isSafeCommand("Get-ChildItem -Recurse"), false);
	assert.equal(isSafePowerShellCommand("Set-Content -Path x -Value y"), false);
	assert.equal(isSafePowerShellCommand("Get-Credential"), false);
	assert.equal(isSafePowerShellCommand(""), false);
});

test("isSafeCommand permits read-only commands and blocks mutating commands", () => {
	assert.equal(isSafeCommand("git status --short"), true);
	assert.equal(isSafeCommand("sed -n '1,20p' file.ts"), true);
	assert.equal(isSafeCommand("rm -rf build"), false);
	assert.equal(isSafeCommand("npm install"), false);
	assert.equal(isSafeCommand(""), false);
});

test("isSafeCommand allows read-only searches whose patterns mention mutating words", () => {
	assert.equal(isSafeCommand('grep -rn "code" ~/.pi/agent/skills/'), true);
	assert.equal(isSafeCommand("grep -rn npm install ~/.pi/agent/"), true);
	assert.equal(isSafeCommand('grep -rn "rm -rf" docs/'), true);
	assert.equal(isSafeCommand('grep -rn "git push" docs/'), true);
	assert.equal(isSafeCommand('rg -n "vim" ~/.pi/agent/npm/node_modules/'), true);
	assert.equal(isSafeCommand('grep -rn "a > b" .'), true);
	assert.equal(isSafeCommand("grep -rn code ~/.pi/agent/skills/open-code-review"), true);
	assert.equal(isSafeCommand("grep -rn system( src/"), true);
	assert.equal(isSafeCommand("grep -rn '$(x)' docs/"), true);
	assert.equal(isSafeCommand("grep foo ~/.pi 2>&1 | head -20"), true);
	assert.equal(isSafeCommand("cd ~/.pi/agent/skills && grep -rn context ."), true);
	assert.equal(isSafeCommand("find . -name rm"), true);
	assert.equal(isSafeCommand('echo "a;b"'), true);
});

test("isSafeCommand blocks mutations hiding in pipes, redirects, and find flags", () => {
	assert.equal(isSafeCommand("grep -l foo * | xargs rm"), false);
	assert.equal(isSafeCommand("echo hi | bash"), false);
	assert.equal(isSafeCommand("cd / && rm -rf / && git push"), false);
	assert.equal(isSafeCommand("find . -delete"), false);
	assert.equal(isSafeCommand("find . -exec rm {} +"), false);
	assert.equal(isSafeCommand("find . -ok rm {} \\;"), false);
	assert.equal(isSafeCommand("grep foo > out.txt"), false);
	assert.equal(isSafeCommand("grep foo 2> /dev/null"), false);
	assert.equal(isSafeCommand('grep -rn "$(rm -rf /)" .'), false);
	assert.equal(isSafeCommand("grep a\nrm -rf /"), false);
	assert.equal(isSafeCommand("cat <(rm -rf /)"), false);
	assert.equal(isSafeCommand("echo 'rm -rf /' | sh"), false);
	assert.equal(isSafeCommand("git log --grep='npm install' -5"), false);
	assert.equal(isSafeCommand("awk '{system(\"rm -rf /\")}'"), false);
	assert.equal(isSafeCommand("touch new.md"), false);
	assert.equal(isSafeCommand("npm install --save-dev typescript"), false);
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
	assert.ok(sent.includes("Work through the plan step by step"));
	assert.ok(sent.includes("update the plan first and note the deviation"));
	assert.ok(sent.includes("report any deviations from the plan"));
});

test("Implementing a plan larger than PLAN_EMBED_MAX_CHARS points at the file instead of embedding it", async (t) => {
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
		editor: async () => "",
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

	const marker = "LARGE_PLAN_UNIQUE_MARKER_7f3a";
	const largePlan = `# Big change\n\n${marker} ${`detail line\n`.repeat(PLAN_EMBED_MAX_CHARS / 12)}`;
	assert.ok(largePlan.length > PLAN_EMBED_MAX_CHARS);
	fs.writeFileSync(path.join(tmpDir, "pi_plan.md"), largePlan, "utf-8");

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
	assert.ok(sent.includes("Implement the plan in pi_plan.md in the working directory"));
	assert.ok(sent.includes("read it now, then follow it faithfully"));
	assert.ok(
		!sent.includes(marker),
		"a plan above the embed threshold must not be embedded verbatim",
	);
	assert.ok(sent.includes("Plan mode is now disabled. Full tool access is restored."));
	assert.ok(sent.includes("Work through the plan step by step"));
});

test("context hook appends plan adherence reminder while implementing", async (t) => {
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
		editor: async () => "",
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
	for (const handler of agentEndHandlers) {
		await handler(
			{
				messages: [{ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }],
			},
			ctx,
		);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(selectCalls, 1, "implementation should have started");

	const contextHandlers = mock.events.get("context") ?? [];
	assert.ok(contextHandlers.length > 0);

	const runContext = async (lastMessage?: unknown) => {
		let result: { messages: unknown[] } = { messages: [] };
		for (const handler of contextHandlers) {
			result = (await handler(
				{
					messages: [
						{
							message: lastMessage ?? {
								role: "toolResult",
								content: [{ type: "text", text: "tool result" }],
							},
						},
					],
				},
				ctx,
			)) as { messages: unknown[] };
		}
		return result.messages;
	};

	const messages = await runContext();
	assert.equal(messages.length, 2, "one adherence reminder should be appended");
	const last = messages[1] as { message?: { content?: Array<{ type?: string; text?: string }> } };
	const parts = last.message?.content ?? [];
	assert.ok(
		parts.some((part) => part.type === "text" && (part.text ?? "").includes("[plan-adherence]")),
		"the appended message should carry the adherence marker",
	);

	// Reminder keeps being appended on later LLM calls while implementing.
	const messagesAgain = await runContext();
	assert.equal(messagesAgain.length, 2);

	// A user message right before the call gets no reminder: the handoff
	// guidance is already the last word, and stacking user turns pollutes
	// the UI and can trip strict provider role checks.
	const messagesAfterUser = await runContext({
		role: "user",
		content: [{ type: "text", text: "Continue implementing" }],
	});
	assert.equal(messagesAfterUser.length, 1, "no reminder after a fresh user message");

	// An earlier reminder already persisted in the transcript is enough: no
	// second copy is appended on later calls.
	const messagesWithExistingReminder = await runContext({
		role: "toolResult",
		content: [
			{ type: "text", text: "tool result" },
			{ type: "text", text: "[plan-adherence] already injected" },
		],
	});
	assert.equal(messagesWithExistingReminder.length, 1, "no duplicate reminder copies");

	// Deleting the plan file ends the handoff: no more reminders.
	fs.rmSync(path.join(tmpDir, "pi_plan.md"));
	const messagesAfterDelete = await runContext();
	assert.equal(messagesAfterDelete.length, 1, "no reminder once the plan file is gone");
});

test("agent_settled archives the consumed plan only after the completion marker", async (t) => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	let selectCalls = 0;
	const selectValues = ["Implement this plan"];
	const { ctx, notifications } = createMockContext({
		cwd: tmpDir,
		hasUI: true,
		select: async () => selectValues[selectCalls++] ?? undefined,
		editor: async () => "",
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
	for (const handler of agentEndHandlers) {
		await handler(
			{
				messages: [{ message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }],
			},
			ctx,
		);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(selectCalls, 1, "implementation should have started");

	const planPath = path.join(tmpDir, "pi_plan.md");
	assert.ok(fs.existsSync(planPath), "the plan file is still on disk while the handoff is open");

	const agentSettledHandlers = mock.events.get("agent_settled") ?? [];
	const settle = async () => {
		for (const handler of agentSettledHandlers) await handler({}, ctx);
	};
	const contextHandlers = mock.events.get("context") ?? [];
	const runContext = async () => {
		let result: { messages: unknown[] } = { messages: [] };
		for (const handler of contextHandlers) {
			result = (await handler(
				{
					messages: [
						{
							message: {
								role: "toolResult",
								content: [{ type: "text", text: "tool result" }],
							},
						},
					],
				},
				ctx,
			)) as { messages: unknown[] };
		}
		return result.messages;
	};
	const archiveDir = path.join(tmpDir, ".pi", "plan");

	// Settling is not completion: an implementing run ends whenever the model
	// stops calling tools, so the plan stays on disk and the reminder stays
	// active until the model marks the plan done.
	await settle();
	assert.ok(fs.existsSync(planPath), "a settle without the marker must not archive the plan");
	assert.ok(!fs.existsSync(path.join(tmpDir, ".pi")), "no archive directory yet");
	assert.equal((await runContext()).length, 2, "reminders keep anchoring until the marker lands");
	const hints = () => notifications.filter((item) => item.message.includes("Run /plan done"));
	assert.equal(hints().length, 1, "the user is told once why the plan is still on disk");

	// A second marker-less settle stays quiet instead of re-notifying.
	await settle();
	assert.equal(hints().length, 1, "the hint is not repeated on every settle");

	// The model declares completion on the last line of the plan file, sharing
	// that line with its closing words: the next settle archives the consumed
	// plan and the reminders stop.
	fs.appendFileSync(planPath, "\nImplementation finished. <!-- plan-done -->\n", "utf-8");
	await settle();

	assert.ok(fs.existsSync(archiveDir), "archive directory should be created");
	const archivedFiles = fs.readdirSync(archiveDir);
	assert.equal(archivedFiles.length, 1, "the plan should be archived exactly once");
	assert.ok(archivedFiles[0].startsWith("pi_plan-"), "archived file keeps the plan name prefix");
	assert.ok(!fs.existsSync(planPath), "the plan file should be moved away");
	assert.equal((await runContext()).length, 1, "no reminders once the plan is archived");
	assert.ok(
		notifications.some((item) => item.message.includes("marked as implemented and archived under")),
		"the user is told the marked hand-off was archived",
	);

	// A later settle outside the handoff is a no-op: nothing to archive again.
	await settle();
	assert.equal(fs.readdirSync(archiveDir).length, 1, "no duplicate archive entries");
});

test("/plan done archives the plan on demand", async (t) => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	planMode(mock.pi);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const { ctx, notifications } = createMockContext({ cwd: tmpDir, hasUI: true });
	const command = mock.commands.get("plan");
	assert.ok(command);
	const planPath = path.join(tmpDir, "pi_plan.md");
	fs.writeFileSync(planPath, "# Fix bug\n\nSteps here.", "utf-8");

	await command.handler("done", ctx);

	const archiveDir = path.join(tmpDir, ".pi", "plan");
	assert.ok(fs.existsSync(archiveDir), "the manual archive should create the archive directory");
	assert.equal(fs.readdirSync(archiveDir).length, 1, "the plan file should be archived");
	assert.ok(!fs.existsSync(planPath), "the plan file should be moved away");
	assert.ok(
		notifications.some((item) => item.message.includes("archived under")),
		"the user should be told the plan was archived",
	);

	// Nothing left on disk: a second run reports instead of archiving again.
	await command.handler("archive", ctx);
	assert.equal(fs.readdirSync(archiveDir).length, 1, "nothing to archive the second time");
	assert.ok(
		notifications.some((item) => item.message.includes("Nothing to archive")),
		"an empty archive attempt should be reported",
	);
});

test("a new handoff drops a stale completion marker from the plan file", async (t) => {
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
		editor: async () => "",
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

	// The plan still carries a marker from an earlier handoff (the same plan
	// handed off twice, or an archive that failed).
	const planPath = path.join(tmpDir, "pi_plan.md");
	fs.writeFileSync(
		planPath,
		"# Fix bug\n\n- [ ] Step one\n\nImplementation finished. <!-- plan-done -->\n",
		"utf-8",
	);
	// The progress file carries the bracketed variant on a line of its own.
	const progressPath = path.join(tmpDir, "plan.progress.md");
	fs.writeFileSync(progressPath, "- [x] Step one\n\n[plan-done]\n", "utf-8");

	const agentEndHandlers = mock.events.get("agent_end") ?? [];
	for (const handler of agentEndHandlers) await handler({ messages: [] }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(selectCalls, 1, "implementation should have started");

	const handedOff = fs.readFileSync(planPath, "utf-8");
	assert.ok(!handedOff.includes("plan-done"), "a stale marker must not survive the handoff");
	assert.ok(handedOff.includes("Implementation finished."), "the closing words on that line stay");
	assert.ok(handedOff.includes("- [ ] Step one"), "the plan body stays intact");
	const handedOffProgress = fs.readFileSync(progressPath, "utf-8");
	assert.ok(!handedOffProgress.includes("plan-done"), "the progress file is reset as well");
	assert.ok(handedOffProgress.includes("- [x] Step one"), "the progress file body stays intact");

	for (const handler of mock.events.get("agent_settled") ?? []) await handler({}, ctx);
	assert.ok(fs.existsSync(planPath), "the plan stays until the model marks it done again");
});

// Restores an already-running handoff (plan mode off, implementing on) so a
// test can exercise the settle path without the ready-menu handoff flow.
async function restoreHandoff(mock: ReturnType<typeof createMockPi>, cwd: string) {
	const { ctx, notifications } = createMockContext({
		cwd,
		hasUI: true,
		sessionManager: {
			getEntries: () => [
				{
					type: "custom",
					customType: "plan-mode-state",
					data: { enabled: false, implementing: true },
				},
			],
		},
	});
	for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);
	return {
		notifications,
		settle: async () => {
			for (const handler of mock.events.get("agent_settled") ?? []) await handler({}, ctx);
		},
	};
}

test("a marker quoted into the plan body does not end the handoff", async (t) => {
	const mock = createMockPi();
	planMode(mock.pi);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	// The handoff prompt shows the marker, so the model may quote it into the plan.
	const planPath = path.join(tmpDir, "pi_plan.md");
	fs.writeFileSync(
		planPath,
		"# Fix bug\n\nAppend <!-- plan-done --> when finished.\n\n- [x] Step one\n",
		"utf-8",
	);

	const { notifications, settle } = await restoreHandoff(mock, tmpDir);
	await settle();

	assert.ok(fs.existsSync(planPath), "a mid-file marker must not archive the plan");
	assert.ok(!fs.existsSync(path.join(tmpDir, ".pi")), "no archive directory yet");
	assert.ok(
		notifications.some((item) => item.message.includes("Run /plan done")),
		"the ignored settle points the user at /plan done",
	);
});

test("plan.progress.md can declare completion and is archived with the plan", async (t) => {
	const mock = createMockPi();
	planMode(mock.pi);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const planPath = path.join(tmpDir, "pi_plan.md");
	const progressPath = path.join(tmpDir, "plan.progress.md");
	fs.writeFileSync(planPath, "# Fix bug\n\nSteps here.", "utf-8");
	// Bracketed variant, CRLF endings: the last non-empty line declares completion.
	fs.writeFileSync(progressPath, "- [x] Step one\r\nShipped [plan-done]\r\n", "utf-8");

	const { settle } = await restoreHandoff(mock, tmpDir);
	await settle();

	const archived = fs.readdirSync(path.join(tmpDir, ".pi", "plan"));
	assert.equal(archived.length, 2, "the plan and the progress file are archived together");
	assert.ok(
		archived.some((name) => name.startsWith("plan.progress-")),
		"the progress file keeps its name prefix",
	);
	assert.ok(!fs.existsSync(planPath), "the plan file leaves the working tree");
	assert.ok(!fs.existsSync(progressPath), "the progress file leaves the working tree");
});

test("a failed archive keeps the handoff open and warns", async (t) => {
	const mock = createMockPi();
	planMode(mock.pi);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
	t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

	const planPath = path.join(tmpDir, "pi_plan.md");
	fs.writeFileSync(planPath, "# Fix bug\n\n<!-- plan-done -->\n", "utf-8");
	// A file where the archive directory belongs makes mkdirSync fail.
	fs.mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(tmpDir, ".pi", "plan"), "occupied", "utf-8");

	const { notifications, settle } = await restoreHandoff(mock, tmpDir);
	await settle();

	assert.ok(fs.existsSync(planPath), "the plan stays when the archive fails");
	const warnings = () => notifications.filter((item) => item.level === "warning");
	assert.equal(warnings().length, 1, "the failed archive is reported");
	assert.ok(warnings()[0]?.message.includes("Could not archive"), "the warning names the failure");
	assert.ok(
		!notifications.some((item) => item.message.includes("archived under")),
		"no success is reported for a failed archive",
	);

	// Still implementing: the next settle fails the same way instead of going quiet.
	await settle();
	assert.equal(warnings().length, 2, "the handoff stays open after a failed archive");
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
