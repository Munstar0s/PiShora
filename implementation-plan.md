# Pi-Shora — Implementation Plan

> A pi coding-agent extension that makes multi-model deliberation ("fusion") a native capability
> of every pi session. Design decision: **B) self-orchestrated** pipeline over plain OpenRouter
> chat-completions calls (full transcript capture guaranteed, v2 local-model ready).

---

## 1. Confirmed Decisions

| Decision | Choice |
|---|---|
| Pipeline | **Self-orchestrated** (extension runs panel fan-out + analyst + synthesis itself) |
| Triggering | Hybrid: model-decided tool (`pi_shora_deliberate`) **+** user command `/pi-shora '<prompt>'` |
| Storage | Code in `~/.pi/agent/extensions/pi-shora/`, data in `~/.pi/agent/pi-shora/` |
| Concurrency UX | Fire-and-forget; footer status while running, notification when done |
| Roles | 3 roles: **outer/judge** (final answer), **analyst** (comparer, temp 0), **panel** (deliberators) |
| Cost guardrails | Per-request cost estimate shown; track remaining OpenRouter credits; hard credit-usage LIMIT setting; never silently exceed |
| API key | Reuse the OpenRouter key already configured in pi's provider settings (`ctx.modelRegistry.getProviderAuth("openrouter")`) — no separate key |
| v2 future | Local/private endpoints — model refs must go through a resolver abstraction from day one |

## 2. Directory Layout

```
~/.pi/agent/extensions/pi-shora/        # code (auto-discovered extension package)
├── package.json                        # { "pi": { "extensions": ["./src/index.ts"] } }
├── src/
│   ├── index.ts                        # entry: registers tool, commands, event hooks
│   ├── config.ts                       # load/save config.json + templates
│   ├── resolve.ts                      # model-ref resolver (openrouter slug | future local)
│   ├── pipeline.ts                     # deliberation orchestrator (fan-out → analyst → judge)
│   ├── cost.ts                         # estimate + credit tracking / limit enforcement
│   ├── storage.ts                      # task dirs, transcript persistence, Final-*.md writer
│   └── ui.ts                           # setStatus widget, notifications, confirm dialogs

~/.pi/agent/pi-shora/                   # data (survives /reload)
├── config.json                         # default roles, limits, defaults
├── templates/<name>.json               # saved role/model configurations
├── credits.json                        # cached balance snapshot {balance, checkedAt}
└── tasks/<task-id>/                    # one dir per deliberation run
    ├── task.json                       # prompt, template used, models, params, timestamps
    ├── panel/<model-slug>.md           # raw response of each panel model (incl. tool calls if any)
    ├── analysis.json                   # analyst structured output (consensus, contradictions, …)
    ├── analysis-fallback.md            # raw analyst text if JSON parse failed (degradation)
    └── Final-<task-name>.md            # the verdict — the ONLY thing surfaced to chat
```

`<task-id>` = `<timestamp>-<slug-of-task-name>`; task name derived from prompt (or explicit name param).
`Final-<chat-session-name>.md` variant supported when launched without an explicit task name.

## 3. Roles & Model References

```jsonc
// config.json
{
  "roles": {
    "judge":   { "model": "~anthropic/claude-opus-latest" },   // outer/final answer
    "analyst": { "model": "~openai/gpt-latest" },               // comparer, temperature 0
    "panel":   ["~google/gemini-pro-latest", "~openai/gpt-latest", "~anthropic/claude-opus-latest"]
  },
  "limits": {
    "creditLimit": null,          // user-set hard cap (USD); null = ask on first big spend
    "maxConcurrentTasks": 3,
    "maxPanelSize": 8,
    "perCallTimeoutMs": 300000
  },
  "defaults": { "template": null, "webSearchOnPanel": true }
}
```

Model ref grammar (v1): `~vendor/model-slug` → OpenRouter chat completions.
Resolver abstraction in `resolve.ts` returns `{ transport: "openrouter"|"local", ... }` so v2 adds
`local:` refs (Ollama/vLLM/LM Studio endpoints) without touching pipeline logic.

Templates are just named snapshots of the `roles` block (+ optional limits overrides):
`/pi-shora template save deep-review` → `templates/deep-review.json`.

## 4. The Pipeline (self-orchestrated)

```
launch(task, cfg)
  1. PREP      build task dir; snapshot task.json
  2. GUARD     cost estimate (§5) → show/confirm per policy; check cached+fresh credits;
               refuse or confirm if estimate > remaining or > creditLimit
  3. PANEL     Promise.allSettled: N parallel POSTs /api/v1/chat/completions
               - each panel model gets: system preamble (independent expert, be thorough),
                 the task prompt, optionally plugins:[{id:"web"}] for fresh sources
               - stream=false; persist each result immediately to panel/<model>.md
               - partial failures tolerated → recorded in task.json.failedModels[]
  4. ANALYST   single call, temperature 0, structured outputs enforced (JSON schema):
               { consensus[], contradictions[{topic,stances[]}],
                 partial_coverage[{models[],point}], unique_insights[{model,insight}],
                 blind_spots[] }
               - receives ALL panel transcripts verbatim + web access
               - JSON parse fail → retry once → degrade: save raw text, omit analysis
  5. JUDGE     outer model receives task prompt + analysis JSON + (on degradation) raw panels;
               instructed to synthesize a final verdict/plan/opinion — NOT a merge, not a vote
  6. PERSIST   write Final-<name>.md; update task.json status/durations/costs
  7. SURFACE   ctx.ui.notify("Deliberation complete: <task-id>") + clear footer status;
               queue a follow-up message to the session pointing me at the Final file path
               (so the agent can read/act on it) — chat itself only ever sees the pointer
```

