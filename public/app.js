import { createEditor, STYLE_WHITELIST } from "./editor.js";

/* ---------- API helper ---------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.loginUrl) { window.location.href = data.loginUrl; return new Promise(() => {}); }
  }
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

/* ---------- state ---------- */

const state = { user: null, reports: [], report: null, version: null, editor: null, dirty: false };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- views ---------- */

const views = { reports: $("#view-reports"), detail: $("#view-detail"), editor: $("#view-editor") };
function showView(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
}

/* ---------- reports list ---------- */

function statusPill(status) {
  const map = { published: "tag-accent", superseded: "tag-neutral", draft: "tag-neutral" };
  return `<span class="tag ${map[status] || "tag-neutral"}">${status}</span>`;
}

function renderReportsGrid() {
  const grid = $("#reports-grid");
  grid.innerHTML = "";
  for (const r of state.reports) {
    const card = document.createElement("div");
    card.className = "card report-card";
    card.innerHTML = `
      <h3>${r.title}</h3>
      <div class="report-card-meta">
        ${r.published ? `${statusPill("published")} v${r.published.n} · ${new Date(r.published.published_at).toLocaleDateString()}` : `<span class="tag tag-neutral">no published version yet</span>`}
        ${r.draft ? statusPill("draft") + ` v${r.draft.n}` : ""}
      </div>
      <div class="report-card-meta">${r.versionCount} version${r.versionCount === 1 ? "" : "s"} total</div>
      <button class="ghost btn-open" data-slug="${r.slug}">Open →</button>
    `;
    grid.appendChild(card);
  }
}

async function loadReportsList() {
  const data = await api("/api/reports");
  state.user = data.user;
  state.reports = data.reports;
  renderUserBadge();
  renderReportsGrid();
  showView("reports");
}

/* ---------- report detail (version history) ---------- */

async function openReport(slug) {
  const data = await api(`/api/reports/${slug}`);
  state.report = data.report;
  renderDetail();
  showView("detail");
}

function renderDetail() {
  const r = state.report;
  $("#detail-title").textContent = r.title;
  const list = $("#version-list");
  list.innerHTML = "";
  const sorted = [...r.versions].sort((a, b) => b.n - a.n);
  for (const v of sorted) {
    const row = document.createElement("div");
    row.className = "version-row";
    row.innerHTML = `
      <div class="version-row-main">
        <b>v${v.n}</b> ${statusPill(v.status)}
        <span class="version-note">${v.note || ""}</span>
        <span class="version-date">${new Date(v.created_at).toLocaleString()} · ${v.author || ""}</span>
        ${v.hasFactCheck ? `<span class="tag tag-neutral">fact-checked</span>` : ""}
      </div>
      <div class="version-row-actions">
        <a class="ghost btn-sm" href="/reports/${r.slug}/v/${v.n}" target="_blank">View</a>
        ${v.status === "draft" ? `<button class="primary btn-sm btn-edit" data-n="${v.n}">Edit</button>` : ""}
      </div>
    `;
    list.appendChild(row);
  }
  // "New draft" only makes sense when there isn't one already - once a draft exists, use its
  // own Edit button above instead of creating a second one.
  $("#btn-new-draft").hidden = r.versions.some(v => v.status === "draft");
}

/* ---------- editor ---------- */

function buildStyleDropdown() {
  const sel = $("#style-select");
  sel.innerHTML = `<option value="">Style ▾</option>`;
  const addGroup = (label, items) => {
    const group = document.createElement("optgroup");
    group.label = label;
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = `${label === "Inline" ? "inline" : "block"}:${it.cls}`;
      opt.textContent = it.label;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  };
  addGroup("Inline", STYLE_WHITELIST.inline);
  addGroup("Block", STYLE_WHITELIST.block);
}

