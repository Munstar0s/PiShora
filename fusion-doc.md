# OpenRouter Fusion — Deep-Dive Reference

> Sources: OpenRouter docs —
> [Fusion plugin](https://openrouter.ai/docs/guides/features/plugins/fusion),
> [`openrouter:fusion` server tool](https://openrouter.ai/docs/guides/features/server-tools/fusion),
> [Fusion Router (`openrouter/fusion`)](https://openrouter.ai/docs/guides/routing/routers/fusion-router).
> Status: **Beta** (server tools API may change).

---

## 1. What Fusion Is (One Paragraph)

Fusion is OpenRouter's **multi-model deliberation** feature. Instead of one model answering your
prompt, a *panel* of up to 8 models answers the same prompt **in parallel** (each with web search +
web fetch enabled), an **analyst** model then compares all panel responses and produces a
**structured JSON analysis** (consensus, contradictions, partial coverage, unique insights, blind
spots), and finally **your outer model** uses that analysis to write a better final answer.

Crucially, the analyst does **not merge or average** the panel responses — it *compares* them,
treating points of agreement as higher-confidence consensus and explicitly surfacing disagreement.
The final answer is therefore not a majority vote; it's an informed synthesis written by your model.

---

## 2. The Three Entry Points (One Pipeline)

All three entry points hit the exact same pipeline. They're just different ways to opt in:

| Entry point | How you invoke it | When to use |
|---|---|---|
| **Model alias / Router** | `model: "openrouter/fusion"` | Simplest. Tool is auto-injected. Also `openrouter/fusion-flash` (fast preset pre-pinned). |
| **Plugin** | `plugins: [{ id: "fusion", ... }]` | Configuration surface for the plugin; used with the alias to customize panel/analyst. |
| **Server tool** | `tools: [{ type: "openrouter:fusion", parameters: {...} }]` | Most control: keep **your own outer model**, combine fusion with your own tools. |

Equivalence:

```jsonc
// A) Model alias  ≡  B) Server tool on that alias's resolved model
{ "model": "openrouter/fusion", "messages": [...] }
// behaves identically to:
{ "model": "<resolved real model>",
  "tools": [{ "type": "openrouter:fusion" }],
  "messages": [...] }
```

---

## 3. How the Pipeline Works, Step by Step

```
Your request
     │
     ▼
┌──────────────────────────────┐
│ Your model (outer model)     │   reads the prompt, decides whether
│ e.g. claude-opus-latest      │   deliberation is worth it
└──────────┬───────────────────┘
           │ invokes tool openrouter:fusion
           ▼
┌─────────────────────────────────────────────────────────┐
│ PANEL: up to 8 models run IN PARALLEL                   │
│ each gets your prompt + web_search + web_fetch enabled  │
└──────────┬──────────────────────────────────────────────┘
           │ all raw panel responses
           ▼
┌─────────────────────────────────────────────────────────┐
│ ANALYST model (+ web_search/web_fetch), temp = 0        │
│ COMPARES responses → structured JSON analysis:          │
│   consensus, contradictions, partial_coverage,          │
│   unique_insights, blind_spots                          │
└──────────┬──────────────────────────────────────────────┘
           │ tool result (analysis + raw responses)
           ▼
┌──────────────────────────────┐
│ Your model writes the        │
│ FINAL ANSWER from analysis   │
└──────────────────────────────┘
```

Step-by-step mechanics:

1. **Tool injection.** The fusion plugin/server-tool injects the `openrouter:fusion` tool into the
   request. If you used the `openrouter/fusion` alias, OpenRouter also resolves it to a concrete
   real model.
2. **Model decides.** Your outer model reads the prompt and decides whether the task genuinely
   benefits from multiple perspectives (research questions, multi-domain critique, compare/contrast,
   high cost of being wrong). Simple tactical prompts → it just answers directly (possibly using
   your other tools). To force fusion every time: `tool_choice: "required"`. Note: if you also
   declare other tools, "required" only forces *some* tool call — the model may pick another one;
   with `openrouter/fusion`, fusion is the only injected tool so it's effectively forced.
3. **Panel fan-out.** Each panel model independently answers your prompt in parallel, with
   `openrouter:web_search` and `openrouter:web_fetch` available so they can pull fresh sources.
4. **Analyst comparison.** The analyst receives ALL panel responses (with its own web tools) and
   compares them — never merges them. It emits structured JSON (see §5).
5. **Final answer.** Your outer model receives the tool result (analysis + raw panel responses) and
   writes the final answer.

Latency note: fusion works on `/chat/completions` today but is slower there; for latency-sensitive
use, send the same payload to the **Responses API**.

---

## 4. Configuration Reference

### 4a. Plugin form (with `model: "openrouter/fusion"`)

```jsonc
{
  "model": "openrouter/fusion",
  "messages": [...],
  "plugins": [
    {
      "id": "fusion",
      "preset": "general-budget",            // OR explicit models below (explicit wins)
      "analysis_models": [                    // the panel (1–8 models)
        "~anthropic/claude-opus-latest",
        "~openai/gpt-latest",
        "~google/gemini-pro-latest"
      ],
      "model": "~openai/gpt-latest"           // the analyst
    }
  ]
}
```

### 4b. Server-tool form (with your own outer model)

```jsonc
{
  "model": "~anthropic/claude-opus-latest",   // YOUR model = outer model
  "tools": [
    {
      "type": "openrouter:fusion",
      "parameters": {
        "analysis_models": ["~google/gemini-flash-latest", "deepseek/deepseek-v3.2"],
        "model": "~openai/gpt-latest"
      }
    }
  ]
}
```

### Parameter table (applies to both forms)

| Field | Default | Description |
|---|---|---|
| `preset` | none | Curated preset slug (`general-high`, `general-budget`, `general-fast`) that expands into a panel + analyst so you don't name models. Explicit `analysis_models`/`model` override it. |
| `analysis_models` | Quality preset (~anthropic/claude-opus-latest, ~openai/gpt-latest, ~google/gemini-pro-latest) | Panel members. Run in parallel with web_search + web_fetch. **1–8 allowed.** |
| `model` | First model of the Quality preset (plugin/alias form); **your outer model** (server-tool form) | The analyst that produces the structured JSON. With the alias, it's also the model writing the final answer. |
| `max_tool_calls` | `4` | Max tool-calling steps per panel model & analyst in their web_search/web_fetch loop. Range 1–16. |
| `max_completion_tokens` | `16000` | Max output tokens (incl. reasoning) per inner panel/analyst call. Prevents reasoning-heavy models burning their budget before emitting visible text. |
| `reasoning` | Provider default | Reasoning config forwarded to panel + analyst calls: `{ effort?, max_tokens? }`. |
| `temperature` | Provider default | Forwarded to panel calls (0–2). **Analyst always runs at temperature 0.** |
| `enabled` | `true` | Plugin-only: set `false` to bypass fusion for a single request. |

### Presets

Slug format `<task>-<tier>`; tier trades quality/cost/speed:

| Preset | For |
|---|---|
| `general-high` | Strongest all-round panel. |
| `general-budget` | Cheaper panel, still frontier analyst — strong synthesis at lower cost. |
| `general-fast` | Latency-homogeneous panel (similar TTFT across models, so no single slow model gates the fan-out); frontier analyst. Optimized for fast agentic turns. |

There's also a dedicated model slug **`openrouter/fusion-flash`** = the fusion pipeline with
`general-fast` pre-selected (its own `/api/v1/models` entry and usage attribution). Explicit plugin
config always overrides the pinned preset. Variant suffixes like `openrouter/fusion-flash:free`
parse like on `openrouter/fusion`.

When you use `model: "openrouter/fusion"` with no config at all, defaults match the **Quality**
preset shown at the interactive playground `/labs/fusion`.

---

## 5. Tool Result Schema

On success, the tool result contains the structured analysis plus the raw panel responses:

```jsonc
{
  "status": "ok",
  "analysis": {
    "consensus": ["Points all or most panel models agreed on"],   // higher confidence
    "contradictions": [
      { "topic": "...", "stances": [{ "model": "...", "stance": "..." }] }
    ],
    "partial_coverage": [
      { "models": ["..."], "point": "Only some models covered this" }
    ],
    "unique_insights": [
      { "model": "...", "insight": "Something only one model raised" }
    ],
    "blind_spots": ["Topics no panel model addressed"]
  },
  "responses": [
    { "model": "anthropic/claude-opus-4.5", "content": "..." },
    { "model": "openai/gpt-4.1", "content": "..." },
    { "model": "google/gemini-2.5-pro", "content": "..." }
  ],
  // present when some panels failed but ≥1 succeeded:
  "failed_models": [{ /* which failed and why */ }]
}
```

### Graceful degradation (analyst failure)
If the **panel** succeeds but the **analyst** fails (upstream error, empty completion, invalid
JSON), the tool does **not** error. It returns `"status": "ok"` with the raw `responses` and simply
**omits `analysis`**. Your outer model can still write the final answer from the raw panel.

### Hard failures (`status: "error"` + typed `failure_reason`)
Only when no useful output can be produced:

```jsonc
{ "status": "error", "error": "all panel models failed", "failure_reason": "all_panels_failed" }
```

| `failure_reason` | Meaning |
|---|---|
| `all_panels_failed` | Every panel model returned an error. |
| `insufficient_credits` | Every panel failed and at least one due to insufficient credits. |
| `rate_limited` | Every panel failed and at least one was rate-limited. |
| `fusion_invocation_capped` | Fusion already invoked earlier in the same turn; second call rejected. |
| `unexpected_error` | Unexpected error interrupted the run. |

The calling model falls back to answering without the analysis whenever fusion fails or degrades.

---

## 6. Recursion Protection

Inner fusion calls carry an `x-openrouter-fusion-depth` header. Panel and analyst models
**cannot recursively invoke `openrouter:fusion`** — the plugin refuses to inject the tool a second
time. Deliberation is bounded to exactly one level (no infinite model-towers).

---

## 7. Cost & Response Metadata

- Cost = N panel calls + 1 analyst call, **in addition to** your normal request. Default 3-model
  panel ⇒ roughly **4–5×** a single completion on the same prompt. Scales linearly with panel size.
- The response's `model` field reports the **concrete model** that handled the request, not the
  alias. To confirm a generation went through the Fusion Router, query the generation-metadata
  endpoint — its `router` field reports `"openrouter/fusion"`:

```jsonc
{ "data": { "id": "gen-...", "model": "anthropic/claude-opus-4.5", "router": "openrouter/fusion" } }
```

---

## 8. Complete Implementation Examples

### Example 1 — Zero-config alias (simplest possible integration)

```ts
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer <OPENROUTER_API_KEY>',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'openrouter/fusion',
    messages: [
      { role: 'user', content: 'What are the strongest arguments for and against carbon taxes?' },
    ],
  }),
});
const data = await response.json();
console.log(data.choices[0].message.content);
```

### Example 2 — Alias + custom panel/analyst via plugin

```ts
const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: 'Bearer <KEY>', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'openrouter/fusion',
    messages: [
      { role: 'user', content: 'Compare ridge, lasso, and elastic-net regression. Where does each shine?' },
    ],
    plugins: [
      {
        id: 'fusion',
        analysis_models: ['~anthropic/claude-opus-latest', '~openai/gpt-latest'],
        model: '~openai/gpt-latest',
      },
    ],
  }),
});
```

Python equivalent:

```python
from openai import OpenAI

client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key="<KEY>")
completion = client.chat.completions.create(
    model="openrouter/fusion",
    messages=[{"role": "user",
               "content": "Compare ridge, lasso, and elastic-net regression."}],
    extra_body={
        "plugins": [{
            "id": "fusion",
            "analysis_models": ["~anthropic/claude-opus-latest", "~openai/gpt-latest"],
            "model": "~openai/gpt-latest",
        }]
    },
)
print(completion.choices[0].message.content)
```

### Example 3 — Bring-your-own-model via server tool (most control)

```ts
const completion = await openRouter.chat.send({
  model: '~anthropic/claude-opus-latest',          // your outer model
  messages: [
    { role: 'user', content: 'Survey the strongest arguments for and against a carbon tax.' },
  ],
  tools: [
    {
      type: 'openrouter:fusion',
      parameters: {
        analysis_models: ['~google/gemini-flash-latest', 'deepseek/deepseek-v3.2'],
        model: '~openai/gpt-latest',               // analyst
        max_tool_calls: 6,
      },
    },
    // ...your own tools can coexist here; the model picks when to call fusion
  ],
});
```

### Example 4 — Force fusion every request (e.g., eval/research pipelines)

```ts
const completion = await openRouter.chat.send({
  model: 'openrouter/fusion',
  messages: [{ role: 'user', content: '...' }],
  tool_choice: 'required',   // guarantees the (single) injected tool fires
});
```

### Example 5 — Budget-conscious preset usage

```jsonc
{
  "model": "openrouter/fusion-flash",       // fast agentic preset, own models-entry/attribution
  "messages": [...]
}
// or equivalently:
{ "model": "openrouter/fusion",
  "plugins": [{ "id": "fusion", "preset": "general-fast" }] }
// cheap synthesis:
{ "model": "openrouter/fusion",
  "plugins": [{ "id": "fusion", "preset": "general-budget" }] }
```

---

## 9. How to Port This Pattern Into Other Projects

If we're building our own system (not calling OpenRouter), Fusion decomposes into these reusable
design elements:

1. **A deliberation orchestrator**: given a user prompt, fan out N parallel completions to distinct
   provider models (`Promise.all` style), each optionally augmented with retrieval/search tools.
2. **An analyst stage**: a single call (temp=0 for determinism) receiving all panel outputs with a
   comparison prompt constrained to a strict JSON schema — `{consensus[], contradictions[],
   partial_coverage[], unique_insights[], blind_spots[]}`.
3. **A synthesizer stage**: the caller-facing model rewrites the final answer grounded in the
   analysis (not a merge, not a vote).
4. **Degradation ladder**: analyst fails → return raw panel; some panels fail → include
   `failed_models`; all fail → typed error with reasons (`all_panels_failed`,
   `insufficient_credits`, `rate_limited`, …). Never hard-fail when partial results exist.
5. **Recursion guard**: tag inner calls with a depth header/flag; refuse nested invocation.
6. **Invocation policy**: model-decided (tool-call) by default, with an opt-in force flag
   (`tool_choice: "required"`) and an opt-out flag (`enabled: false`).
7. **Cost accounting**: expect ~(N+1)× single-completion cost; make panel size configurable
   (1–8) and expose preset tiers (high/budget/fast).

---

## 10. When to Use / Not Use

✅ Research questions, expert critique, compare-and-contrast prompts, multi-domain analysis, any
task where being wrong is expensive.

❌ Short tactical prompts, simple lookups, latency-critical chat — the ~4–5× cost and fan-out
latency aren't justified ("overkill").

---

## 11. Related OpenRouter Docs

- Fusion plugin: `/docs/guides/features/plugins/fusion`
- `openrouter:fusion` server tool: `/docs/guides/features/server-tools/fusion`
- Fusion Router: `/docs/guides/routing/routers/fusion-router`
- Web Search / Web Fetch server tools: `/docs/guides/features/server-tools/web-search`,
  `/docs/guides/features/server-tools/web-fetch`
- Interactive playground: https://openrouter.ai/labs/fusion
- Responses API: `/docs/api_reference/responses/overview` (faster path for fusion payloads)
