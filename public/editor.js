/**
 * Constrained WYSIWYG engine for report content.
 *
 * The report is loaded into a same-origin `srcdoc` iframe carrying its own <style> block and
 * its own trailing <script> (lang toggle, table sort, scroll progress) completely unmodified -
 * so editing view === publish view, pixel for pixel and behaviour for behaviour. The only two
 * containers made editable are #fr-version and #en-version (the report's own top-level content
 * divs); everything else (head, styles, scripts, structural chrome) is never touched.
 *
 * The toolbar can only ever set `className` from a fixed whitelist below, or use the browser's
 * native bold/italic - it never writes a `style=` attribute and never offers a colour/font
 * control. A paste handler strips incoming clipboard formatting to plain text so pasted content
 * can't smuggle in foreign styling.
 *
 * Saving never serializes the whole iframe document (the browser's HTML serializer can subtly
 * rewrite markup elsewhere). Instead, getHtml() splices the two containers' current innerHTML
 * back into the exact original html string at the `<!-- end fr-version -->` / `<!-- end
 * en-version -->` markers the report already carries, leaving every byte outside those two
 * containers untouched.
 */

export const STYLE_WHITELIST = {
  inline: [
    { cls: "keyword-gold", label: "Keyword (gold)" },
    { cls: "keyword-teal", label: "Keyword (teal)" },
    { cls: "badge-up", label: "Badge ▲ up" },
    { cls: "badge-down", label: "Badge ▼ down" },
    { cls: "badge-flat", label: "Badge ~ flat" },
  ],
  block: [
    { cls: "buyer-box", label: "Buyer box" },
    { cls: "info-box", label: "Info box" },
    { cls: "highlight-row", label: "Highlight row (table)" },
    { cls: "section-subtitle", label: "Section subtitle" },
    { cls: "sources-note", label: "Sources note" },
  ],
};

const EDITABLE_IDS = ["fr-version", "en-version"];
const DUPLICATABLE_SELECTOR = "tr, .mover-item, .stat-tile, .scenario-card";

function findContainerMarkers(html, id) {
  const openTag = new RegExp(`<div id="${id}"[^>]*>`).exec(html);
  if (!openTag) return null;
  const contentStart = openTag.index + openTag[0].length;
  const endMarker = `<!-- end ${id} -->`;
  const closeDiv = "</div>" + endMarker;
  const closeIdx = html.indexOf(closeDiv, contentStart);
  if (closeIdx === -1) return null;
  return { contentStart, contentEnd: closeIdx, closeTagEnd: closeIdx + closeDiv.length };
}

export function createEditor(iframeEl) {
  let doc = null;
  let sourceHtml = "";
  let onChangeCb = null;

  function load(html) {
    sourceHtml = html;
    return new Promise((resolve) => {
      const onLoad = () => {
        iframeEl.removeEventListener("load", onLoad);
        doc = iframeEl.contentDocument;
        for (const id of EDITABLE_IDS) {
          const el = doc.getElementById(id);
          if (el) el.setAttribute("contenteditable", "true");
        }
        // Prevent accidental navigation while editing without touching saved markup - this is
        // an event listener, not a DOM/attribute mutation, so it never leaks into getHtml().
        doc.addEventListener("click", (e) => {
          if (e.target.closest("a")) e.preventDefault();
        }, true);
        wirePasteHandler();
        doc.addEventListener("input", () => onChangeCb && onChangeCb());
        resolve();
      };
      iframeEl.addEventListener("load", onLoad);
      iframeEl.setAttribute("srcdoc", html);
    });
  }

  function wirePasteHandler() {
    doc.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || doc.defaultView.clipboardData).getData("text/plain");
      doc.execCommand("insertText", false, text);
    });
  }

  function getHtml() {
    let out = sourceHtml;
    // Replace from the end backwards so earlier offsets stay valid as the string length changes.
    for (const id of [...EDITABLE_IDS].reverse()) {
      const el = doc.getElementById(id);
      const markers = findContainerMarkers(out, id);
      if (!el || !markers) continue;
      out = out.slice(0, markers.contentStart) + el.innerHTML + out.slice(markers.contentEnd);
    }
    return out;
  }

  function onChange(cb) { onChangeCb = cb; }

  function focusedRange() {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    return sel.getRangeAt(0);
  }

  function toggleBold() { doc.execCommand("bold"); onChangeCb && onChangeCb(); }
  function toggleItalic() { doc.execCommand("italic"); onChangeCb && onChangeCb(); }

  function applyInlineClass(cls) {
    const range = focusedRange();
    if (!range || range.collapsed) return;
    const span = doc.createElement("span");
    span.className = cls;
    try {
      range.surroundContents(span);
    } catch {
      // Selection crosses element boundaries (surroundContents can't handle that) - extract and
      // re-wrap instead, which tolerates partial/multi-node selections.
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    onChangeCb && onChangeCb();
  }

  function applyBlockClass(cls) {
    const range = focusedRange();
    if (!range) return;
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const block = node && node.closest("p, div, tr, li, section, article");
    if (!block) return;
    block.classList.add(cls);
    onChangeCb && onChangeCb();
  }

  function clearFormatting() {
    doc.execCommand("removeFormat");
    const range = focusedRange();
    if (range) {
      const container = range.commonAncestorContainer;
      const root = container.nodeType === 1 ? container : container.parentElement;
      if (root) {
        root.querySelectorAll("span[class]").forEach((span) => {
          const parent = span.parentNode;
          while (span.firstChild) parent.insertBefore(span.firstChild, span);
          parent.removeChild(span);
        });
      }
    }
    onChangeCb && onChangeCb();
  }

  function duplicateBlock() {
    const range = focusedRange();
    if (!range) return;
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const block = node && node.closest(DUPLICATABLE_SELECTOR);
    if (!block) return;
    const clone = block.cloneNode(true);
    block.after(clone);
    onChangeCb && onChangeCb();
  }

  function deleteBlock() {
    const range = focusedRange();
    if (!range) return;
    const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const block = node && node.closest(DUPLICATABLE_SELECTOR);
    if (!block) return;
    block.remove();
    onChangeCb && onChangeCb();
  }

  return {
    load, getHtml, onChange,
    toggleBold, toggleItalic, applyInlineClass, applyBlockClass, clearFormatting,
    duplicateBlock, deleteBlock,
  };
}