function renderFactCheckSidebar(version) {
  const aside = $("#factcheck-sidebar");
  const ledger = version.fact_check || [];
  if (!ledger.length) {
    aside.innerHTML = `<p class="sidebar-empty">No fact-check ledger for this version yet. Click "Run fact-check" to generate one.</p>`;
    return;
  }
  const verdictClass = { confirmed: "tag-accent", updated: "tag-neutral", uncertain: "tag-neutral" };
  const needsManualApply = e => (e.current_value || e.disclaimer) && !e.applied;
  const passLabel = { initial: "Initial rewrite", verification: "Independent verification" };
  const ledgerHead = `<h4 class="help-label">Fact-check ledger
    <button type="button" class="help-icon-btn" aria-label="More info" data-help="Confirmed = left as-is. Updated = figure corrected automatically. Uncertain = a short caveat was inserted. &quot;Needs manual apply&quot; means the exact wording wasn't found uniquely in the text, so review that one by hand.">${ICONS.info}</button>
  </h4>`;
  aside.innerHTML = ledgerHead + ledger.map(e => `
    <div class="ledger-entry">
      <div class="ledger-claim">${e.claim || ""}</div>
      <span class="tag ${verdictClass[e.verdict] || "tag-neutral"}">${e.verdict || "unknown"}</span>
      ${needsManualApply(e) ? `<span class="tag tag-accent" title="The exact wording wasn't found uniquely in the text, so this wasn't auto-applied - edit it in manually if it checks out.">needs manual apply</span>` : ""}
      ${e.current_value ? `<div class="ledger-detail"><b>Now:</b> ${e.current_value}</div>` : ""}
      ${e.note ? `<div class="ledger-detail">${e.note}</div>` : ""}
      ${e.source_url ? `<div class="ledger-detail"><a href="${e.source_url}" target="_blank" rel="noopener">${e.source_name || e.source_url}</a> · ${e.checked_date || ""}</div>` : ""}
      ${e.pass ? `<div class="ledger-detail"><b>Pass:</b> ${passLabel[e.pass] || e.pass}</div>` : ""}
    </div>
  `).join("");
}

async function openEditor(slug, n) {
  const data = await api(`/api/reports/${slug}/versions/${n}`);
  state.version = data.version;
  state.dirty = false;

  $("#editor-report-title").textContent = `${state.report.title} — v${n} (draft)`;
  const frame = $("#editor-frame");
  state.editor = createEditor(frame);
  await state.editor.load(data.version.html);
  state.editor.onChange(() => { state.dirty = true; setSaveIndicator("Unsaved changes"); });

  renderFactCheckSidebar(data.version);
  setSaveIndicator("Saved");
  showView("editor");
}

function setSaveIndicator(text) { $("#save-indicator").textContent = text; }

async function saveDraft() {
  if (!state.version) return;
  const html = state.editor.getHtml();
  try {
    await api(`/api/reports/${state.report.slug}/versions/${state.version.n}`, {
      method: "PUT", body: JSON.stringify({ html }),
    });
  } catch (e) {
    setSaveIndicator("Not saved");
    alert("Could not save: " + e.message);
    throw e;
  }
  state.dirty = false;
  setSaveIndicator("Saved");
}

async function discardChanges() {
  if (state.dirty && !confirm("Discard unsaved changes and reload this version from the server?")) return;
  await openEditor(state.report.slug, state.version.n);
}

async function publishVersion() {
  if (!confirm(`Publish v${state.version.n}? The current published version will be kept in history as "superseded".`)) return;
  try {
    if (state.dirty) await saveDraft();
    await api(`/api/reports/${state.report.slug}/versions/${state.version.n}/publish`, { method: "POST" });
  } catch (e) {
    alert("Could not publish: " + e.message);
    return;
  }
  await openReport(state.report.slug);
}

async function createDraft() {
  const data = await api(`/api/reports/${state.report.slug}/draft`, { method: "POST" });
  await openReport(state.report.slug);
  await openEditor(state.report.slug, data.version.n);
}

