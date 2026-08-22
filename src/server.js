import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { q } from "./db.js";
import { runFactCheck, regenerateReport } from "./factcheck.js";
import { seedIfEmpty } from "./seed/seed.js";
import { requireAuth, requireRole } from "./authMiddleware.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Behind Caddy (see bside-universe/infra/Caddyfile) - only Caddy can reach this container at all
// (it has no host-published port of its own), so trusting the proxy here just means trusting
// Caddy, not an arbitrary client. Needed so req.protocol correctly reports "https" (Caddy sets
// x-forwarded-proto) instead of always "http", which is what the actual container-to-Caddy
// connection uses internally.
app.set("trust proxy", true);
app.use(express.json({ limit: "10mb" })); // report html round-trips through PUT bodies
app.use(express.static(path.join(__dirname, "..", "public")));

// Shared across /fact-check and /regenerate - both call the paid AI API and both write to the
// same draft version, so they must never run concurrently (for either report or across reports).
// Also guards manual edit/publish while set (see PUT .../versions/:n below) - /regenerate runs in
// the background for up to ~20 minutes (see aiProgress), so without this a manual edit made mid-
// run would get silently overwritten when the background job finishes and saves its result.
let aiBusy = false;
let aiProgress = null;

/* ---------- API ---------- */

app.get("/api/config", (_req, res) => {
  res.json({
    universeUrl: process.env.BSIDE_UNIVERSE_URL || "http://localhost:3100",
    settingsUrl: process.env.BSIDE_SETTINGS_URL || "http://localhost:3300",
  });
});

// Everything below requires a valid session/service token, same pattern as bside-hunter.
app.use("/api", requireAuth);

app.get("/api/reports", (_req, res) => {
  res.json({ ok: true, reports: q.listReports.all(), user: { email: _req.user.email, role: _req.user.role } });
});

app.get("/api/reports/:slug", (req, res) => {
  const report = q.getReport.get(req.params.slug);
  if (!report) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, report });
});

app.get("/api/reports/:slug/versions/:n", (req, res) => {
  const version = q.getVersion.get(req.params.slug, req.params.n);
  if (!version) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, version });
});

