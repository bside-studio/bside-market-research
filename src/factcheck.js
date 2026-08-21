import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Migrated from Gemini: Google's consumer Generative Language API rejects requests from EEA/UK
// server IPs (confirmed in production - this app's OVH host got "User location is not supported
// for the API use"). Anthropic's API has no equivalent restriction, so this fixes the fact-check
// engine being unusable from a European server, not just a preference swap.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const SOURCE_HIERARCHY = `
Source hierarchy (highest to lowest trust) for Luxembourg real-estate figures:
1. Official/public: Observatoire de l'Habitat, Housing Ministry (logement.public.lu), STATEC, LISER, BCL, CSSF, Gouvernement.lu.
2. Professional research: CBRE, JLL, INOWAI, and documented sector reports.
3. Portal-derived: atHome.lu, Immotop.lu, Nexvia.lu, Wort.lu.
4. Agency-published: valuations, guides, newsletters from real-estate agencies.
Never present asking/listed prices as completed notarial transaction prices - they measure different things.
`.trim();

let _client = null;
function client() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY missing - copy .env.example to .env and set it.");
  _client = new Anthropic({ apiKey: key });
  return _client;
}

// Web search is a server-side tool - Claude issues and reads searches on Anthropic's own
// infrastructure, so this one call can involve many searches with no client-side loop needed.
// It caps itself at 10 search iterations per turn and returns stop_reason "pause_turn" if that
// cap is hit mid-research; resending the same user turn plus the partial assistant response
// (which already carries the accumulated search history) resumes it automatically - the API
// detects the trailing server-tool-use block, so no extra "continue" message is needed.
//
// `schema` is passed as output_config.format (structured outputs): unlike Gemini, Claude
// narrates its research process in plain text alongside web searches ("Let me check X... now
// searching Y...") even when told "return JSON only" - verified against a real run, where that
// narration was mistaken for the ledger by a naive "find the first [ or {" parser. Structured
// outputs constrains generated text to the schema at the token level, so the narration can't
// happen in the first place, rather than trying to strip it out afterwards.
//
// Transient server-side failures (Anthropic momentarily overloaded, 5xx, rate limit) are worth
// retrying with backoff rather than failing the whole call outright - verified against a real
// "overloaded_error" hit during testing of the two-call regenerateReport() pipeline below, which
// makes a transient mid-chain failure twice as likely as a single fact-check call.
function isTransientError(e) {
  const type = e?.error?.type;
  if (type === "overloaded_error" || type === "api_error" || type === "rate_limit_error") return true;
  return typeof e?.status === "number" && (e.status === 429 || e.status >= 500);
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === attempts - 1 || !isTransientError(e)) throw e;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
}

// maxRounds bounds how many times a pause_turn (hit the 10-searches-per-turn cap) gets resumed;
// maxSearchUses caps total searches per turn directly via the tool's own `max_uses`. Both default
// to the original unbounded-ish values (5 rounds, no cap) for normal fact-check calls, which were
// already fast in practice - deep mode (see checkFacts) passes tighter values because its wider
// claim scope was verified to run 15-20+ minutes per pass otherwise (real timing, not a guess).
async function callClaude({ system, prompt, maxTokens, schema, maxRounds = 5, maxSearchUses }) {
  const c = client();
  const userMessage = { role: "user", content: prompt };
  let messages = [userMessage];
  let response;
  const searchTool = { type: "web_search_20260209", name: "web_search" };
  if (maxSearchUses) searchTool.max_uses = maxSearchUses;
  for (let round = 0; round < maxRounds; round++) {
    response = await withRetry(async () => {
      const stream = c.messages.stream({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        tools: [searchTool],
        output_config: { format: { type: "json_schema", schema } },
        messages,
      });
      return stream.finalMessage();
    });
    if (response.stop_reason !== "pause_turn") break;
    messages = [userMessage, { role: "assistant", content: response.content }];
  }

  // A response still mid-research (paused, wanting more searches) when maxRounds runs out is NOT
  // a finished answer - its text block(s) can be an interim placeholder emitted before the model
  // resumed searching, not the real result. Verified against a real run: a capped deep pass
  // returned an empty "[]" this way, which would have silently looked like "nothing to check"
  // rather than "ran out of search budget." Fail loudly instead of returning a hollow ledger.
  if (response.stop_reason === "pause_turn") {
    throw new Error(`Fact-check ran out of research rounds (maxRounds=${maxRounds}) while still searching - the result would be incomplete. Try again, or raise maxRounds/maxSearchUses.`);
  }

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined the fact-check request (safety refusal).");
  }

  // Under output_config's schema constraint, EVERY text block Claude emits must independently be
  // schema-valid on its own - not just the final one - so when web search interleaves multiple
  // separate text utterances (e.g. the model revises its answer between searches), each one is a
  // complete, self-contained instance of the schema, not a fragment meant to be concatenated.
  // Verified against a real run where a re-verification pass emitted three sequential text blocks
  // ("[]", "[]", " []") - naively joining them produced invalid JSON ("[]\n[]\n []"); only the
  // last one (the model's final, most-informed answer) should be used.
  const textBlocks = response.content.filter(block => block.type === "text");
  const text = (textBlocks[textBlocks.length - 1]?.text || "").trim();
  if (!text) throw new Error("Claude returned no text: " + JSON.stringify(response).slice(0, 300));
  return text;
}

// Claude (like most LLMs) sometimes emits a raw, unescaped newline/tab inside a JSON string
// value - readable, but invalid per strict JSON. Rather than reject the whole response, walk
// the text tracking whether we're inside a string literal (respecting \" escapes) and escape
// any raw control character (0x00-0x1F) found there.
function escapeControlCharsInStrings(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      const code = text.charCodeAt(i);
      if (code < 0x20) {
        if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function parseJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = Math.min(...["[", "{"].map(c => {
    const i = cleaned.indexOf(c);
    return i === -1 ? Infinity : i;
  }));
  if (start === Infinity) throw new Error("Model returned no JSON: " + cleaned.slice(0, 200));
  const jsonSlice = cleaned.slice(start);
  try {
    return JSON.parse(jsonSlice);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(jsonSlice));
  }
}

// Strip tags/scripts down to plain text so the model reasons about prose, not markup - keeps
// the prompt smaller and stops it trying to "fix" CSS classes it has no business touching.
function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// JSON Schema for one ledger entry, enforced via output_config.format (see callClaude above).
// Nullable fields use anyOf per the API's documented JSON Schema subset - a bare
// `"type": ["string", "null"]` array is not in that subset.
const LEDGER_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      claim: { type: "string", description: "Short description of what is being checked" },
      report_value: {
        type: "string",
        description: "The EXACT verbatim phrase or figure as it appears in the source text, character-for-character, so it can be located with a plain string search",
      },
      verdict: { type: "string", enum: ["confirmed", "updated", "uncertain"] },
      current_value: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "The up-to-date figure/wording, only when verdict is 'updated'; null otherwise",
      },
      disclaimer: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "A short French caveat sentence, only when verdict is 'uncertain'; null otherwise",
      },
      source_name: { type: "string" },
      source_url: { type: "string" },
      checked_date: { type: "string" },
      note: { type: "string", description: "One sentence explaining the verdict" },
    },
    required: ["claim", "report_value", "verdict", "current_value", "disclaimer", "source_name", "source_url", "checked_date", "note"],
    additionalProperties: false,
  },
};

/**
 * Ask the model to fact-check every checkable claim in the report against live sources.
 * Returns a ledger only (small, reliable JSON) - applying edits to the html is done
 * deterministically by applyLedger() below, never by asking the model to echo back a
 * 100KB+ document verbatim (unreliable and expensive for an LLM, and exactly the kind of
 * mechanical text surgery plain code should own instead).
 */
export async function checkFacts(html, { today = new Date().toISOString().slice(0, 10), deep = false } = {}) {
  const text = extractText(html);
  const system = `You are a fact-checking analyst for a Luxembourg real-estate market report. ${SOURCE_HIERARCHY}
