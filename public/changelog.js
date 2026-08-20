window.CHANGELOG = [
  {
    version: "1.2",
    date: "2026-08-20",
    changes: [
      "Fact-check engine migrated from Gemini to Claude (claude-sonnet-5 by default), using Claude's built-in web search tool. Gemini's consumer API was rejecting every request from this app's EU-hosted production server; Anthropic's API has no such restriction. \"Run fact-check\" now actually works in production.",
      "Requires an ANTHROPIC_API_KEY instead of GEMINI_API_KEY - see the README for how to get one (it's a separate product/billing from a claude.ai chat subscription).",
    ],
  },
  {
    version: "1.1",
    date: "2026-08-20",
    changes: [
      "New \"New draft (no AI)\" action: creates an editable draft directly from the published version without calling the fact-check engine, so editing is never blocked on Gemini being reachable (its consumer API currently rejects requests from some server regions, including this app's production host).",
      "\"Run fact-check\" now always refreshes the version list after it finishes, even if the AI call fails - a draft is created either way (the server always did this; the browser just wasn't showing it), so a failed fact-check no longer looks like a dead end.",
    ],
  },
  {
    version: "1.0",
    date: "2026-08-20",
    changes: [
      "Initial release of B-Side Market Research & Property Intelligence.",
      "AI-driven fact-check engine (Gemini + Google Search grounding): checks every material figure in a report against live, reputable sources following the B-Side source hierarchy, and returns a cited ledger (confirmed / updated / uncertain) - never auto-published, always lands as a draft for review.",
      "Constrained WYSIWYG editor: edits the report in an isolated, pixel-identical view; styling is limited to a fixed whitelist of the report's own existing CSS classes (no free colour/font controls, no inline styles, pasted content is stripped to plain text).",
      "Version history: publishing a draft supersedes (never deletes) the previous published version and opens a fresh draft automatically; every version is viewable and linked from the report page and the app.",
      "Imported the original T1 2026 Luxembourg residential market report as the seed published version.",
    ],
  },
];
