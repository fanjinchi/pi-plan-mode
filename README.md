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

## ✨ Features

- Adds `/plan` to enter or manage Plan mode.
- Adds `--plan` to start a session in Plan mode.
- Enables built-in read-only tools by default while Plan mode is active.
- Unlocks `write` and `edit` tools in Plan mode, but only for the plan file (`pi_plan.md`); all other file mutations are blocked.
- Disables extension and custom tools by default, with a `/plan tools` selector for explicit user-risk opt-in; context-management tools (`compress`, `decompress`, `search_context`, `acp_status` from billion-context-pi; `context_checkpoint`, `context_timeline`, `context_compact` from pi-context) are treated as safe — they only read/rewrite session conversation, never project files — and stay enabled by default.
- Blocks mutating built-in tools and bash commands such as `rm`, `git commit`, dependency installs, redirects, and editor launches.
- Injects Codex-like Plan mode instructions: explore first, ask decision questions for high-impact ambiguity, do not mutate project files, and finish by writing the plan to `pi_plan.md` only when decision-complete.
- Adds a required `plan_mode_question` tool so the agent can ask structured Plan-mode questions before finalizing a plan.
- Detects when `pi_plan.md` appears or changes and prompts you to implement, stay in Plan mode, or exit and discard the plan.
- When you choose to implement, an optional input dialog lets you attach extra implementation instructions before Plan mode is disabled and the plan is handed off.
- Shows Plan mode state in Pi's statusline as `plan active` or `plan ready`; `@narumitw/pi-statusline` adds the default `📝` icon unless configured otherwise.
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
```

Use `/plan` to enter Plan mode before writing your planning prompt. Use `/plan <prompt>` to enter Plan mode and immediately submit `<prompt>` as the first Plan-mode user message. Use `/plan tools` to choose which tools are active while Plan mode is enabled; the selector is paginated at 10 tools per page.

When Plan mode is active, ask the agent to design the change. The agent may inspect files and run read-only commands, but it should not edit project files or execute the implementation. It should explore first, then use structured questions when your preference or a tradeoff materially changes the plan.

By default, Plan mode manages only Pi's built-in tools: `read`, limited `bash`, available read-only built-ins such as `grep`, `find`, and `ls`, plus the required `plan_mode_question` tool. Built-in `edit` and `write` are also active but gated to `pi_plan.md` only. Extension and custom tools are disabled by default because Pi tools do not expose standardized mutability metadata; enable them from `/plan tools` only when you accept the risk for that session. For example, you can opt into `firecrawl_scrape`, `firecrawl_search`, or `biome_lsp_diagnostics` if those extensions are loaded and you want to use them during planning.

Context-management extensions are the deliberate exception: their tools never touch project files or external systems, only the session conversation. Plan mode therefore enables them by default and labels them `context management` in the `/plan tools` selector (where you can still toggle them off). Currently recognized: billion-context-pi's `compress`, `decompress`, `search_context`, `acp_status` and pi-context's `context_checkpoint`, `context_timeline`, `context_compact`. During long planning sessions the agent can use them to fold consumed exploration and anchor phases instead of letting context grow unmanaged.

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

After the plan file is written or updated, `/plan` lets you choose whether to implement the plan, stay in Plan mode, or exit Plan mode. Choosing implementation opens an optional input dialog where you can add extra instructions; leaving it blank proceeds with the plan as-is. Once confirmed, Plan mode is disabled, full tool access is restored, and an implementation turn starts with the plan and any extra instructions you provided. Choosing Stay keeps the plan ready while you decide what to do next; to revise the plan, choose Stay and type your revision feedback in the normal prompt. The agent will update `pi_plan.md` to reflect the latest agreed plan. Choosing exit/off disables Plan mode but keeps `pi_plan.md` on disk so it remains available if you re-enter Plan mode later.

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
- Pi extension safety is approximated with built-in tool restriction plus bash filtering; non-built-in tools are user-selected at user risk because Plan mode does not classify extension/custom tool behavior.

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
