# Global instructions

## Web research: dual-backend by default

Two independent search backends are installed. Lead with the free one; add the metered
one deliberately:

- `web_search` — OpenAI Responses via the Codex subscription (`openai-codex` provider,
  model `gpt-5.6-terra`). Supports multiple angles per call (`queries`), `includeContent`,
  and storable results (`responseId` + `get_search_content`). Draws from the **Codex**
  subscription windows, which are token-metered.
- `perplexity_search` — Perplexity Pro over OAuth (model `pplx_pro`), single query per
  call, `limit` up to 50. Draws from the **Perplexity Pro** plan, not from Codex.

**Priority: Perplexity is the workhorse.** The Perplexity Pro plan here is effectively
unlimited, so breadth is free — use it liberally, in parallel, from multiple angles.
`web_search` is quota-metered and therefore the *supplement*, added deliberately for what
only it can do.

### When to fire both

Query both backends **in the same tool block, in parallel** for:

- comparisons and "which is better" questions
- "what is the current state of X" / anything that changes over time
- decisions that need evidence, or where being wrong is expensive
- fact-checking a claim across independent sources
- any request where the user asks for depth, breadth, or "big results"

Lead with `perplexity_search`: fire 3-5 varied angles in parallel. Add `web_search`
with 2-4 angles when the task needs what only it provides (see Cost awareness).
Vary the phrasing and the scope, not just the wording — each query gets its own
synthesis, so parallel angles give genuinely broader coverage.

### When NOT to

A single factual lookup — a version number, a URL, a date, one known fact — needs one
call, not a fan-out. Use `perplexity_search` once and move on.

### Merging the results

- Deduplicate sources by URL before reporting.
- When the backends disagree, **say so explicitly** instead of averaging them. Report
  the discrepancy and which source supports which side.
- Primary sources (official docs, repos, vendor pages, filings) outrank synthesized
  summaries. Prefer them for numbers, dates, and API details.
- Note which backend a claim came from when it matters.
- Prefer following up with `fetch_content` on the primary sources over trusting two
  summaries of the same page.

### Cost awareness

- `perplexity_search` — **effectively unlimited** on this plan. This is the default
  backend. Do not ration it: fire several angles in parallel whenever breadth helps.
  The real constraint is rate limiting (HTTP 429), not quota — so keep parallelism
  moderate (roughly 3-5 calls at once) and retry on 429 rather than treating it as a
  hard failure.
- `web_search` — **metered.** Draws from Codex subscription windows (token-metered
  since April 2026, 5-hour + weekly). Use it where it earns its cost: `includeContent`
  to fetch full page bodies in the background, storability (`responseId` +
  `get_search_content`) so results can be re-sliced without re-searching, or genuine
  independent cross-checking of a claim that matters.
- Do not run `web_search` as a reflex on every question just because both are
  installed. The metered backend should be a deliberate choice, not a default.
- The user's Perplexity quota is the reason for this ordering. If that ever changes,
  revisit it.

## Local setup notes

- **Default Perplexity model: `pplx_pro`.** Do not switch the global default to
  `pplx_alpha` (Deep Research). It is slow and returns one deep single pass, which
  trades away the breadth that makes the unlimited quota valuable. Breadth is the
  point: many parallel `pplx_pro` angles beat one Deep Research pass for most work.
- Deep Research is **opt-in only** and worth it for exactly one shape of question: a
  single topic that genuinely needs a long multi-source synthesis, where waiting is
  acceptable. The model is global, not per-call — the package blocks per-call model
  overrides on purpose. So ask the user before spending it; do not flip the config
  silently, since it would change their experience in every other session too.
- `web_search` (Codex) results are storable — keep the `responseId` and slice with
  `get_search_content` instead of re-searching or re-fetching.
- `fetch_content` in `mode: "answer"` runs on `openai-codex/gpt-5.6-luna` ($0.2/$1.2 per M).
  It is the cheap way to read a large page: the page body never enters session context,
  only the short answer. Prefer it over dumping big pages inline.
- RTK is active and rewrites bash commands to `rtk` equivalents, compacting noisy output.
  Do not fight it; write commands normally.
- MCP is available through `pi-mcp-adapter` (Context7 is configured). Use Context7 for
  library/framework/API questions before answering from memory.
