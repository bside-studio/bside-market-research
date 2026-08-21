/**
 * Lightweight JSON-file data store (no native dependencies), same shape as bside-hunter's db.js.
 * Data lives in data/reports.json and is written atomically (debounced) after each change.
 *
 * A "report" is a lineage (e.g. one recurring quarterly report). Each lineage holds an
 * append-only list of "versions". Version statuses:
 *   - "published"  exactly one per lineage at a time - the current live/public version
 *   - "superseded" a version that used to be published, kept forever for history
 *   - "draft"      the single mutable working copy at the tip of the lineage
 * Only a "draft" version may be edited (PUT) or fact-checked. Publishing a draft flips it to
 * "published", demotes whatever was previously published to "superseded", and clones the
 * newly-published html into a fresh draft so editing can continue without touching history.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "reports.json");

let D = { reports: [], seq: { reports: 0, versions: 0 } };
if (fs.existsSync(FILE)) {
  try { D = JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch {
    console.error("[db] corrupt data file, starting fresh (old file kept as .bak)");
    fs.copyFileSync(FILE, FILE + ".bak");
  }
}
if (!D.seq) D.seq = { reports: 0, versions: 0 };

function writeNow() {
  const tmp = FILE + ".tmp";
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(D));
  fs.renameSync(tmp, FILE);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 150);
}
process.on("exit", () => {
  if (saveTimer) { clearTimeout(saveTimer); writeNow(); }
});

const now = () => new Date().toISOString();
const nextId = (t) => ++D.seq[t];

function findReport(slug) {
  return D.reports.find(r => r.slug === slug);
}
function findVersion(report, n) {
  return report.versions.find(v => v.n === n);
}

// Metadata-only projection of a version (no html/fact_check payload) - used for list views.
function versionMeta(v) {
  const { html, fact_check, ...meta } = v;
  return { ...meta, hasFactCheck: !!(fact_check && fact_check.length) };
}

export const q = {
  createReport: { run({ slug, title }) {
    if (findReport(slug)) throw new Error(`report "${slug}" already exists`);
    const report = { id: nextId("reports"), slug, title, versions: [] };
    D.reports.push(report);
    save();
    return report;
  } },

  listReports: { all() {
    return D.reports.map(r => {
      const published = r.versions.find(v => v.status === "published") || null;
      const draft = r.versions.find(v => v.status === "draft") || null;
      return {
        id: r.id, slug: r.slug, title: r.title,
        versionCount: r.versions.length,
        published: published ? versionMeta(published) : null,
        draft: draft ? versionMeta(draft) : null,
      };
    });
  } },

  getReport: { get(slug) {
    const r = findReport(slug);
    if (!r) return null;
    return { id: r.id, slug: r.slug, title: r.title, versions: r.versions.map(versionMeta) };
  } },

  getVersion: { get(slug, n) {
    const r = findReport(slug);
    if (!r) return null;
    return findVersion(r, Number(n)) || null;
  } },

  getPublished: { get(slug) {
    const r = findReport(slug);
    if (!r) return null;
    return r.versions.find(v => v.status === "published") || null;
  } },

  // Appends a new version. Used for the very first (seed) version of a lineage, and internally
  // by publishVersion() to open the next draft.
  addVersion: { run(slug, { html, status, note, fact_check, source, author }) {
    const r = findReport(slug);
    if (!r) throw new Error(`report "${slug}" not found`);
    const v = {
      n: r.versions.length ? Math.max(...r.versions.map(x => x.n)) + 1 : 1,
      status, html, note: note || "", fact_check: fact_check || null,
      source: source || "manual", author: author || "unknown",
      created_at: now(), published_at: status === "published" ? now() : null,
    };
    r.versions.push(v);
    save();
    return v;
  } },

  // Overwrites the html/note of a draft version in place (manual edit save).
  updateDraft: { run(slug, n, { html, note }) {
    const r = findReport(slug);
    if (!r) throw new Error(`report "${slug}" not found`);
    const v = findVersion(r, Number(n));
    if (!v) throw new Error(`version ${n} not found`);
    if (v.status !== "draft") throw new Error("only a draft version can be edited");
    if (html !== undefined) v.html = html;
    if (note !== undefined) v.note = note;
    v.updated_at = now();
    save();
    return v;
  } },

  // Replaces a draft's html/fact_check wholesale - used after a "Run fact-check" or "Regenerate
  // report" pass (source distinguishes which in the version history).
  setDraftFactCheck: { run(slug, n, { html, ledger, source }) {
    const r = findReport(slug);
    if (!r) throw new Error(`report "${slug}" not found`);
    const v = findVersion(r, Number(n));
    if (!v) throw new Error(`version ${n} not found`);
    if (v.status !== "draft") throw new Error("only a draft version can be fact-checked");
    v.html = html;
    v.fact_check = ledger;
    v.source = source || "fact-check";
    v.updated_at = now();
    save();
    return v;
  } },

  // Promotes a draft to published; demotes the prior published version to superseded; clones
  // the newly-published html into a brand new draft so editing can continue.
  publishVersion: { run(slug, n) {
    const r = findReport(slug);
    if (!r) throw new Error(`report "${slug}" not found`);
    const v = findVersion(r, Number(n));
    if (!v) throw new Error(`version ${n} not found`);
    if (v.status !== "draft") throw new Error("only a draft version can be published");

    const prevPublished = r.versions.find(x => x.status === "published");
    if (prevPublished) prevPublished.status = "superseded";

    v.status = "published";
    v.published_at = now();

    const nextDraft = {
      n: Math.max(...r.versions.map(x => x.n)) + 1,
      status: "draft", html: v.html, note: "", fact_check: null,
      source: "publish-clone", author: v.author,
      created_at: now(), published_at: null,
    };
    r.versions.push(nextDraft);
    save();
    return { published: v, newDraft: nextDraft };
  } },
};

export default { data: D };