Today's date is ${today}. Use live web search for every checkable figure - do not rely on memory alone, and never invent a source or URL.`;

  // "deep" backs the "totally update the document" regenerate feature (see regenerateReport
  // below): it widens the check from "material, checkable figures" to every claim including
  // narrative/trend language and dated phrasing, and drops the 60k-char truncation so a full
  // report is reviewed end to end, not just its first ~60k characters.
  const scopeLine = deep
    ? `Fact-check EVERY checkable claim in this report, comprehensively: prices, indices, transaction volumes, mortgage rates, tax thresholds, government measures and their legislative status, any other quantitative claim, AND narrative/trend statements ("the market is stabilizing", "volumes remain depressed", etc.) and dated phrasing (e.g. a reference to "Q1 2026" or "as of [date]") that may now be stale. Err on the side of checking more claims, not fewer - this is a full review, not a headline-figures pass.`
    : `Fact-check every material, checkable figure: prices, indices, transaction volumes, mortgage rates, tax thresholds, government measures and their legislative status, and any other quantitative claim.`;

  const prompt = `Below is the plain-text content of a Luxembourg residential real-estate market report (French/English, duplicated). ${scopeLine} Return one ledger entry per checked claim.

Rules:
- Only mark "updated" when a reputable source (see hierarchy) clearly gives a different current figure - never guess.
- Mark "uncertain" (with a disclaimer) rather than "updated" when sources conflict or nothing newer could be found - do not silently change a figure without a source backing the change.
- "report_value" must match the text below character-for-character.
- Use "${today}" as checked_date on every entry.${deep ? `
- Search efficiently: group related claims (e.g. several figures from the same source/page) into as few searches as possible rather than one search per claim.` : ""}

REPORT TEXT:
"""
${deep ? text : text.slice(0, 60000)}
"""`;

  // Deep mode's wider scope genuinely needs more research than a tight round/search cap can
  // finish within (verified: capping at maxRounds=2 caused a real run to exhaust its budget
  // mid-research and fail outright, without meaningfully reducing total time - the round-trip
  // cost is dominated by search latency either way). regenerateReport (the only deep caller) now
  // runs as a background job with progress polling specifically so a 15-25 minute reliable run is
  // an acceptable trade, rather than a fast-but-unreliable one. maxTokens stays the same as the
  // normal pass - ledger JSON output was never the bottleneck (even the widest real run produced
  // ~25K characters, well under a 32000-token budget).
  const raw = await callClaude({
    system, prompt, schema: LEDGER_SCHEMA, maxTokens: 32000,
    maxRounds: deep ? 8 : 5,
  });
  if (process.env.FACTCHECK_DEBUG) {
    console.error(`[factcheck debug] raw response length: ${raw.length}`);
    console.error(`[factcheck debug] tail: ${JSON.stringify(raw.slice(-400))}`);
  }
  const ledger = parseJSON(raw);
  if (!Array.isArray(ledger)) throw new Error("Expected a JSON array of ledger entries");
  return ledger;
}

