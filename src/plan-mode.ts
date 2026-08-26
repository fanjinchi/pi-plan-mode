import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

const STATE_ENTRY_TYPE = "plan-mode-state";
const STATUS_KEY = "plan-mode";
const PLAN_WIDGET_KEY = "plan-mode-plan";
const PLAN_CONTEXT_MESSAGE_TYPE = "plan-mode-context";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
const PLAN_CONTEXT_MARKER = "[CODEX-LIKE PLAN MODE ACTIVE]";
const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
const BLOCKED_BUILTIN_TOOLS = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const TOOL_SELECTOR_PAGE_SIZE = 10;
const PLAN_FILE_NAME = "pi_plan.md";
const PLAN_PROGRESS_FILE_NAME = "plan.progress.md";
const PLAN_ADHERENCE_MARKER = "[plan-adherence]";
// Consumed plans are archived under the project-local .pi/ directory (the
// same convention pi uses for .pi/extensions, .pi/skills, .pi/prompts, ...)
// so the working tree stays clean and past plans remain consultable.
const PLAN_ARCHIVE_DIR_NAME = path.join(".pi", "plan");
// Shared step-tracking wording, used both by the one-time handoff message and
// by the per-call adherence reminder so they cannot drift apart.
const PLAN_PROGRESS_TRACKING_INSTRUCTION = `keep the steps checked off as you complete them, marking progress in the plan file itself or in a ${PLAN_PROGRESS_FILE_NAME} beside it`;

// Plans at or below this size are embedded verbatim in the implementation
// message so they act as first-class instructions; larger plans stay on disk
// and the implementing run reads them on demand, so a long implementation does
// not carry the full plan text in context the whole time.
export const PLAN_EMBED_MAX_CHARS = 8000;

// Context-management tools from billion-context-pi (ACP: compress, decompress,
// search_context, acp_status) and pi-context (context_checkpoint, context_timeline,
// context_compact). They only read/rewrite the session conversation, never project
// files or external systems, so Plan mode enables them by default instead of
// requiring a user-risk opt-in. Users can still toggle them off via /plan tools.
const CONTEXT_MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
	"compress",
	"decompress",
	"search_context",
	"acp_status",
	"context_checkpoint",
	"context_timeline",
	"context_compact",
]);

interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

interface PlanModeState {
	enabled: boolean;
	latestPlan?: string;
	awaitingAction: boolean;
	selectedToolNames?: string[];
	selectedToolKeys?: string[];
	// True while an implementation handoff is active: plan mode is off but the
	// plan file still exists, so the context hook keeps re-anchoring the model
	// to the plan.
	implementing: boolean;
}

type SessionEntry = {
	type?: string;
	customType?: string;
	data?: Partial<PlanModeState>;
};

type PlanModeQuestionOption = {
	label: string;
	description?: string;
};

type PlanModeQuestion = {
	id: string;
	header: string;
	question: string;
	options: PlanModeQuestionOption[];
};

type PlanModeQuestionAnswer = {
	id: string;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
};

type PlanModeQuestionReason =
	| "cancelled"
	| "ui_unavailable"
	| "plan_mode_inactive"
	| "invalid_input";

type PlanModeQuestionDetails = {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	questions: PlanModeQuestion[];
	answers?: PlanModeQuestionAnswer[];
};

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "exit", label: "exit", description: "Leave Plan mode" },
	{ value: "off", label: "off", description: "Leave Plan mode" },
	{ value: "tools", label: "tools", description: "Select tools allowed in Plan mode" },
];

const PLAN_MODE_QUESTION_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			description: "Questions to show the user. Prefer 1 and do not exceed 3.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "header", "question", "options"],
				properties: {
					id: {
						type: "string",
						description: "Stable identifier for mapping answers (snake_case).",
					},
					header: {
						type: "string",
						description: "Short header label shown in the UI (12 or fewer chars).",
					},
					question: {
						type: "string",
						description: "Single-sentence prompt shown to the user.",
					},
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						description:
							"Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["label", "description"],
							properties: {
								label: {
									type: "string",
									description: "User-facing label (1-5 words).",
								},
								description: {
									type: "string",
									description: "One short sentence explaining impact/tradeoff if selected.",
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

const MUTATING_BASH_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish|version)\b/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish|update)\b/i,
	/\bbun\s+(add|remove|install|update|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\buv\s+(add|remove|sync|lock|pip\s+install)\b/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i,
	/\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
	/\b(?:bash|zsh|fish|ksh|dash|csh|tcsh|pwsh)\b/i,
	/\bsystem\s*\(/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_BASH_PATTERNS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|jq|awk|rg|fd|bat|eza)\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*cd\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|grep)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(node|python|python3|npm|tsc|biome|ruff|ty)\s+--version\b/i,
];