Degradation ladder mirrors real fusion: some panels fail → continue, note failures; analyst fails →
raw-panel mode; all panels fail → typed error (`all_panels_failed`, `insufficient_credits`,
`rate_limited`), notify, nothing written to chat except failure notice.

Recursion guard: the follow-up injected message instructs the agent the task is *complete*; the
tool description forbids invoking `pi_shora_deliberate` on a Pi-Shora output review (depth flag in
session state, mirroring `x-openrouter-fusion-depth`).

## 5. Cost Guardrails

1. **Estimate before launch:** rough token counts (prompt chars/4 + configured max_tokens per role)
   × per-model pricing fetched once from `/api/v1/models` (cached in data dir, refreshed daily).
   Estimate shown as: `est. $0.42 (panel 5×$0.06 + analyst $0.05 + judge $0.07)` in the confirm
   dialog / footer.
2. **Credits:** `/api/v1/credits` (key endpoint) polled at session start + before each launch;
   cached in `credits.json`. If estimate ≥ remaining → block with clear message.
3. **User LIMIT:** `limits.creditLimit` (USD). Exceeding requires explicit confirmation dialog
   showing current spend vs limit. Total spend tracked cumulatively in `config.json.usage`.
4. Policy is hybrid per your answer: always *show* estimate; *ask* when crossing limit; *never*
   silently surpass remaining credits.

## 6. Interfaces

### Agent-facing tool: `pi_shora_deliberate`

```
parameters:
  task: string            # detailed description of what to deliberate on (required)
  taskName?: string       # short name for files (else derived from task)
  template?: string       # saved template name (else active default roles)
  panel?: string[]        # ad-hoc panel override (validated ≤8)
  context?: string        # extra context blob (e.g. relevant file excerpts) passed to all roles
returns: { taskId, statusDir, message }   # fire-and-forget; result arrives via follow-up msg
```

Tool description tells me when it's warranted: complex planning, architectural decisions, high
cost-of-being-wrong reviews, "second opinion" requests from the user. Simple tactical work → don't.

### User commands (`pi.registerCommand("pi-shora", …)` subcommand parser)

```
/pi-shora '<prompt>'                          # direct deliberation launch (default template)
/pi-shora run --template X '<prompt>'         # launch with specific template
/pi-shora judge <model-ref>                   # set outer/final-answer model
/pi-shora analyst <model-ref>
/pi-shora panel add <model-ref> | remove <i> | list | clear
/pi-shora template save <name> | use <name> | delete <name> | list | show <name>
/pi-shora limit <usd> | credits               # guardrail config / balance view
/pi-shora status                              # running + recent tasks, costs
/pi-shora open <task-id>                      # print path of task dir / Final file
```

Config changes persist to `config.json` immediately; no reload needed (read at launch time).

## 7. Session Integration Points (pi events)

- `registerTool` — the deliberate tool (available immediately, hot-refreshable).
- `registerCommand` — `/pi-shora`.
- Footer: `ctx.ui.setStatus("pi-shora", "⧗ deliberating <task-name> (2/5)")` updated per stage;
  cleared on completion. Widget shows running task list when >1 concurrent.
- Completion: `ctx.ui.notify(...)` + queued follow-up user message (deliverAs followUp) containing
  the Final-file path + one-line summary so the agent incorporates the verdict naturally.
- `session_start` — refresh credit cache; load config/templates.
- Key resolution: `ctx.modelRegistry.getProviderAuth("openrouter")` → apiKey/baseUrl; fall back to
  `$OPENROUTER_API_KEY`. No separate key management.

## 8. Build Phases

1. **Skeleton** — package layout, config load/save, command parser, key resolution. Test: `/pi-shora status` works.
2. **Single-shot pipeline** — hardcoded roles, sequential: panel→analyst→judge, persist everything, write Final file. Test end-to-end with one prompt.
3. **Parallelism + degradation** — `allSettled` fan-out, retries, fallback modes, typed failures.
4. **UX layer** — fire-and-forget, footer/widget, notifications, follow-up injection, concurrency cap.
5. **Cost guardrails** — pricing cache, estimator, credits polling, limit enforcement.
6. **Templates & full command surface** — save/use/list, per-task overrides.
7. **Hardening** — timeouts, abort handling (`ctx.signal`), malformed-analyst recovery, docs/README.

Each phase lands usable functionality; phase 2 is the earliest dogfooding point.

## 9. Risks / Open Items

- Panel models ignoring the "answer independently" preamble → mitigate with strong system prompts;
  revisit after testing.
- Structured-output support varies by model for the analyst role → schema-enforced where possible,
  robust JSON-extraction fallback otherwise.
- Pricing endpoint coverage for exotic models → unknown-price models flagged in estimates rather than guessed.
- Streaming panel responses later (live watch of deliberation) noted as possible v2 enhancement —
  architecture keeps per-call streams swappable.
