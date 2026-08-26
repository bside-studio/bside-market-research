/* B-Side shared help system — copied identically into bside-universe, bside-hunter,
   bside-market-research, bside-settings, bside-client-onboarding, bside-communication-hub,
   and every future B-Side application. Edit in one place, then re-sync the others.

   Two triggers, same visual style (.help-icon-btn, ICONS.info):
   - [data-help="short text"]            hover / keyboard focus / tap shows a small bubble
     next to the element. Click (or Enter/Space) pins it open until the next click elsewhere
     or Escape — needed on touch, where there is no hover.
   - [data-help-title][data-help-body]   click opens #modal-help with the full text. Use this
     for a screen's "About this screen" button, or whenever the explanation is too long for
     a bubble. Paragraphs in data-help-body are separated by a blank line.

   All bindings are delegated on `document`, so markup rendered dynamically after this file
   loads (match cards, modal bodies, etc.) works with no extra wiring.

   Requires: icons.js (ICONS.info), the .help-icon-btn/.help-tip rules in components.css, and
   a #modal-help dialog in the page markup:

     <div id="modal-help" class="dialog-backdrop" hidden>
       <div class="dialog dialog-md">
         <div class="dialog-head">
           <h2 id="help-modal-title">Help</h2>
           <button id="btn-help-close" class="btn-icon" aria-label="Close">✕</button>
         </div>
         <div id="help-modal-body" class="dialog-body"></div>
       </div>
     </div>

   To place a trigger icon, reuse ICONS.info at the small size:
     <button type="button" class="help-icon-btn" aria-label="More info"
       data-help="Minimum match score to display. Listings below this are hidden.">${ICONS.info}</button>
     <button type="button" class="help-icon-btn" aria-label="About this screen"
       data-help-title="Client Matches" data-help-body="...">${ICONS.info}</button> */

let _helpTipEl = null;
let _helpPinnedEl = null;

function helpTipEl() {
  if (_helpTipEl) return _helpTipEl;
  _helpTipEl = document.createElement("div");
  _helpTipEl.className = "help-tip";
  _helpTipEl.id = "help-tip-bubble";
  _helpTipEl.setAttribute("role", "tooltip");
  _helpTipEl.hidden = true;
  document.body.appendChild(_helpTipEl);
  return _helpTipEl;
}

function positionHelpTip(anchor) {
  const tip = helpTipEl();
  const r = anchor.getBoundingClientRect();
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function showHelpTip(el) {
  const text = el.getAttribute("data-help");
  if (!text) return;
  const tip = helpTipEl();
  tip.textContent = text;
  tip.hidden = false;
  positionHelpTip(el);
  el.setAttribute("aria-describedby", "help-tip-bubble");
}

function hideHelpTip(force) {
  if (_helpPinnedEl && !force) return;
  if (_helpTipEl) _helpTipEl.hidden = true;
  if (_helpPinnedEl) _helpPinnedEl.removeAttribute("aria-describedby");
  _helpPinnedEl = null;
}

function openHelpModal(title, body) {
  const modal = document.getElementById("modal-help");
  const titleEl = document.getElementById("help-modal-title");
  const bodyEl = document.getElementById("help-modal-body");
  if (!modal || !titleEl || !bodyEl) return;
  titleEl.textContent = title || "Help";
  bodyEl.innerHTML = (body || "")
    .split(/\n\s*\n/)
    .map(p => `<p>${p.trim()}</p>`)
    .join("");
  modal.hidden = false;
}

document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-help]");
  if (el) showHelpTip(el);
});
document.addEventListener("mouseout", (e) => {
  const el = e.target.closest("[data-help]");
  if (el && el !== _helpPinnedEl) hideHelpTip();
});
document.addEventListener("focusin", (e) => {
  const el = e.target.closest("[data-help]");
  if (el) showHelpTip(el);
});
document.addEventListener("focusout", (e) => {
  const el = e.target.closest("[data-help]");
  if (el && el !== _helpPinnedEl) hideHelpTip();
});

document.addEventListener("click", (e) => {
  const tipBtn = e.target.closest("[data-help]");
  if (tipBtn) {
    if (_helpPinnedEl === tipBtn) hideHelpTip(true);
    else { _helpPinnedEl = tipBtn; showHelpTip(tipBtn); }
    return;
  }

  const modalBtn = e.target.closest("[data-help-title]");
  if (modalBtn) {
    openHelpModal(modalBtn.getAttribute("data-help-title"), modalBtn.getAttribute("data-help-body"));
    return;
  }

  if (e.target.closest("#btn-help-close") || e.target.id === "modal-help") {
    const modal = document.getElementById("modal-help");
    if (modal) modal.hidden = true;
  }

  if (!e.target.closest(".help-tip")) hideHelpTip(true);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideHelpTip(true);
  const modal = document.getElementById("modal-help");
  if (modal && !modal.hidden) modal.hidden = true;
});

window.addEventListener("scroll", () => hideHelpTip(true), true);
window.addEventListener("resize", () => hideHelpTip(true));
