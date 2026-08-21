# B-Side Market Research & Property Intelligence

Fact-check, edit and publish B-Side market reports. Sibling service to `bside-hunter`, same
architecture (Express + JSON-file store + hand-written static frontend, shared cookie auth).

**Status: live in production** at `http://57.130.73.22:3400`, wired into the B-Side Universe
portal catalogue. See `bside-universe/README.md` → "Rolling out Market Research to production"
for the deploy-key/`.env` setup this rollout used, and § 12 for day-to-day operations
(redeploying, checking logs, rotating secrets).

## Setup

```
npm install
cp .env.example .env   # set AUTH_SECRET to the same value as the other B-Side services
npm start               # http://localhost:3400
```

On first boot with an empty `data/reports.json`, the app imports the original supplied report
(`src/seed/report-v1-original.html`) as published v1, then tries to run the AI fact-check engine
once to generate the seeded draft v2. That step needs `ANTHROPIC_API_KEY` set in `.env` — get one
at [console.anthropic.com](https://console.anthropic.com) (a separate product/billing from a
claude.ai chat subscription, which does not include API access). Without it, the server still
starts fine with just v1 published; use the "Run fact-check" button in the app once a key is
configured to generate the first draft.

## How it works

- **Fact-check** (`src/factcheck.js`): calls Claude (`claude-sonnet-5` by default) with its
  built-in web search tool to check every material figure in the report against live sources,
  following the source hierarchy in `bside-universe/B-SIDE-APPS-GUIDELINES.md`. Returns a cited
  ledger; a plain-code step then applies "updated" figures and inserts "uncertain" disclaimers
  into the html. Always produces a new **draft** — never publishes on its own. (Originally built
  on Gemini; migrated after Google's consumer API turned out to reject requests from this app's
  EU-hosted production server — Anthropic's API has no such restriction.)
- **Regenerate report** (same module, `regenerateReport()`): a deeper variant of fact-check for
  when the whole document needs bringing current, not just a few figures. First pass checks every
  claim — including narrative/trend language and dated phrasing, not just quantitative figures —
  and applies it the same deterministic, uniqueness-checked way. A second, fully independent pass
  then re-checks the updated document from scratch to verify the first pass. Structure/markup is
  never rewritten by either pass — only text is ever spliced in — so "total update" means thorough
  content coverage, not a from-scratch document regeneration. Also always lands as a draft.
  Measured at 15–25 minutes for a real report (two full passes of live web research), so it runs
  as a background job with progress polling (`GET .../regenerate-progress`) rather than one
  blocking request — same pattern as `bside-hunter`'s scan progress. Editing/publishing a report
  is locked while its regenerate job is in flight, so a manual edit can't be silently overwritten
  when the job finishes and saves.
- **Editor** (`public/editor.js`): a constrained WYSIWYG editor. The report renders in an
  isolated same-origin iframe carrying its own stylesheet, so editing is pixel-identical to the
  published page. Styling is limited to a fixed whitelist of the report's own CSS classes — no
  free colour/font controls, no inline `style=`, pasted content is stripped to plain text.
- **Versions** (`src/db.js`): each report is a lineage of versions (`published` /
  `superseded` / `draft`). Publishing a draft supersedes (never deletes) the prior published
  version and opens a fresh draft automatically. Every version stays viewable at
  `/reports/:slug/v/:n`, with a version-history bar linking between them.

## Known v1 gaps

- No `client`-role scoping — only `admin`/`hunter` can view or act on reports.
- Not yet deployed to production (see Status above).