/**
 * Deterministically applies a ledger to the report html:
 *  - "updated" entries: plain string replace of report_value -> current_value.
 *  - "uncertain" entries: inserts " <em>(disclaimer)</em>" immediately after the located text,
 *    reusing the report's own existing <em> aside convention rather than any new markup.
 *  - "confirmed" entries: no change.
 *
 * Safety rule: a replacement is only ever applied when report_value occurs EXACTLY ONCE in the
 * current html. Figures like "40 000 €" or "3,07 %" routinely repeat across a report - once in
 * prose, once in a stat tile, once in an SVG chart label - and a naive first-match replace can
 * silently edit the wrong occurrence (verified against a real run: it once overwrote SVG chart
 * markup because an unrelated "40 000 €" earlier in the document matched first). Ambiguous or
 * not-found entries are left unapplied and returned in `unapplied` for manual review - the
 * ledger itself still records every entry regardless, so nothing is lost, only left unedited.
 */
function occurrenceCount(html, needle) {
  if (!needle) return 0;
  let count = 0, from = 0;
  while (true) {
    const idx = html.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + 1;
  }
  return count;
}

// Returns { html, ledger } where each ledger entry is annotated with `applied: true|false` -
// the sidebar (public/app.js) shows unapplied entries distinctly so a reviewer knows exactly
// which claims still need a manual look, rather than that information only reaching a server log.
export function applyLedger(html, ledger) {
  let out = html;
  const annotated = [];
  for (const entry of ledger) {
    let applied = false;
    if (entry.report_value && occurrenceCount(out, entry.report_value) === 1) {
      const idx = out.indexOf(entry.report_value);
      if (entry.verdict === "updated" && entry.current_value) {
        out = out.slice(0, idx) + entry.current_value + out.slice(idx + entry.report_value.length);
        applied = true;
      } else if (entry.verdict === "uncertain" && entry.disclaimer) {
        const insertAt = idx + entry.report_value.length;
        out = out.slice(0, insertAt) + ` <em>${entry.disclaimer}</em>` + out.slice(insertAt);
        applied = true;
      }
    }
    annotated.push({ ...entry, applied });
  }
  return { html: out, ledger: annotated };
}

