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
async function callClaude({ system, prompt, maxTokens, schema }) {
  const c = client();
  const userMessage = { role: "user", content: prompt };
  let messages = [userMessage];
  let response;
  const maxRounds = 5;
  for (let round = 0; round < maxRounds; round++) {
    const stream = c.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      tools: [{ type: "web_search_20260209", name: "web_search" }],
      output_config: { format: { type: "json_schema", schema } },
      messages,
    });
    response = await stream.finalMessage();
    if (response.stop_reason !== "pause_turn") break;
    messages = [userMessage, { role: "assistant", content: response.content }];
  }

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined the fact-check request (safety refusal).");
  }

  const text = response.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
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
export async function checkFacts(html, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const text = extractText(html);
  const system = `You are a fact-checking analyst for a Luxembourg real-estate market report. ${SOURCE_HIERARCHY}
Today's date is ${today}. Use live web search for every checkable figure - do not rely on memory alone, and never invent a source or URL.`;

  const prompt = `Below is the plain-text content of a Luxembourg residential real-estate market report (French/English, duplicated). Fact-check every material, checkable figure: prices, indices, transaction volumes, mortgage rates, tax thresholds, government measures and their legislative status, and any other quantitative claim. Return one ledger entry per checked claim.

Rules:
- Only mark "updated" when a reputable source (see hierarchy) clearly gives a different current figure - never guess.
- Mark "uncertain" (with a disclaimer) rather than "updated" when sources conflict or nothing newer could be found - do not silently change a figure without a source backing the change.
- "report_value" must match the text below character-for-character.
- Use "${today}" as checked_date on every entry.

REPORT TEXT:
"""
${text.slice(0, 60000)}
"""`;

  const raw = await callClaude({ system, prompt, maxTokens: 32000, schema: LEDGER_SCHEMA });
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