// Commands that are read-only by construction: they can neither write files nor
// execute other programs on their own. For these, search patterns and arguments
// are inert, so the mutating-keyword list below is skipped entirely — "grep -rn
// "rm -rf" ." or "grep -rn code docs/" are legitimate searches and must not be
// blocked just because the searched text resembles a mutating command.
const PURE_READ_BASH_COMMANDS: ReadonlySet<string> = new Set([
	"cat",
	"head",
	"tail",
	"less",
	"more",
	"grep",
	"rg",
	"ag",
	"ls",
	"pwd",
	"wc",
	"sort",
	"uniq",
	"diff",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"which",
	"whereis",
	"type",
	"ps",
	"jq",
	"fd",
	"bat",
	"eza",
]);

export default function planMode(pi: ExtensionAPI) {
	let state: PlanModeState = { enabled: false, awaitingAction: false, implementing: false };
	let previousTools: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in Codex-like Plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: PLAN_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return planModeQuestionCancelled(
					[],
					"plan_mode_inactive",
					"Error: plan_mode_question is only available while Plan mode is active.",
				);
			}

			const parsed = normalizePlanModeQuestionParams(params);
			if (!parsed.ok) {
				return planModeQuestionCancelled([], "invalid_input", `Error: ${parsed.error}`);
			}

			if (!ctx.hasUI) {
				return planModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Plan-mode questions because interactive UI is not available.",
				);
			}

			const answers = await askPlanModeQuestions(parsed.questions, ctx);
			if (!answers) {
				return planModeQuestionCancelled(
					parsed.questions,
					"cancelled",
					"User cancelled the Plan-mode question prompt.",
				);
			}

			return planModeQuestionAnswered(parsed.questions, answers);
		},
	});

	pi.registerCommand("plan", {
		description: "Enter or manage Codex-like Plan mode",
		getArgumentCompletions: completePlanArguments,
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "exit" || command === "off") {
				exitPlanMode(ctx);
				ctx.ui.notify(`Plan mode disabled. ${PLAN_FILE_NAME} kept on disk.`, "info");
				return;
			}
			if (command === "tools") {
				if (!state.enabled) enterPlanMode(ctx);
				await showToolSelector(ctx);
				return;
			}
			if (prompt) {
				enterPlanModeWithPrompt(prompt, ctx);
				return;
			}
			if (!state.enabled) {
				enterPlanMode(ctx);
				ctx.ui.notify(
					`Plan mode enabled. I will explore and write the plan to ${PLAN_FILE_NAME}, but not modify project files.`,
					"info",
				);
				return;
			}
			await showPlanMenu(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		restoreState(ctx);
		if (pi.getFlag("plan") === true) state.enabled = true;
		if (state.enabled) {
			activatePlanModeTools();
			syncPlanFromFile(ctx);
		} else deactivatePlanModeQuestionTool();
		updateUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persistState();
		clearUi(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) return;
		if (isBlockedBuiltinToolName(event.toolName)) {
			if (isPlanFileTarget(ctx.cwd, event.input)) return;
			return {
				block: true,
				reason: `Plan mode only allows writing to ${PLAN_FILE_NAME} in the working directory. Use /plan and choose implementation when the plan is ready.`,
			};
		}
		if (event.toolName !== "bash" || !isBuiltinToolName(event.toolName)) return;

		const command = readCommand(event.input);
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode blocks mutating or non-allowlisted bash commands.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event, ctx) => {
		const messagesWithoutLegacyPlanContext = event.messages.filter(
			(message: unknown) => !messageContainsLegacyPlanModeContextArtifact(message),
		);
		if (state.enabled) return { messages: messagesWithoutLegacyPlanContext };

		let messages = messagesWithoutLegacyPlanContext.filter(
			(message: unknown) => !messageContainsInactivePlanModeArtifact(message),
		);

		if (state.implementing) {
			const cwd = ctx.cwd;
			if (typeof cwd !== "string") return { messages };
			try {
				if (!fs.existsSync(planFilePath(cwd))) {
					// The plan file is gone, so the implementation handoff is over.
					state = { ...state, implementing: false };
					persistState();
				} else {
					// Keep the plan prominent during implementation: re-anchor the
					// model on every LLM call (like Claude Code's per-message
					// plan-mode injection), so long sessions do not drift away
					// from the plan.
					messages = withPlanAdherenceReminder(messages) as typeof event.messages;
				}
			} catch {
				// Unreadable plan path: skip the injection rather than breaking
				// the whole context event.
			}
		}
		return { messages };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled) return;
		syncPlanFromFile(ctx);
		applyPlanModeTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		// Archiving happens on agent_settled, not here: after agent_end pi may
		// still retry, auto-compact, or run queued follow-ups, and the plan file
		// must stay in place while pi can still keep implementing.
		if (!state.enabled) return;

		const previous = state.latestPlan;
		const plan = readPlanFile(ctx.cwd);
		if (plan) {
			state = { ...state, latestPlan: plan, awaitingAction: true };
		} else {
			state = { ...state, latestPlan: undefined, awaitingAction: false };
		}
		persistState();
		updateUi(ctx);

		if (!plan || plan === previous) return;

		scheduleAfterCurrentAgentRun(async () => {
			if (!state.enabled || state.latestPlan !== plan) return;
			if (ctx.hasUI) await showPlanReadyMenu(ctx);
			if (!state.enabled || state.latestPlan !== plan) return;

			pi.sendMessage(
				{
					customType: PROPOSED_PLAN_MESSAGE_TYPE,
					content: `**Proposed Plan**\n\n${plan}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Fired only when pi will not automatically continue (no retry,
		// auto-compaction, or queued follow-up pending): the implementing
		// phase has settled, so the consumed plan is archived and the
		// adherence reminders stop. A settled handoff counts as consumed even
		// on interruption — the archive under .pi/plan/ is the recoverable
		// backup for that case.
		if (state.enabled || !state.implementing) return;
		archivePlanFile(ctx);
		state = { ...state, implementing: false };
		persistState();
	});

	function enterPlanMode(ctx: ExtensionContext) {
		if (!state.enabled) previousTools = withoutPlanModeQuestionTool(safeGetActiveTools());
		state = { ...state, enabled: true, awaitingAction: false, implementing: false };
		activatePlanModeTools();
		persistState();
		updateUi(ctx);
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		enterPlanMode(ctx);
		if (!wasEnabled) {
			ctx.ui.notify(
				`Plan mode enabled. I will explore and write the plan to ${PLAN_FILE_NAME}, but not modify project files.`,
				"info",
			);
		}
		sendPlanModeUserMessage(prompt, ctx);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		// Leaving plan mode also ends any active implementation handoff, so a
		// /plan exit stops the adherence reminders even while pi_plan.md is
		// still on disk. startImplementation calls this before setting
		// implementing: true, so the ordering stays safe.
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			awaitingAction: false,
			implementing: false,
		};
		if (wasEnabled) restoreTools();
		persistState();
		updateUi(ctx);
	}

	function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	function scheduleAfterCurrentAgentRun(task: () => Promise<void> | void) {
		setTimeout(() => {
			void Promise.resolve(task()).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`Plan mode follow-up failed: ${message}`);
			});
		}, 0);
	}

	function startImplementation(ctx: ExtensionContext, extraInput?: string) {
		const planFromFile = readPlanFile(ctx.cwd);
		const plan = planFromFile ?? state.latestPlan?.trim();
		exitPlanMode(ctx);

		if (!plan) {
			ctx.ui.notify("Plan mode disabled. No proposed plan is available to implement.", "warning");
			return;
		}

		const extra = extraInput ? `\n\nAdditional instructions from user:\n${extraInput}` : "";
		// Small plans are embedded verbatim so they act as first-class
		// instructions; larger plans stay on disk and the implementing run reads
		// them on demand, so a long implementation does not carry the full plan
		// text in context the whole time.
		// Pointing at a file only works when that file really exists; if the plan
		// lives only in memory (file deleted or never written), embed it so the
		// implementing run never gets told to read a nonexistent file.
		const planOnDisk = planFromFile !== undefined;
		const planInstruction =
			planOnDisk && plan.length > PLAN_EMBED_MAX_CHARS
				? `Implement the plan in ${PLAN_FILE_NAME} in the working directory: read it now, then follow it faithfully, and re-read it whenever you need to check the exact steps.`
				: `Implement this proposed plan now:\n\n${plan}`;
		// Step-tracking + deviation handling: turns the plan into a checklist the
		// model marks off as it goes and forces plan-first changes (Codex/Cursor
		// style), plus a closing deviation report (Codex receipt style).
		const adherenceGuidance = `\n\nWork through the plan step by step and ${PLAN_PROGRESS_TRACKING_INSTRUCTION}. If a step needs to change, update the plan first and note the deviation and why, then continue. When you are done, report any deviations from the plan and anything left unfinished. When the implementing phase ends, ${PLAN_FILE_NAME} is archived under ${PLAN_ARCHIVE_DIR_NAME} for reference.`;
		sendPlanModeUserMessage(
			`Plan mode is now disabled. Full tool access is restored. ${planInstruction}${adherenceGuidance}${extra}`,
			ctx,
		);

		// Only file-based handoffs get the per-call reminder lifecycle: the
		// reminder anchors on pi_plan.md's presence, while memory-only plans
		// are embedded verbatim and need no re-anchoring. The flag is set
		// after the send so a throwing send cannot leave a stuck handoff.
		if (planOnDisk) {
			state = { ...state, implementing: true };
			persistState();
		}
	}

	async function confirmStartImplementation(ctx: ExtensionContext): Promise<boolean> {
		if (!ctx.hasUI) {
			startImplementation(ctx);
			return true;
		}

		const extraInput = await ctx.ui.editor(
			"Add any extra implementation instructions (optional). Leave blank to proceed with the plan as-is.",
			"",
		);
		if (extraInput === undefined) return false;

		startImplementation(ctx, extraInput.trim());
		return true;
	}

	async function showPlanMenu(ctx: ExtensionContext) {
		syncPlanFromFile(ctx);
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}

		const choices = state.latestPlan
			? [
					"Show latest proposed plan",
					"Implement this plan",
					"Configure Plan-mode tools",
					"Stay in Plan mode",
					"Exit Plan mode",
				]
			: ["Configure Plan-mode tools", "Stay in Plan mode", "Exit Plan mode"];
		const choice = await ctx.ui.select(planStatusText(), choices);
		if (choice === "Show latest proposed plan") {
			ctx.ui.notify(state.latestPlan ?? "No proposed plan yet.", "info");
			return;
		}
		if (choice === "Implement this plan") {
			const proceeded = await confirmStartImplementation(ctx);
			if (!proceeded) await showPlanMenu(ctx);
			return;
		}
		if (choice === "Configure Plan-mode tools") {
			await showToolSelector(ctx);
			return;
		}
		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify(`Plan mode disabled. ${PLAN_FILE_NAME} kept on disk.`, "info");
			return;
		}
		updateUi(ctx);
	}

	async function showPlanReadyMenu(ctx: ExtensionContext) {
		const choice = await ctx.ui.select("Proposed plan ready. What next?", [
			"Implement this plan",
			"Stay in Plan mode",
			"Exit Plan mode",
		]);
		if (choice === "Implement this plan") {
			const proceeded = await confirmStartImplementation(ctx);
			if (!proceeded) await showPlanReadyMenu(ctx);
			return;
		}
		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify(`Plan mode disabled. ${PLAN_FILE_NAME} kept on disk.`, "info");
		}
	}

	async function showToolSelector(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(formatToolSummary(), "info");
			return;
		}

		let pageIndex = 0;
		while (true) {
			const tools = selectableTools();
			const pageCount = toolSelectorPageCount(tools);
			pageIndex = Math.min(pageIndex, pageCount - 1);
			const pageStart = pageIndex * TOOL_SELECTOR_PAGE_SIZE;
			const pageTools = tools.slice(pageStart, pageStart + TOOL_SELECTOR_PAGE_SIZE);
			const selectedNames = planModeSelectedNames(tools);
			const choices = pageTools.map((tool, index) =>
				formatToolChoice(tool, selectedNames.has(tool.name), pageStart + index),
			);
			const previousChoice = "Previous page";
			const nextChoice = "Next page";
			const doneChoice = "Done";
			const navigationChoices = [
				...(pageIndex > 0 ? [previousChoice] : []),
				...(pageIndex < pageCount - 1 ? [nextChoice] : []),
				doneChoice,
			];
			const choice = await ctx.ui.select(
				`Plan-mode tools (${pageIndex + 1}/${pageCount}). Context-management tools are on by default; other non-built-in tools run at user risk.`,
				[...choices, ...navigationChoices],
			);
			if (!choice || choice === doneChoice) break;
			if (choice === previousChoice) {
				pageIndex = Math.max(0, pageIndex - 1);
				continue;
			}
			if (choice === nextChoice) {
				pageIndex = Math.min(pageCount - 1, pageIndex + 1);
				continue;
			}

			const selectedIndex = choices.indexOf(choice);
			const tool = pageTools[selectedIndex];
			if (!tool) continue;
			if (!canSelectToolInPlanMode(tool)) {
				ctx.ui.notify(`${tool.name} is blocked in Plan mode.`, "warning");
				continue;
			}

			const nextSelectedNames = planModeSelectedNames(tools);
			if (nextSelectedNames.has(tool.name)) nextSelectedNames.delete(tool.name);
			else nextSelectedNames.add(tool.name);

			state = {
				...state,
				selectedToolNames: filterAvailableSelectedNames(Array.from(nextSelectedNames), tools),
			};
			applyPlanModeTools();
			persistState();
			updateUi(ctx);
		}

		applyPlanModeTools();
		persistState();
		updateUi(ctx);
	}

	function activatePlanModeTools() {
		previousTools ??= withoutPlanModeQuestionTool(safeGetActiveTools());
		applyPlanModeTools();
	}

	function applyPlanModeTools() {
		pi.setActiveTools(planModeToolNames());
	}

	function planModeToolNames() {
		const tools = selectableTools();
		if (tools.length === 0) return ["read", "bash", "edit", "write", PLAN_MODE_QUESTION_TOOL_NAME];

		const selectedNames = planModeSelectedNames(tools);
		return withRequiredPlanModeTools(
			tools
				.filter((tool) => selectedNames.has(tool.name) && canSelectToolInPlanMode(tool))
				.map((tool) => tool.name),
		);
	}

	function planModeSelectedNames(tools: ToolInfo[]) {
		const selectedToolNames = state.selectedToolNames ?? migrateSelectedToolKeys(tools);
		if (selectedToolNames === undefined) return new Set(defaultPlanModeToolNames(tools));

		state = {
			...state,
			selectedToolNames: filterAvailableSelectedNames(selectedToolNames, tools),
			selectedToolKeys: undefined,
		};
		return new Set(state.selectedToolNames);
	}

	function defaultPlanModeToolNames(tools: ToolInfo[]) {
		return tools
			.filter(
				(tool) =>
					(isBuiltinTool(tool) && SAFE_BUILTIN_PLAN_TOOLS.has(tool.name)) ||
					isContextManagementTool(tool),
			)
			.map((tool) => tool.name);
	}

	function migrateSelectedToolKeys(tools: ToolInfo[]) {
		if (state.selectedToolKeys === undefined) return undefined;
		return state.selectedToolKeys
			.map((key) => toolNameFromLegacyKey(key, tools))
			.filter((name): name is string => name !== undefined);
	}

	function filterAvailableSelectedNames(names: string[], tools: ToolInfo[]) {
		const availableNames = new Set(tools.filter(canSelectToolInPlanMode).map((tool) => tool.name));
		return unique(names.filter((name) => availableNames.has(name)));
	}

	function selectableTools() {
		return safeGetAllTools()
			.filter((tool) => tool.name !== PLAN_MODE_QUESTION_TOOL_NAME)
			.sort(compareTools);
	}

	function toolSelectorPageCount(tools: ToolInfo[]) {
		return Math.max(1, Math.ceil(tools.length / TOOL_SELECTOR_PAGE_SIZE));
	}

	function safeGetAllTools() {
		try {
			return pi.getAllTools();
		} catch {
			return [];
		}
	}

	function restoreTools() {
		const restoredTools = previousTools && previousTools.length > 0 ? previousTools : DEFAULT_TOOLS;
		pi.setActiveTools(withoutPlanModeQuestionTool(restoredTools));
		previousTools = undefined;
	}

	function deactivatePlanModeQuestionTool() {
		const activeTools = safeGetActiveTools();
		const filteredTools = withoutPlanModeQuestionTool(activeTools);
		if (filteredTools.length !== activeTools.length) {
			pi.setActiveTools(filteredTools);
		}
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return DEFAULT_TOOLS;
		}
	}

	function persistState() {
		pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, state);
	}

	function restoreState(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries() as SessionEntry[];
		const entry = entries
			.filter(
				(candidate) => candidate.type === "custom" && candidate.customType === STATE_ENTRY_TYPE,
			)
			.pop();
		if (!entry?.data) return;
		const enabled = entry.data.enabled ?? false;
		state = {
			enabled,
			latestPlan: enabled ? entry.data.latestPlan : undefined,
			awaitingAction: enabled ? (entry.data.awaitingAction ?? false) : false,
			selectedToolNames: entry.data.selectedToolNames,
			selectedToolKeys: entry.data.selectedToolKeys,
			implementing: entry.data.implementing ?? false,
		};
	}

	function syncPlanFromFile(ctx: ExtensionContext) {
		const plan = readPlanFile(ctx.cwd);
		if (plan !== state.latestPlan) {
			state = { ...state, latestPlan: plan, awaitingAction: !!plan };
			persistState();
			updateUi(ctx);
		}
	}

	function updateUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, formatStatus());
		if (state.enabled && state.latestPlan) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				"Proposed plan ready",
				"Use /plan to implement, revise, or exit Plan mode.",
			]);
		} else if (state.enabled) {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, [
				"Plan mode: planning",
				formatToolSummary(),
				`Write the plan to ${PLAN_FILE_NAME}.`,
			]);
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}
	}

	function formatStatus() {
		if (!state.enabled) return undefined;
		if (state.awaitingAction || state.latestPlan) return "plan ready";
		return "plan active";
	}

	function clearUi(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
	}

	function planStatusText() {
		if (!state.enabled) return "Plan mode is off.";
		if (state.latestPlan)
			return `Plan mode is active and a proposed plan is ready. ${formatToolSummary()}`;
		return `Plan mode is active. ${formatToolSummary()} Explore, ask, and write the plan to ${PLAN_FILE_NAME}.`;
	}

	function formatToolSummary() {
		const names = planModeToolNames();
		return `Tools: ${names.length > 0 ? names.join(", ") : "none"}`;
	}

	function isBlockedBuiltinToolName(toolName: string) {
		if (!BLOCKED_BUILTIN_TOOLS.has(toolName)) return false;
		const tool = toolByName(toolName);
		return tool ? isBuiltinTool(tool) : true;
	}

	function isBuiltinToolName(toolName: string) {
		const tool = toolByName(toolName);
		return tool ? isBuiltinTool(tool) : toolName === "bash";
	}

	function toolByName(toolName: string) {
		return safeGetAllTools().find((candidate) => candidate.name === toolName);
	}
}

function isBuiltinTool(tool: ToolInfo) {
	return tool.sourceInfo.source === "builtin";
}

export function completePlanArguments(argumentPrefix: string): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;

	const matches = PLAN_COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(prefix));
	return matches.length > 0 ? [...matches] : null;
}

export function canSelectToolInPlanMode(tool: ToolInfo) {
	if (isBuiltinTool(tool)) return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name);
	return true;
}

export function isContextManagementTool(tool: ToolInfo) {
	return CONTEXT_MANAGEMENT_TOOL_NAMES.has(tool.name);
}

function toolNameFromLegacyKey(key: string, tools: ToolInfo[]) {
	const directName = tools.find((tool) => tool.name === key)?.name;
	if (directName) return directName;
	const [name] = key.split("\u001f");
	return tools.find((tool) => tool.name === name) ? name : undefined;
}

function compareTools(left: ToolInfo, right: ToolInfo) {
	const leftBuiltin = isBuiltinTool(left);
	const rightBuiltin = isBuiltinTool(right);
	if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
	return left.name.localeCompare(right.name);
}

function formatToolChoice(tool: ToolInfo, selected: boolean, index: number) {
	const marker = selected ? "[x]" : "[ ]";
	return `${marker} ${index + 1}. ${tool.name} (${toolPolicyLabel(tool)})`;
}

function toolPolicyLabel(tool: ToolInfo) {
	if (isContextManagementTool(tool)) return "context management";
	if (isBuiltinTool(tool)) {
		if (!SAFE_BUILTIN_PLAN_TOOLS.has(tool.name)) {
			if (tool.name === "edit" || tool.name === "write") return "built-in plan-file only";
			return "built-in blocked";
		}
		return tool.name === "bash" ? "built-in limited" : "built-in";
	}
	return `user risk: ${toolSourceLabel(tool)}`;
}

function toolSourceLabel(tool: ToolInfo) {
	const sourceInfo = tool.sourceInfo;
	const source = `${sourceInfo.scope}/${sourceInfo.source}`;
	return sourceInfo.path ? `${source} ${sourceInfo.path}` : source;
}

function unique(values: string[]) {
	return Array.from(new Set(values));
}

export function withRequiredPlanModeTools(toolNames: string[]) {
	return unique([
		...withoutPlanModeQuestionTool(toolNames),
		"edit",
		"write",
		PLAN_MODE_QUESTION_TOOL_NAME,
	]);
}

export function withoutPlanModeQuestionTool(toolNames: string[]) {
	return toolNames.filter((toolName) => toolName !== PLAN_MODE_QUESTION_TOOL_NAME);
}

type NormalizePlanModeQuestionParamsResult =
	| { ok: true; questions: PlanModeQuestion[] }
	| { ok: false; error: string };

export function normalizePlanModeQuestionParams(
	input: unknown,
): NormalizePlanModeQuestionParamsResult {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false, error: "questions must contain 1-3 items" };
	}

	const questions: PlanModeQuestion[] = [];
	for (const [questionIndex, rawQuestion] of input.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			return {
				ok: false,
				error: `question ${questionIndex + 1} must be an object`,
			};
		}

		const id = stringField(rawQuestion.id);
		const header = stringField(rawQuestion.header);
		const question = stringField(rawQuestion.question);
		if (!id || !header || !question) {
			return {
				ok: false,
				error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
			};
		}

		if (!Array.isArray(rawQuestion.options)) {
			return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
		}
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return {
				ok: false,
				error: `question ${questionIndex + 1} options must contain 2-4 items`,
			};
		}

		const options: PlanModeQuestionOption[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
			if (!isRecord(rawOption)) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
				};
			}

			const label = stringField(rawOption.label);
			if (!label) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
				};
			}
			const description = stringField(rawOption.description);
			if (!description) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
				};
			}
			options.push({ label, description });
		}
		questions.push({ id, header, question, options });
	}

	return { ok: true, questions };
}

async function askPlanModeQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
): Promise<PlanModeQuestionAnswer[] | undefined> {
	const answers: PlanModeQuestionAnswer[] = [];
	for (const question of questions) {
		const choices = question.options.map(formatPlanModeQuestionChoice);
		const otherChoice = `${question.options.length + 1}. Other (free-form)`;
		const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [
			...choices,
			otherChoice,
		]);
		if (!choice) return undefined;

		if (choice === otherChoice) {
			const customAnswer = (await ctx.ui.editor(question.question, ""))?.trim();
			if (!customAnswer) return undefined;
			answers.push({
				id: question.id,
				header: question.header,
				question: question.question,
				answer: customAnswer,
				wasCustom: true,
			});
			continue;
		}

		const optionIndex = choices.indexOf(choice);
		const option = question.options[optionIndex];
		if (!option) return undefined;
		answers.push({
			id: question.id,
			header: question.header,
			question: question.question,
			answer: option.label,
			wasCustom: false,
			optionIndex: optionIndex + 1,
		});
	}
	return answers;
}

function formatPlanModeQuestionChoice(option: PlanModeQuestionOption, index: number) {
	return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

function planModeQuestionAnswered(
	questions: PlanModeQuestion[],
	answers: PlanModeQuestionAnswer[],
) {
	return {
		content: [
			{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers }) },
		],
		details: { cancelled: false, questions, answers } satisfies PlanModeQuestionDetails,
	};
}

function planModeQuestionCancelled(
	questions: PlanModeQuestion[],
	reason: PlanModeQuestionReason,
	message: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: formatPlanModeQuestionPayload({ cancelled: true, reason, message }),
			},
		],
		details: { cancelled: true, reason, questions } satisfies PlanModeQuestionDetails,
	};
}

function formatPlanModeQuestionPayload(payload: {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	message?: string;
	answers?: PlanModeQuestionAnswer[];
}) {
	return JSON.stringify(payload, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
	return typeof value === "string" ? value.trim() : undefined;
}

function buildPlanModePrompt() {
	return `${PLAN_CONTEXT_MARKER}
# Plan Mode (Conversational)

You are in Plan Mode, a Codex-like collaboration mode for producing a decision-complete implementation plan. Chat your way to the plan before finalizing it. A final plan must leave no implementation decisions unresolved.

## Mode rules

- Stay in Plan Mode until a developer or extension explicitly exits it.
- Treat requests to implement as requests to plan the implementation; do not edit project files or carry out the plan.
- Do not use update_plan/TODO tooling in Plan Mode; Plan Mode is conversational planning, not execution progress tracking.
- Plan Mode manages built-in tool safety only. Context-management tools (billion-context-pi: \`compress\`, \`decompress\`, \`search_context\`, \`acp_status\`; pi-context: \`context_checkpoint\`, \`context_timeline\`, \`context_compact\`) stay enabled by default; all other non-built-in tools are disabled by default and may be enabled by the user at their own risk.
- Do not perform mutating actions on project files: no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.
- The only writable file in Plan Mode is \`${PLAN_FILE_NAME}\` in the working directory. Use it as the plan document: create it with \`write\` or update it with \`edit\`.

## Phase 1 — Ground in the environment

- Explore first and ask second. Use non-mutating exploration to read files, search, inspect configuration, run read-only checks, and resolve discoverable facts.
- Keep the session lean while planning: use the enabled context-management tools (\`compress\`, \`search_context\`, \`decompress\`, \`context_checkpoint\`, \`context_timeline\`) to fold consumed exploration and anchor phases instead of letting context grow unmanaged.
- Before asking the user any question, perform at least one targeted non-mutating exploration pass unless no local environment or repository is available.
- Do not ask questions that can be answered from repository or system truth. Ask only when multiple plausible choices remain, a needed identifier/context is missing, or the ambiguity is product intent.

## Phase 2 — Intent chat

- Keep asking until you can clearly state the goal, success criteria, in/out of scope, constraints, current state, and key preferences/tradeoffs.
- Bias toward questions over guessing: if a high-impact ambiguity remains, do not produce a proposed plan yet.

## Phase 3 — Implementation chat

- Once intent is stable, keep asking until the spec is decision-complete: approach, interfaces, data flow, edge cases/failure modes, testing and acceptance criteria, and any migration or compatibility constraints.
- Use plan_mode_question for important preferences, tradeoffs, or assumption locks that cannot be discovered by non-mutating exploration. Ask 1-3 concise questions with 2-4 meaningful options. Do not include filler options.
- If plan_mode_question returns cancelled or ui_unavailable, do not jump straight to a final plan when the missing answer is high impact. Ask one concise plain-text question or proceed only with a clearly stated low-risk assumption.

## Finalization rule

Only write the final plan when it is decision-complete and leaves no decisions to the implementer. Write the complete plan to \`${PLAN_FILE_NAME}\` (use \`write\` to create/rewrite, \`edit\` for targeted updates) with this structure:

- # Title
- ## Summary
- ## Key Changes
- ## Test Plan
- ## Assumptions

After writing the plan, reply with only a brief chat summary; do not paste the full plan back into the chat. Do not ask "should I proceed?" — the Plan-mode ready menu handles next steps.

## Revision rule

When the user gives feedback on an existing plan, ask clarifying questions first if high-impact ambiguity remains. Otherwise update \`${PLAN_FILE_NAME}\` so it always reflects the latest agreed plan.`;
}

function readCommand(input: unknown) {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

export function isSafeCommand(command: string) {
	const trimmed = command.trim();
	if (!trimmed) return false;

	// Treat newlines as command separators so a second line cannot smuggle a
	// mutating command past the per-segment allowlist check.
	const singleLine = trimmed.replace(/\n+/g, "; ");

	// Strip quoted strings: words inside quotes are search patterns or text, not
	// commands to execute ("grep -rn 'rm -rf' ." must be allowed).
	const unquoted = singleLine.replace(/"[^"]*"|'[^']*'/g, " ");

	// Command substitution expands inside double quotes and unquoted, but not
	// inside single quotes — so strip only single-quoted strings for this check.
	const noSingleQuotes = singleLine.replace(/'[^']*'/g, " ");
	if (/\$\(|`/.test(noSingleQuotes)) return false;

	// Redirects write files; block every unquoted one except harmless fd-to-fd
	// forms like 2>&1 ("grep foo 2>&1 | head" is read-only). Heredocs (<<, <<<)
	// and process substitution (<(...)) are blocked because their bodies can
	// smuggle arbitrary commands.
	const noFdRedirs = unquoted.replace(/\b[012]>&[012]\b/g, "");
	if (/(^|[^<])>(?!>)|>>|<<|<\s*\(/.test(noFdRedirs)) return false;

	// Every pipeline stage / ; / && / || branch must independently pass the
	// allowlist. This stops "grep foo | xargs rm", "echo hi | bash",
	// "cd / && rm -rf /" and friends from hiding behind a read-only first word.
	const segments = splitShellSegments(singleLine);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		if (!SAFE_BASH_PATTERNS.some((pattern) => pattern.test(segment))) return false;

		const head = firstCommandWord(segment);
		if (!head || PURE_READ_BASH_COMMANDS.has(head)) continue;

		// find can mutate via -delete/-exec/-ok; other flags are read-only, so a
		// search for a file named "rm" must not trip the keyword list.
		if (head === "find") {
			if (/\s-(?:delete|exec|ok)\b/i.test(segment)) return false;
			continue;
		}

		// Non-pure-read heads (echo, printf, awk, sed, git, npm, env, ...) are
		// checked against the mutating keywords on the full segment text (quotes
		// intact) — e.g. awk '{system("rm -rf /")}' stays blocked.
		const segmentNoFdRedirs = segment.replace(/\b[012]>&[012]\b/g, "");
		if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(segmentNoFdRedirs))) return false;
	}
	return true;
}

// Splits a command on unquoted separators (|, ;, &&, ||), so quoted search
// patterns like "a;b" or "x | y" do not produce phantom segments.
function splitShellSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "|" || ch === ";") {
			segments.push(current);
			current = "";
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			segments.push(current);
			current = "";
			i++;
			continue;
		}
		current += ch;
	}
	segments.push(current);
	return segments;
}

function firstCommandWord(segment: string): string | undefined {
	const match = /^\s*([A-Za-z_][A-Za-z0-9_+-]*)/.exec(segment);
	return match?.[1]?.toLowerCase();
}

export function planFilePath(cwd: string): string {
	return path.join(cwd, PLAN_FILE_NAME);
}

export function readPlanFile(cwd: string): string | undefined {
	try {
		const content = fs.readFileSync(planFilePath(cwd), "utf-8").trim();
		return content || undefined;
	} catch {
		return undefined;
	}
}

function archivePlanFile(ctx: ExtensionContext) {
	// Guard before any path math: path.join on a non-string cwd would throw
	// outside the try/catch below.
	if (typeof ctx.cwd !== "string") return;
	try {
		const planPath = planFilePath(ctx.cwd);
		const progressPath = path.join(ctx.cwd, PLAN_PROGRESS_FILE_NAME);
		if (!fs.existsSync(planPath) && !fs.existsSync(progressPath)) return;
		fs.mkdirSync(path.join(ctx.cwd, PLAN_ARCHIVE_DIR_NAME), { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		// Archive the plan file and, if the model created one, the progress
		// file beside it, so the working tree stays clean after implementation.
		for (const [sourcePath, prefix] of [
			[planPath, PLAN_FILE_NAME],
			[progressPath, PLAN_PROGRESS_FILE_NAME],
		] as const) {
			if (!fs.existsSync(sourcePath)) continue;
			const archivedPath = path.join(
				ctx.cwd,
				PLAN_ARCHIVE_DIR_NAME,
				`${prefix.replace(/\.md$/, "")}-${stamp}.md`,
			);
			fs.renameSync(sourcePath, archivedPath);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Plan mode archive failed: ${message}`);
	}
}

export function isPlanFileTarget(cwd: string, input: unknown): boolean {
	if (!isRecord(input)) return false;
	const p = input.path;
	if (typeof p !== "string") return false;
	if (path.resolve(cwd, p) !== path.resolve(cwd, PLAN_FILE_NAME)) return false;
	try {
		// Refuse to write through a symlinked plan file; a missing file is fine (creation).
		return !fs.lstatSync(planFilePath(cwd)).isSymbolicLink();
	} catch {
		return true;
	}
}

function messageContainsLegacyPlanModeContextArtifact(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return candidate.customType === PLAN_CONTEXT_MESSAGE_TYPE;
}

function messageContainsInactivePlanModeArtifact(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return candidate.customType === PROPOSED_PLAN_MESSAGE_TYPE;
}

function unwrapSessionMessage(message: unknown) {
	const entry = message as { message?: unknown };
	return (entry.message ?? message) as { role?: string; customType?: string; content?: unknown };
}

function withPlanAdherenceReminder(messages: unknown[]): unknown[] {
	if (messages.length === 0) return messages;
	const candidate = unwrapSessionMessage(messages[messages.length - 1]);
	// Do not stack a user-role reminder directly after a user message: the
	// handoff already carries the full guidance, and consecutive same-role
	// entries pollute the UI and can trip strict provider role checks.
	if (candidate.role === "user") return messages;
	// Check the whole list, not just the last message: once an earlier
	// reminder has been persisted into the transcript it anchors the model
	// by itself, so a long implementation accumulates exactly one copy
	// instead of one per LLM call.
	if (hasAdherenceReminder(messages)) return messages;
	return [...messages, { message: buildAdherenceReminderMessage() }];
}

function hasAdherenceReminder(messages: unknown[]): boolean {
	return messages.some((message) => {
		const candidate = unwrapSessionMessage(message);
		return messageText(candidate.content).includes(PLAN_ADHERENCE_MARKER);
	});
}

function buildAdherenceReminderMessage() {
	return {
		role: "user",
		content: [{ type: "text", text: planAdherenceReminder() }],
		timestamp: Date.now(),
	};
}

function planAdherenceReminder() {
	return `${PLAN_ADHERENCE_MARKER} You are implementing the plan in ${PLAN_FILE_NAME} in the working directory. Follow its steps and ${PLAN_PROGRESS_TRACKING_INSTRUCTION}. If a step must change, update the plan first and note the deviation and why. When done, report deviations and anything left unfinished.`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
