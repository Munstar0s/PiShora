# Pi-Shora

[![npm version](https://img.shields.io/npm/v/@munstar0s/pi-shora.svg)](https://www.npmjs.com/package/@munstar0s/pi-shora)

Multi-model deliberation ("fusion") as a native [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension.

## The name

**Shūra** (Arabic: شُورَىٰ) means *consultation*, *counsel*, or *deliberation*. It refers to the
traditional practice of collective decision-making and mutual advisory in community or governance
affairs — a principle of seeking multiple perspectives before reaching a conclusion.

Pi-Shora brings that same principle to your AI workflow: instead of relying on a single model,
it convenes a *shūra* — a panel of models that independently answer your question, an analyst that
compares their perspectives, and a judge that synthesizes the best verdict. The etymology is the
feature.

A panel of up to 8 models answers your prompt independently and in parallel, an analyst model compares all responses (consensus, contradictions, partial coverage, unique insights, blind spots), and a judge model synthesizes the final verdict. Every raw response is persisted to disk; only a pointer to the verdict enters the chat.

## Install

```bash
pi install npm:@munstar0s/pi-shora        # from npm
pi install git:github.com/Munstar0s/PiShora  # from GitHub
```

The extension reuses the OpenRouter API key already configured in pi (via `/model`) or falls back to `$OPENROUTER_API_KEY`.

### First-run setup

On first use (either via `/pi-shora '<prompt>'` or when the agent auto-launches a deliberation), Pi-Shora will prompt you to select models for each role — judge, analyst, and panel. These choices are saved as your **`main` template**, which serves as the default configuration for all future deliberations. You can modify it anytime with the `/pi-shora judge`, `/pi-shora analyst`, and `/pi-shora panel` commands, or save additional named templates with `/pi-shora template save <name>`.

## Usage

**From you (the user):**

```
/pi-shora 'Should we use server-side rendering for this app?'   # launch deliberation
/pi-shora run --template deep-review '...'                      # launch with a saved template
/pi-shora judge anthropic/claude-opus-5                         # set outer/final-answer model
/pi-shora analyst openai/gpt-5.6-luna                           # set comparer model
/pi-shora panel add <ref>[,<ref>...]             # add one or more members (max 8 total)
/pi-shora panel set <ref>[,<ref>...]             # replace the whole panel in one shot
/pi-shora panel list | remove <n> | clear
/pi-shora template save|use|show|delete|list [name]             # named role configurations
/pi-shora limit 10                                              # hard credit usage limit (USD)
/pi-shora timeout 600                                           # per-model call timeout in seconds (default 300)
/pi-shora analyst-fallback <model-ref>                          # fallback analyst if primary produces garbage
/pi-shora credits                                               # OpenRouter balance
/pi-shora status                                                # live runs + config
/pi-shora open <task-id>                                        # locate a task directory
```

**From the agent:** a `pi_shora_deliberate` tool is registered in every session. The agent invokes it when a task genuinely benefits from multiple perspectives (complex plans, architectural decisions, second opinions). It fires in the background and the agent receives a follow-up message pointing at the final verdict file.

### Concurrent deliberations

Multiple deliberations can run at the same time — each independently configured with its own models via templates. Launch several in sequence and they run in parallel (up to `maxConcurrentTasks`, default 3). A live widget above the editor shows all running deliberations and their elapsed time; you'll get a separate notification and follow-up message for each one as it completes.

## Roles

| Role | Purpose | Configured via |
|---|---|---|
| **panel** | N independent models answering in parallel (1–8) | `/pi-shora panel add/set` |
| **analyst** | Compares panel responses → structured JSON (temperature 0) | `/pi-shora analyst` |
| **judge** | Synthesizes the final answer from the analysis | `/pi-shora judge` |

There are no hardcoded defaults — on first use Pi-Shora prompts you to pick models for each role and saves them as your `main` template.

## Output layout

```
~/.pi/agent/pi-shora/
├── config.json            # roles, limits, cumulative spend
├── templates/<name>.json  # saved role configurations
├── pricing.json           # cached model pricing (refreshed daily)
├── credits.json           # cached credit balance (refreshed every 5 min)
└── tasks/<task-id>/
    ├── task.json          # metadata, status, failures, actual cost
    ├── panel/<model>.md   # each panel model's raw response
    ├── analysis.json      # analyst structured comparison
    ├── analysis-fallback.md  # only if the analyst's JSON was invalid twice
    └── Final-<task>.md    # the verdict — what reaches the session
```

## Cost guardrails

- Pre-launch estimate from real per-model pricing (always shown)
- Credit balance polled from OpenRouter; launches exceeding remaining credits are blocked
- Optional user limit (`/pi-shora limit <usd>`): interactive confirm before crossing; agent-initiated runs warn
- Actual per-call costs captured from API usage data and accumulated in `config.json.usage`

## Architecture

Self-orchestrated pipeline (no dependence on OpenRouter's server-side fusion tool):

```
prompt ──► PANEL (parallel fan-out, retry on transient errors)
       ──► ANALYST (temp 0, JSON schema, one corrective retry)
       ──► JUDGE (synthesis, not majority vote)
       ──► persisted transcript + Final-*.md + follow-up pointer to session
```

Degradation ladder: some panels fail → continue with `failedModels` noted; analyst fails → judge works from raw panels; all panels fail → typed error. Abort-safe via pi's signal (Esc cancels all in-flight calls). Concurrency cap default 3.

Model refs (`~vendor/model` or plain `vendor/model`) flow through `src/resolve.ts` so v2 can add local/private endpoints without touching the pipeline.


