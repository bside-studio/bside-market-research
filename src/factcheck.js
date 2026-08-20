import "dotenv/config";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const SOURCE_HIERARCHY = `
Source hierarchy (highest to lowest trust) for Luxembourg real-estate figures:
1. Official/public: Observatoire de l'Habitat, Housing Ministry (logement.public.lu), STATEC, LISER, BCL, CSSF, Gouvernement.lu.
2. Professional research: CBRE, JLL, INOWAI, and documented sector reports.
3. Portal-derived: atHome.lu, Immotop.lu, Nexvia.lu, Wort.lu.
4. Agency-published: valuations, guides, newsletters from real-estate agencies.
Never present asking/listed prices as completed notarial transaction prices - they measure different things.
`.trim();

async function callGemini({ system, prompt, maxTokens, useSearch }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing - copy .env.example to .env and set it.");

  const generationConfig = { maxOutputTokens: maxTokens };
  if (MODEL.includes("2.5-flash")) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  };
  // Google Search grounding lets the model check today's actual sources instead of answering
  // from stale training data - the whole point of a fact-check feature. Field name reflects the
  // current (v1beta) Gemini REST API for 2.x models; this has not been exercised against a real
  // key in this environment, so if it errors, check https://ai.google.dev/gemini-api/docs/grounding
  // for the current tool shape before assuming the rest of the pipeline is broken.
  if (useSearch) body.tools = [{ google_search: {} }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || "").join("\n").trim();
  if (!text) throw new Error("Gemini returned no text: " + JSON.stringify(data).slice(0, 300));
  return text;
}

// Gemini (like most LLMs) sometimes emits a raw, unescaped newline/tab inside a JSON string
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

  const prompt = `Below is the plain-text content of a Luxembourg residential real-estate market report (French/English, duplicated). Fact-check every material, checkable figure: prices, indices, transaction volumes, mortgage rates, tax thresholds, government measures and their legislative status, and any other quantitative claim.

For each checked claim return one ledger entry as JSON:
{
  "claim": "short description of what is being checked",
  "report_value": "the EXACT verbatim phrase or figure as it appears in the text below (needed to locate it programmatically - copy it exactly, including punctuation)",
  "verdict": "confirmed" | "updated" | "uncertain",
  "current_value": "the up-to-date figure/wording to use if verdict is updated (omit or null otherwise)",
  "disclaimer": "a short French sentence to append as a caveat if verdict is uncertain (omit or null otherwise)",
  "source_name": "publisher name",
  "source_url": "URL of the specific source used",
  "checked_date": "${today}",
  "note": "one sentence explaining the verdict"
}

Rules:
- Only mark "updated" when a reputable source (see hierarchy) clearly gives a different current figure - never guess.
- Mark "uncertain" (with a disclaimer) rather than "updated" when sources conflict or nothing newer could be found - do not silently change a figure without a source backing the change.
- "report_value" must match the text below character-for-character so it can be found with a plain string search.
- Return JSON only: an array of ledger entries, nothing else.

REPORT TEXT:
"""
${text.slice(0, 60000)}
"""`;

  const raw = await callGemini({ system, prompt, maxTokens: 24000, useSearch: true });
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