/**
 * Full Task 1 pipeline: check facts against live sources, then deterministically apply the
 * result. Always returns a draft-ready payload - callers decide what to do with it (seed.js
 * stores it as the initial draft; the "Run fact-check" route stores it as a refreshed draft).
 * Never publishes anything itself.
 */
export async function runFactCheck(html, opts = {}) {
  const rawLedger = await checkFacts(html, opts);
  const { html: updatedHtml, ledger } = applyLedger(html, rawLedger);
  const unappliedCount = ledger.filter(e => !e.applied && (e.current_value || e.disclaimer)).length;
  if (unappliedCount) {
    console.warn(`[factcheck] ${unappliedCount} ledger entr${unappliedCount === 1 ? "y" : "ies"} could not be located unambiguously in the html and were left unapplied - flagged in the ledger for manual review.`);
  }
  return { html: updatedHtml, ledger };
}

/**
 * "Totally update" pass: a deep, comprehensive fact-check-and-apply (not just headline figures -
 * see the `deep` flag on checkFacts) followed by a second, fully independent fact-check of the
 * result. Structure/markup is never touched by either call - only applyLedger's uniqueness-
 * checked string surgery ever edits the html (see applyLedger above), so "keep the document
 * structure" is guaranteed by construction rather than by asking the model to reproduce the
 * whole document verbatim (which would risk both corrupting markup and blowing the output token
 * budget on a report this size).
 *
 * The second pass is a genuinely separate API call with no memory of the first pass's reasoning
 * - it re-checks the *already-updated* html against live sources from scratch, so it can catch a
 * wrong "confirmed" or "updated" verdict from pass one, not just rubber-stamp it.
 */
export async function regenerateReport(html, { onProgress = () => {}, ...opts } = {}) {
  onProgress({ stage: "initial" });
  const initial = await runFactCheck(html, { ...opts, deep: true });
  onProgress({ stage: "verification" });
  const verified = await runFactCheck(initial.html, { ...opts, deep: true });
  const ledger = [
    ...initial.ledger.map(e => ({ ...e, pass: "initial" })),
    ...verified.ledger.map(e => ({ ...e, pass: "verification" })),
  ];
  return { html: verified.html, ledger };
}
