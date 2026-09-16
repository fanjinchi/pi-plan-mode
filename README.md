# 🧭 pi-plan-mode — Codex-like Plan Mode for Pi

[![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@fanjinchi/pi-plan-mode` adds a Codex-like `/plan` collaboration mode to Pi. Plan mode is for read-only exploration, clarifying questions, and producing a final implementation-ready plan written to `pi_plan.md` in the working directory before any code mutation happens.

Pi core intentionally does not ship a built-in plan mode; this package provides one as an independently installable extension.

> **Modified from `@narumitw/pi-plan-mode`**
>
> This package is forked from `@narumitw/pi-plan-mode` with the following changes:
>
> - When choosing **Implement this plan**, an optional input dialog now lets you attach extra implementation instructions. The instructions are appended to the hand-off message that starts the implementation turn.
> - Cancelling the input dialog returns you to the previous menu instead of exiting Plan mode.
> - The plan is written to a `pi_plan.md` file in the working directory rather than emitted as a chat tag.
> - The plan is archived only after the implementation declares completion — the agent appends `<!-- plan-done -->` (or `[plan-done]`) as the last line of `pi_plan.md` or `plan.progress.md`, instead of archiving as soon as the implementing run settles; `/plan done` (alias `/plan archive`) archives by hand.

## ✨ Features

- Adds `/plan` to enter or manage Plan mode.
- Adds `--plan` to start a session in Plan mode.
- Enables read-only tools by default while Plan mode is active: `read`, limited `bash`, `grep`, `find`, and `ls` are matched by tool name, so an extension that replaces one of them (pi-fff's `grep`/`find`) keeps the capability instead of silently losing it.
- Unlocks `write` and `edit` tools in Plan mode, but only for the plan file (`pi_plan.md`); all other file mutations are blocked.
- Disables extension and custom tools by default, with a `/plan tools` selector for explicit user-risk opt-in; the exceptions that stay enabled by default are context management (`compress`, `decompress`, `search_context`, `acp_status` from billion-context-pi; `context_checkpoint`, `context_timeline`, `context_compact` from pi-context), read-only diagnostics (`lsp_diagnostics`), delegation (`push-task`, `resume-task` from pi-tree-like-subagent; `task-ask` stays opt-in — see the delegation note below), and read-only web access (`web_search`, `web_fetch`); everything else, including the mutating `lsp_fix`, stays opt-in.
- Blocks mutating built-in tools and bash commands such as `rm`, `git commit`, dependency installs, redirects, and editor launches.
- Injects Codex-like Plan mode instructions: explore first, ask decision questions for high-impact ambiguity, do not mutate project files, and finish by writing the plan to `pi_plan.md` only when decision-complete.
- Adds a required `plan_mode_question` tool so the agent can ask structured Plan-mode questions before finalizing a plan.
- Detects when `pi_plan.md` appears or changes and prompts you to implement, stay in Plan mode, or exit and discard the plan.
- When you choose to implement, an optional input dialog lets you attach extra implementation instructions before Plan mode is disabled and the plan is handed off.
- Shows Plan mode state in Pi's statusline as `plan active` or `plan ready`; `@narumitw/pi-statusline` adds the default `📝` icon unless configured otherwise.
- Archives the plan only after the implementation declares completion: the agent appends `<!-- plan-done -->` (or `[plan-done]`) as the last line of `pi_plan.md` (or of `plan.progress.md`) when the last step is done, and the next settle moves the plan (plus the progress file, if one exists) into `.pi/plan/` with a timestamp. A hand-off the model never marks keeps its file and reminders, with a one-time hint pointing at `/plan done` (alias `/plan archive`); an archive that fails warns and leaves the hand-off open.
- Persists Plan mode state in the Pi session so resume restores the mode.

## 📦 Install

This package is not published to npm. Install it from the GitHub repository instead:

```bash
pi install git:github.com/fanjinchi/pi-plan-mode
```

Try without installing permanently:

```bash
pi -e git:github.com/fanjinchi/pi-plan-mode
```

Or try this package locally:

```bash
pi -e .
```

## 🛠️ Development

```bash
npm install
npm run check
npm run format
```

## 🚀 Usage

```text
/plan
/plan <prompt>
/plan tools
/plan done
```

Use `/plan` to enter Plan mode before writing your planning prompt. Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message. Use `/plan tools` to choose which tools are active while Plan mode is enabled; the selector is paginated at 10 tools per page. Use `/plan done` (alias `/plan archive`) to archive `pi_plan.md` (and `plan.progress.md`) into `.pi/plan/` yourself — useful for a hand-off the agent never marked done, or a leftover plan file; it works with Plan mode active or off.

When Plan mode is active, ask the agent to design the change. The agent may inspect files and run read-only commands, but it should not edit project files or execute the implementation. It should explore first, then use structured questions when your preference or a tradeoff materially changes the plan.

By default, Plan mode manages only Pi's built-in tools: `read`, limited `bash`, available read-only built-ins such as `grep`, `find`, and `ls`, plus the required `plan_mode_question` tool. The safe set is matched by tool name rather than by package: an extension may replace a built-in by registering the same name (pi-fff replaces `grep` and `find`, so their `sourceInfo.source` is no longer `builtin`), and such a replacement of a safe name stays active. Matching by name trusts the replacement: a tool that shadows a safe name is assumed to be at least as safe as the built-in it replaces, so load an extension that re-registers these names only if you trust it. Built-in `edit` and `write` are also active but gated to `pi_plan.md` only, and so is any extension tool that takes over those names. Command filtering is name-keyed as well, and each shell gets its own dialect instead of being judged by POSIX words. `bash` passes the POSIX read-only allowlist: `git status`, `git log`, `git diff`, `grep -rn`, `sed -n '1,20p'`, and the read-only builtins. That list is deliberately narrow, and the shared judge refuses more than redirects, command substitution, heredocs, and mutating keywords: a first token that carries a path separator is a path rather than a command word (`cat/../../bin/rm -rf x` used to run the real `rm`), `git branch` and `git remote` are limited to their listing forms (`git branch -D main`, `git branch -m old new`, `git remote add origin …`, `git remote set-url …` are refused), `--output=`/`--output ` is refused because it writes a file in `git log`/`diff`/`show`, and `sed` is limited to read-only forms (`sed -i`, `sed -n -i`, `sed --in-place`, and `sed -f script` are refused). `grep -f patterns.txt` stays allowed: it reads the pattern file and greps. The same rules apply in either dialect, because the segment judge is shared. `powershell` passes a PowerShell allowlist: `Get-*` except `Get-Credential`, `Get-Secret`, `Get-SecretInfo`, and `Get-SecretVault` (the `get-` prefix is a naming convention rather than a read-only guarantee, so a third-party `Get-Foo` is trusted exactly like a built-in one — and the convention is not a promise, so acting parameters are refused in argument position: `-Online`, `-Install`, `-MethodName`, `-AcceptAll`, `-AutoReboot`, and `-Download`, which is what stops `Get-Help about_Profiles -Online` (opens the default browser) and a third-party `Get-WindowsUpdate -Install` (persists changes)), read-only non-`Get` cmdlets and their aliases (`Test-Path`, `Resolve-Path`, `Select-String`/`sls`, `Where-Object`/`where`, `Sort-Object`/`sort`, `Format-Table/List/Wide/Custom`/`ft`/`fl`/`fw`, `ConvertTo-Json`, `ConvertFrom-Json`, `ls`, `cat`, `gci`, `gm`, …), and the POSIX forms above, which PowerShell runs too. Everything else is refused: mutating verbs (`Set-`, `New-`, `Remove-`, `Out-`, `Invoke-`, …), `*-Item`/`*-Content`, the mutating aliases (`rm`, `ni`, `sc`, `iex`, `curl`, …), script blocks (`{ … }`), here-strings, `&` (the call operator) and dot-sourcing, redirection, `--%`, `-EncodedCommand`/`-Command` in argument position, and any cmdlet the allowlist does not know. Two consequences are worth knowing before you rely on it: outside single quotes, `$`, backtick, `@`, `{`, `}`, `(`, and `)` are refused wholesale (so `Select-String -Pattern "foo(bar" x.txt` is refused — single-quote the pattern), and there is no script-block support at all, so `Where-Object Name -eq 'x'` works while `Where-Object { $_.Name -eq 'x' }` does not. Built-in `powershell` is Windows-only and not selectable in Plan mode, so this path is reachable today mainly through an extension that shadows the name. Tool selections persist per session, so a session whose selection was saved before this name-keyed policy keeps its old list; run `/plan tools` to re-add a tool that is missing. Extension and custom tools are disabled by default because Pi tools do not expose standardized mutability metadata; the exceptions listed below are enabled because they are read-only, delegate work, or only manage context. For example, you can opt into `firecrawl_scrape`, `firecrawl_search`, `lsp_fix`, or `biome_lsp_diagnostics` if those extensions are loaded and you want to use them during planning.

Context-management extensions are one deliberate exception: their tools never touch project files or external systems, only the session conversation. Plan mode therefore enables them by default and labels them `context management` in the `/plan tools` selector (where you can still toggle them off). Currently recognized: billion-context-pi's `compress`, `decompress`, `search_context`, `acp_status` and pi-context's `context_checkpoint`, `context_timeline`, `context_compact`. During long planning sessions the agent can use them to fold consumed exploration and anchor phases instead of letting context grow unmanaged.

Read-only diagnostics are the second exception: `lsp_diagnostics` (from `@narumitw/pi-lsp`) only reports problems and never rewrites a file, so Plan mode enables it by default and labels it `extension default` in the selector. Its sibling `lsp_fix` applies source fixes and therefore stays a user-risk opt-in.

Delegation tools are the third exception: `push-task` and `resume-task` (from pi-tree-like-subagent) let a planner hand a self-contained chunk of work to a task branch, or suspend work until you answer, instead of doing it inline. They are default-on with one caveat worth knowing: a task branch is navigated inside this same session rather than started as a separate one, so Plan mode's state, system prompt, and tool gates stay in force there. Pushing an implementation task from Plan mode does not bypass the write gate — the branch inherits it, and its edits are refused. Delegate read-only research, exploration, or review; keep the implementation decision in the plan. `task-ask` is not enabled by default: pi-tree-like-subagent only exposes it inside a task branch, and Plan mode's per-turn re-apply of its own tool list strips it from branches pushed from Plan mode anyway. To let a delegated task ping the mainline from inside its branch, opt `task-ask` in from `/plan tools` before pushing — the selection persists for the session and then survives into the branch.

Read-only web access is the fourth: `web_search` and `web_fetch` (from rpiv-web-tools) read external pages without changing anything locally or remotely, so planning can consult documentation beyond your files. `ask_user_question` (rpiv-ask-user-question) is not enabled by default because Plan mode ships its own `plan_mode_question`; enable it from `/plan tools` if you prefer your usual tool.

`plan_mode_question` follows Codex's `request_user_input` pattern: the agent can ask 1-3 concise questions, each with meaningful options and a free-form Other path. If you cancel or no interactive UI is available, the agent should ask a concise plain-text question or proceed only with a clearly stated low-risk assumption instead of prematurely producing a final plan.

A complete Plan mode answer should appear only after the agent has resolved discoverable facts and any high-impact user decisions. The agent writes the plan to `pi_plan.md` in the working directory with a structure like this:

```markdown
# Title

## Summary
...

## Key Changes
...

## Test Plan
...

## Assumptions
...
```

After the plan file is written or updated, `/plan` lets you choose whether to implement the plan, stay in Plan mode, or exit Plan mode. Choosing implementation opens an optional input dialog where you can add extra instructions; leaving it blank proceeds with the plan as-is. Once confirmed, Plan mode is disabled, full tool access is restored, and an implementation turn starts with the plan and any extra instructions you provided (plans up to 8 kB are handed off verbatim; larger plans are handed off by path, telling the agent to read `pi_plan.md` first and re-check it during implementation). The hand-off also instructs the agent to work through the plan step by step, check off steps as it completes them (in the plan file or a `plan.progress.md` beside it), update the plan and note the reason before changing a step, and report deviations when done. Once an implementation is underway, the extension keeps a short adherence reminder in the context in front of the model (skipped right after a user message, and kept to a single copy) so long implementation sessions keep following the plan. The plan file stays in the working tree for the whole implementation: an implementing run ends whenever the model stops calling tools, which for a multi-step plan is usually well before the plan is done, so settling the run is not treated as completion. When the last step is done the agent appends `<!-- plan-done -->` (or `[plan-done]`) as the last line of `pi_plan.md` or `plan.progress.md`; at the next settle, the consumed plan (and `plan.progress.md` if one was created) is archived into `.pi/plan/` with a timestamp: the working tree stays clean, the reminders stop, and past plans stay consultable. Only that last line is inspected, so a marker the model merely quoted into the plan body never ends the hand-off early. A hand-off left unmarked keeps its file and reminders — after the first settle without a marker the extension says so once and points at `/plan done` — and an archive that fails warns instead of reporting success, leaving the hand-off open. Run `/plan done` (alias `/plan archive`) to archive by hand, or delete `pi_plan.md` to end the hand-off without archiving. Choosing Stay keeps the plan ready while you decide what to do next; to revise the plan, choose Stay and type your revision feedback in the normal prompt. The agent will update `pi_plan.md` to reflect the latest agreed plan. Choosing exit/off disables Plan mode but keeps `pi_plan.md` on disk so it remains available if you re-enter Plan mode later.

While Plan mode is enabled, the extension also publishes a compact status for Pi statuslines. With `@narumitw/pi-statusline`, this appears in the extension status area:

- `plan active`: Plan mode is enabled and still gathering context or drafting a plan.
- `plan ready`: `pi_plan.md` exists and remains ready until you implement it, continue planning, or exit Plan mode.

You can also exit directly. Direct exit keeps `pi_plan.md` on disk:

```text
/plan exit
```

## 🧠 Codex-like behavior

This extension maps Codex's `ModeKind::Plan` behavior onto Pi's extension API:

- Plan mode is a conversational collaboration mode, not TODO/progress tracking.
- `/plan <prompt>` follows Codex behavior by switching to Plan mode before submitting the inline prompt.
- The agent should use `plan_mode_question` for important non-discoverable preferences or tradeoffs before finalizing.
- `update_plan`-style checklist use is discouraged while Plan mode is active.
- The implementation boundary is explicit: Plan mode restores tools before starting implementation, choosing implementation immediately triggers a normal agent turn with full tool access, and plain exit/off keeps `pi_plan.md` on disk.
- Pi extension safety is approximated with write restriction plus bash filtering, both keyed on the tool name: anything named `edit`/`write` may only touch `pi_plan.md` and anything named `bash` must pass the command allowlist, even when an extension provides it. Other non-built-in tools are user-selected at user risk because Plan mode does not classify extension/custom tool behavior.

## 🗂️ Package layout

```txt
.
├── src/
│   └── plan-mode.ts
├── test/
│   ├── plan-mode.test.ts
│   └── support.ts
├── README.md
├── LICENSE
├── tsconfig.json
├── tsconfig.test.json
├── biome.json
├── .gitignore
├── package.json
└── scripts/
    └── run-tests.mjs
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/plan-mode.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, plan mode, Codex-like plan mode, AI coding workflow, read-only planning, implementation plan.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