app.put("/api/reports/:slug/versions/:n", requireRole("admin", "hunter"), (req, res) => {
  if (aiBusy) return res.status(409).json({ ok: false, error: "An AI operation is running against this report's draft - wait for it to finish before editing, so it doesn't get overwritten." });
  const { html, note } = req.body;
  try {
    const version = q.updateDraft.run(req.params.slug, req.params.n, { html, note });
    res.json({ ok: true, version });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/reports/:slug/versions/:n/publish", requireRole("admin", "hunter"), (req, res) => {
  if (aiBusy) return res.status(409).json({ ok: false, error: "An AI operation is running against this report's draft - wait for it to finish before publishing." });
  try {
    const result = q.publishVersion.run(req.params.slug, req.params.n);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Runs the AI fact-check pipeline against the currently published version and stores the
// result on the lineage's draft version (creating one if none exists). Guarded so a second
// click can't overlap a run already in flight - mirrors Hunter's /api/scan busy-flag pattern.
// Never publishes anything; the result always lands as a draft for human review.
app.post("/api/reports/:slug/fact-check", requireRole("admin", "hunter"), async (req, res) => {
  if (aiBusy) return res.status(409).json({ ok: false, error: "An AI operation is already running - please wait." });
  const report = q.getReport.get(req.params.slug);
  if (!report) return res.status(404).json({ ok: false, error: "not found" });
  const published = q.getPublished.get(req.params.slug);
  if (!published) return res.status(400).json({ ok: false, error: "no published version to check against" });

  const draft = getOrCreateDraft(req.params.slug, report, published, req.user);

  aiBusy = true;
  try {
    const { html, ledger } = await runFactCheck(published.html);
    const version = q.setDraftFactCheck.run(req.params.slug, draft.n, { html, ledger, source: "fact-check" });
    res.json({ ok: true, version });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    aiBusy = false;
  }
});

// "Totally update" the document: a deep, comprehensive fact-check-and-apply pass (not just
// headline figures - covers narrative/trend language too), followed by a fully independent
// second fact-check of the result to verify it. Document structure/markup is never rewritten -
// only the same uniqueness-checked text surgery runFactCheck already uses - so this differs from
// "Run fact-check" in thoroughness and in adding an independent verification pass, not in risk
// to the document's structure. Always lands as a draft; never publishes.
//
// Measured against the real seed report: this genuinely takes 15-25 minutes (two full passes,
// each doing many live web searches). A single blocking HTTP request that long is a bad idea -
// browser/proxy timeouts aside, a dropped connection would lose the whole run. So this route
// starts the job and returns immediately (like Hunter's /api/scan + /api/scan-progress); the
// frontend polls /regenerate-progress and only refreshes once aiProgress.active is false.
app.post("/api/reports/:slug/regenerate", requireRole("admin", "hunter"), (req, res) => {
  if (aiBusy) return res.status(409).json({ ok: false, error: "An AI operation is already running - please wait." });
  const { slug } = req.params;
  const report = q.getReport.get(slug);
  if (!report) return res.status(404).json({ ok: false, error: "not found" });
  const published = q.getPublished.get(slug);
  if (!published) return res.status(400).json({ ok: false, error: "no published version to regenerate from" });

  const draft = getOrCreateDraft(slug, report, published, req.user);

  aiBusy = true;
  aiProgress = { active: true, slug, stage: "initial", startedAt: new Date().toISOString(), error: null };
  res.json({ ok: true, started: true, version: draft });

  // The response above has already been sent - this runs detached, so it must never throw
  // uncaught (there's no request left to reject); outcome is recorded in aiProgress instead.
  (async () => {
    try {
      const { html, ledger } = await regenerateReport(published.html, {
        onProgress: (p) => { aiProgress = { ...aiProgress, ...p }; },
      });
      q.setDraftFactCheck.run(slug, draft.n, { html, ledger, source: "regenerate" });
      aiProgress = { active: false, slug, stage: "done", error: null, finishedAt: new Date().toISOString() };
    } catch (e) {
      aiProgress = { active: false, slug, stage: "error", error: e.message, finishedAt: new Date().toISOString() };
    } finally {
      aiBusy = false;
    }
  })();
});

app.get("/api/reports/:slug/regenerate-progress", (req, res) => {
  if (aiProgress && aiProgress.slug !== req.params.slug) return res.json({ ok: true, active: false });
  res.json({ ok: true, ...(aiProgress || { active: false }) });
});

// Creates (or returns the existing) draft cloned from the published version, with no AI
// involved at all - so editing is never blocked on the fact-check engine being reachable
// (an AI provider being unreachable from this server's region, rate-limited, or simply down
// should never be a reason a reviewer can't get a draft to hand-edit).
function getOrCreateDraft(slug, report, published, user) {
  const existing = report.versions.find(v => v.status === "draft");
  if (existing) return existing;
  return q.addVersion.run(slug, {
    html: published.html, status: "draft", note: "", fact_check: null,
    source: "manual", author: user.email || "system",
  });
}

app.post("/api/reports/:slug/draft", requireRole("admin", "hunter"), (req, res) => {
  const report = q.getReport.get(req.params.slug);
  if (!report) return res.status(404).json({ ok: false, error: "not found" });
  const published = q.getPublished.get(req.params.slug);
  if (!published) return res.status(400).json({ ok: false, error: "no published version to draft from" });
  const draft = getOrCreateDraft(req.params.slug, report, published, req.user);
  res.json({ ok: true, version: draft });
});

/* ---------- Standalone report rendering (published page + version history) ---------- */

function versionBanner(report, currentN, currentStatus) {
  const items = [...report.versions].sort((a, b) => b.n - a.n).map(v => {
    const isCurrent = v.n === currentN;
    const label = v.status === "published" ? "Published" : v.status === "superseded" ? "Superseded" : "Draft";
    const href = `/reports/${report.slug}/v/${v.n}`;
    return `<a href="${href}" style="color:${isCurrent ? "#D3AF3C" : "#C3D2DD"};text-decoration:${isCurrent ? "underline" : "none"};margin-right:14px;white-space:nowrap;">v${v.n} · ${label}</a>`;
  }).join("");
  return `<div style="position:sticky;top:0;z-index:1000;background:#335C80;color:#fff;font:13px/1.4 'Jost',system-ui,sans-serif;padding:8px 20px;display:flex;flex-wrap:wrap;gap:4px;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,.15);">
    <strong style="margin-right:14px;">${report.title}</strong>
    <span style="color:#C3D2DD;margin-right:14px;">Viewing v${currentN} (${currentStatus})</span>
    ${items}
    <a href="/" style="color:#D3AF3C;margin-left:auto;">← Market Research app</a>
  </div>`;
}

function withBanner(html, banner) {
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  return banner + html;
}

app.get("/reports/:slug", requireAuth, (req, res) => {
  const report = q.getReport.get(req.params.slug);
  const version = q.getPublished.get(req.params.slug);
  if (!report || !version) return res.status(404).send("No published version yet.");
  res.send(withBanner(version.html, versionBanner(report, version.n, "published")));
});

app.get("/reports/:slug/v/:n", requireAuth, (req, res) => {
  const report = q.getReport.get(req.params.slug);
  const version = q.getVersion.get(req.params.slug, req.params.n);
  if (!report || !version) return res.status(404).send("Version not found.");
  res.send(withBanner(version.html, versionBanner(report, version.n, version.status)));
});

/* ---------- Boot ---------- */

const port = process.env.PORT || 3400;
seedIfEmpty()
  .catch(e => console.error("[seed] failed:", e.message))
  .finally(() => {
    app.listen(port, () => {
      console.log(`\nB-Side Market Research & Property Intelligence running -> http://localhost:${port}`);
    });
  });