async function runFactCheck() {
  const btn = $("#btn-run-factcheck");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Running fact-check…";
  let failed = null;
  try {
    await api(`/api/reports/${state.report.slug}/fact-check`, { method: "POST" });
  } catch (e) {
    failed = e;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
  // The server always opens/reuses a draft BEFORE calling the AI, specifically so a failed
  // fact-check still leaves something editable behind - refresh regardless of outcome so that
  // draft (and its Edit button) actually shows up, instead of only on the success path.
  await openReport(state.report.slug);
  if (failed) {
    alert("Fact-check failed: " + failed.message + "\n\nA draft was still created from the published version (without AI corrections) - you can edit it directly below.");
  }
}

const STAGE_LABEL = { initial: "Initial deep pass…", verification: "Independent verification…" };

async function regenerateReportAction() {
  if (!confirm("This runs a full, comprehensive fact-check across the entire document (figures AND narrative language, not just headline numbers), then an independent second pass to verify the result. It genuinely takes 15-25 minutes - you can navigate away and come back, it keeps running on the server. Editing and publishing this report are locked while it runs, so it can't be overwritten mid-run. Continue?")) return;
  const slug = state.report.slug; // captured now - the user may navigate to a different report while this polls
  const btn = $("#btn-regenerate");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "Starting…";
  try {
    await api(`/api/reports/${slug}/regenerate`, { method: "POST" });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert("Could not start regenerate: " + e.message);
    return;
  }
  await pollRegenerateProgress(slug, btn, original);
}

async function pollRegenerateProgress(slug, btn, original) {
  while (true) {
    let data;
    try {
      data = await api(`/api/reports/${slug}/regenerate-progress`);
    } catch {
      break; // e.g. logged out mid-poll - stop silently, the background job keeps running server-side regardless
    }
    if (!data.active) {
      btn.disabled = false;
      btn.textContent = original;
      // Only refresh the view if the user is still looking at this report - if they navigated
      // elsewhere while this was running, the result is already saved server-side regardless.
      if (state.report && state.report.slug === slug) await openReport(slug);
      if (data.error) {
        alert(`Regenerate failed for "${slug}": ${data.error}\n\nThe draft was not changed by this run - you can edit it directly, or try again.`);
      }
      return;
    }
    btn.textContent = STAGE_LABEL[data.stage] || "Working…";
    await new Promise(r => setTimeout(r, 5000));
  }
}

/* ---------- user badge / role gating ---------- */

function renderUserBadge() {
  if (!state.user) return;
  document.body.dataset.role = state.user.role;
  $("#user-badge").innerHTML = `
    <span class="user-email">${state.user.email}</span>
    <span class="user-role">${state.user.role}</span>
  `;
}

/* ---------- changelog modal ---------- */

function renderHelpButtons() {
  for (const id of ["btn-help-reports", "btn-help-detail", "btn-help-editor"]) {
    const btn = $(`#${id}`);
    if (btn) btn.innerHTML = ICONS.info;
  }
}

function renderChangelog() {
  $("#btn-changelog").innerHTML = ICONS.history;
  const el = $("#changelog-body");
  el.innerHTML = window.CHANGELOG.map(v => `
    <div class="changelog-entry">
      <h4>v${v.version} <small>${v.date}</small></h4>
      <ul>${v.changes.map(c => `<li>${c}</li>`).join("")}</ul>
    </div>
  `).join("");
  $("#version-badge").textContent = `v${window.CHANGELOG[0].version} · ${window.CHANGELOG[0].date}`;
}

/* ---------- wire up ---------- */

function wireEvents() {
  $("#reports-grid").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-open");
    if (btn) openReport(btn.dataset.slug);
  });

  $("#version-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-edit");
    if (btn) openEditor(state.report.slug, Number(btn.dataset.n));
  });

  $("#btn-back-reports").addEventListener("click", loadReportsList);
  $("#btn-editor-back").addEventListener("click", async () => {
    if (state.dirty && !confirm("Leave without saving?")) return;
    await openReport(state.report.slug);
  });

  $("#btn-new-draft").addEventListener("click", createDraft);
  $("#btn-run-factcheck").addEventListener("click", runFactCheck);
  $("#btn-regenerate").addEventListener("click", regenerateReportAction);
  $("#btn-bold").addEventListener("click", () => state.editor.toggleBold());
  $("#btn-italic").addEventListener("click", () => state.editor.toggleItalic());
  $("#btn-clear-format").addEventListener("click", () => state.editor.clearFormatting());
  $("#btn-duplicate-block").addEventListener("click", () => state.editor.duplicateBlock());
  $("#btn-delete-block").addEventListener("click", () => state.editor.deleteBlock());
  $("#style-select").addEventListener("change", (e) => {
    const val = e.target.value;
    if (!val) return;
    const [kind, cls] = val.split(":");
    if (kind === "inline") state.editor.applyInlineClass(cls);
    else state.editor.applyBlockClass(cls);
    e.target.value = "";
  });

  $("#btn-save-draft").addEventListener("click", saveDraft);
  $("#btn-discard").addEventListener("click", discardChanges);
  $("#btn-publish").addEventListener("click", publishVersion);

  $("#btn-changelog").addEventListener("click", () => { $("#modal-changelog").hidden = false; });
  $("#modal-changelog .modal-close").addEventListener("click", () => { $("#modal-changelog").hidden = true; });

  $("#btn-back-universe").addEventListener("click", async () => {
    const cfg = await api("/api/config");
    window.location.href = `${cfg.universeUrl}/?refresh=1`;
  });
}

async function init() {
  buildStyleDropdown();
  renderChangelog();
  renderHelpButtons();
  wireEvents();
  await loadReportsList();
}

init().catch(e => {
  document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif;">Failed to load: ${e.message}</p>`;
});
