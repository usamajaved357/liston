"use client";

import { useEffect, useRef, useState } from "react";

// A small what-you-see editor for the description. The description is
// stored as plain text with light markers (**bold**, ==highlight==,
// [color=#hex]…[/color], [size=sm|lg|xl]…[/size]) that the eBay template
// renders; this shows those as real bold, highlight, colour and size while
// editing and writes the markers back on every change. Formatting is applied
// to the selection in place, so the caret and scroll position stay where
// they are.

const SIZE_PX: Record<string, string> = { sm: "12px", lg: "18px", xl: "22px" };
const HIGHLIGHT = "#fff59d";
export const TEXT_COLOURS = ["#e11d48", "#d97706", "#059669", "#2563eb", "#7c3aed", "#0f172a"];

type Fmt = { bold: boolean; mark: boolean; color: string | null; size: string | null };
const NONE: Fmt = { bold: false, mark: false, color: null, size: null };
const sameFmt = (a: Fmt, b: Fmt) => a.bold === b.bold && a.mark === b.mark && a.color === b.color && a.size === b.size;

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- markers → HTML (for display) -------------------------------------------

function openTags(f: Fmt) {
  let out = "";
  if (f.size) out += `<span data-size="${f.size}" style="font-size:${SIZE_PX[f.size]}">`;
  if (f.color) out += `<span style="color:${f.color}">`;
  if (f.mark) out += `<mark style="background:${HIGHLIGHT};padding:0 2px;border-radius:2px">`;
  if (f.bold) out += "<b>";
  return out;
}
function closeTags(f: Fmt) {
  let out = "";
  if (f.bold) out += "</b>";
  if (f.mark) out += "</mark>";
  if (f.color) out += "</span>";
  if (f.size) out += "</span>";
  return out;
}

export function markersToHtml(text: string): string {
  const tokens = /\*\*|==|\[color=(#[0-9a-fA-F]{6})\]|\[\/color\]|\[size=(sm|lg|xl)\]|\[\/size\]|\n/g;
  let html = "";
  let f: Fmt = { ...NONE };
  let last = 0;
  let m: RegExpExecArray | null;
  const emit = (s: string) => {
    if (!s) return;
    html += openTags(f) + escapeHtml(s) + closeTags(f);
  };
  while ((m = tokens.exec(text))) {
    emit(text.slice(last, m.index));
    last = m.index + m[0].length;
    const t = m[0];
    if (t === "\n") html += "<br>";
    else if (t === "**") f = { ...f, bold: !f.bold };
    else if (t === "==") f = { ...f, mark: !f.mark };
    else if (t === "[/color]") f = { ...f, color: null };
    else if (t === "[/size]") f = { ...f, size: null };
    else if (m[1]) f = { ...f, color: m[1].toLowerCase() };
    else if (m[2]) f = { ...f, size: m[2] };
  }
  emit(text.slice(last));
  return html || "<br>";
}

// ---- HTML → markers (for saving) --------------------------------------------

function rgbToHex(color: string): string | null {
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}
const DEFAULT_INK = new Set(["#000000", "#0f172a", "#1c1c1c", "#111827"]);

function fmtOf(el: HTMLElement, inherited: Fmt): Fmt {
  const f = { ...inherited };
  const tag = el.tagName;
  const st = el.style;
  if (tag === "B" || tag === "STRONG" || (st.fontWeight && (st.fontWeight === "bold" || Number(st.fontWeight) >= 600))) f.bold = true;
  if (tag === "MARK") f.mark = true;
  if (st.backgroundColor && st.backgroundColor !== "transparent" && st.backgroundColor !== "initial") f.mark = true;
  const colour = st.color ? rgbToHex(st.color) : el.getAttribute("color") ? rgbToHex(el.getAttribute("color")!) : null;
  if (colour) f.color = DEFAULT_INK.has(colour) ? null : colour;
  const ds = el.getAttribute("data-size");
  if (ds && SIZE_PX[ds]) f.size = ds;
  else if (st.fontSize) {
    // Browsers write keywords (xx-large) for execCommand sizes and px for
    // ours; both map onto the template's three steps.
    const fs = st.fontSize;
    if (fs.endsWith("px")) {
      const px = parseFloat(fs);
      f.size = px <= 13 ? "sm" : px >= 21 ? "xl" : px >= 16 ? "lg" : null;
    } else if (/^(xx-small|x-small|small|smaller)$/.test(fs)) f.size = "sm";
    else if (/^(xx-large|xxx-large)$/.test(fs)) f.size = "xl";
    else if (/^(large|x-large|larger)$/.test(fs)) f.size = "lg";
    else if (/^(medium|initial|inherit)$/.test(fs)) f.size = null;
  } else if (tag === "FONT" && el.getAttribute("size")) {
    const n = Number(el.getAttribute("size"));
    f.size = n <= 2 ? "sm" : n >= 6 ? "xl" : n >= 4 ? "lg" : null;
  }
  return f;
}

function openMarkers(f: Fmt) {
  return (f.size ? `[size=${f.size}]` : "") + (f.color ? `[color=${f.color}]` : "") + (f.mark ? "==" : "") + (f.bold ? "**" : "");
}
function closeMarkers(f: Fmt) {
  return (f.bold ? "**" : "") + (f.mark ? "==" : "") + (f.color ? "[/color]" : "") + (f.size ? "[/size]" : "");
}

const BLOCK = new Set(["DIV", "P", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "PRE"]);

export function htmlToMarkers(root: HTMLElement): string {
  // Runs of text with their formatting; markers are opened and closed around
  // changes, and always closed at a line end (the template's markers never
  // span lines).
  const runs: { text: string; f: Fmt }[] = [];
  const walk = (node: Node, f: Fmt, first: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      runs.push({ text: node.textContent || "", f });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      runs.push({ text: "\n", f: NONE });
      return;
    }
    const block = BLOCK.has(el.tagName);
    if (block && !first) runs.push({ text: "\n", f: NONE });
    const inner = fmtOf(el, f);
    let firstChild = true;
    el.childNodes.forEach((child) => {
      walk(child, inner, firstChild && block);
      firstChild = false;
    });
  };
  let firstTop = true;
  root.childNodes.forEach((child) => {
    walk(child, NONE, firstTop);
    firstTop = false;
  });

  let out = "";
  let open: Fmt = { ...NONE };
  for (const run of runs) {
    if (run.text === "\n") {
      out += closeMarkers(open) + "\n";
      open = { ...NONE };
      continue;
    }
    if (!run.text) continue;
    // Whitespace-only runs take no formatting: "** **" would be a broken marker.
    const f = run.text.trim() ? run.f : open;
    if (!sameFmt(f, open)) {
      out += closeMarkers(open) + openMarkers(f);
      open = f;
    }
    out += run.text;
  }
  out += closeMarkers(open);
  // A trailing <br> the browser keeps after Enter is not content.
  return out.replace(/\n$/, "");
}

// ---- the editor -------------------------------------------------------------

export function RichTextEditor({
  value,
  onChange,
  disabled,
  minHeight = "16rem",
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  minHeight?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // What the editor last reported; the DOM is only rewritten when the value
  // changes from OUTSIDE (a reset, an accepted AI proposal), never after the
  // seller's own keystroke — that would drop the caret and scroll position.
  const lastEmitted = useRef<string | null>(null);
  const [showColours, setShowColours] = useState(false);
  const [active, setActive] = useState<Fmt>(NONE);

  useEffect(() => {
    if (!ref.current || value === lastEmitted.current) return;
    ref.current.innerHTML = markersToHtml(value);
    lastEmitted.current = value;
  }, [value]);

  function emit() {
    if (!ref.current) return;
    const next = htmlToMarkers(ref.current);
    lastEmitted.current = next;
    onChange(next);
    readActive();
  }

  // Which formats the caret is in, for the toolbar's pressed states.
  function readActive() {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !ref.current?.contains(sel.anchorNode)) return;
    let el: Node | null = sel.anchorNode;
    const chain: HTMLElement[] = [];
    while (el && el !== ref.current) {
      if (el.nodeType === Node.ELEMENT_NODE) chain.unshift(el as HTMLElement);
      el = el.parentNode;
    }
    let f: Fmt = { ...NONE };
    for (const e of chain) f = fmtOf(e, f);
    setActive(f);
  }

  function exec(command: string, arg?: string) {
    // preventScroll: refocusing the editor must not jump the page to it.
    ref.current?.focus({ preventScroll: true });
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(command, false, arg);
    emit();
  }

  const toggleBold = () => exec("bold");
  const toggleHighlight = () => exec("hiliteColor", active.mark ? "transparent" : HIGHLIGHT);
  const setSize = (size: "sm" | "lg" | "xl" | null) => {
    exec("fontSize", size === "sm" ? "2" : size === "lg" ? "5" : size === "xl" ? "7" : "3");
    // The browser wrote a keyword size; show the template's real pixel size
    // instead so the editor matches what eBay will render.
    ref.current?.querySelectorAll<HTMLElement>("[style*='font-size']").forEach((el) => {
      const f = fmtOf(el, NONE);
      el.style.fontSize = f.size ? SIZE_PX[f.size] : "";
      if (f.size) el.setAttribute("data-size", f.size);
      else el.removeAttribute("data-size");
    });
    emit();
  };
  const setColour = (hex: string | null) => {
    exec("foreColor", hex || "#0f172a");
    setShowColours(false);
  };

  const tool = (on: boolean) =>
    `flex h-8 min-w-8 items-center justify-center rounded-full px-2 transition-colors disabled:opacity-40 ${
      on ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink)] hover:bg-[var(--color-paper)]"
    }`;
  const divider = <span className="mx-0.5 h-5 w-px bg-[var(--color-line)]" />;

  return (
    <div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
          <button type="button" disabled={disabled} title="Bold" aria-label="Bold" aria-pressed={active.bold} onMouseDown={(e) => e.preventDefault()} onClick={toggleBold} className={`${tool(active.bold)} font-extrabold`}>
            B
          </button>
          <button type="button" disabled={disabled} title="Highlight" aria-label="Highlight" aria-pressed={active.mark} onMouseDown={(e) => e.preventDefault()} onClick={toggleHighlight} className={tool(active.mark)}>
            <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
              <rect x="3" y="18.5" width="18" height="3" rx="1.5" fill="#fde047" />
              <path d="M14.5 4.5l5 5-8 8H6.5v-5l8-8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="#fef3c7" />
              <path d="M12 7l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          {divider}
          <button type="button" disabled={disabled} title="Normal size" aria-label="Normal size" aria-pressed={!active.size} onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(null)} className={`${tool(!active.size)} text-[12px] font-semibold`}>
            T
          </button>
          <button type="button" disabled={disabled} title="Large" aria-label="Large text" aria-pressed={active.size === "lg"} onMouseDown={(e) => e.preventDefault()} onClick={() => setSize("lg")} className={`${tool(active.size === "lg")} text-[15px] font-semibold`}>
            T
          </button>
          <button type="button" disabled={disabled} title="Extra large" aria-label="Extra large text" aria-pressed={active.size === "xl"} onMouseDown={(e) => e.preventDefault()} onClick={() => setSize("xl")} className={`${tool(active.size === "xl")} text-[18px] font-bold`}>
            T
          </button>
          {divider}
          <div className="relative">
            <button type="button" disabled={disabled} title="Text colour" aria-label="Text colour" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowColours((v) => !v)} className={`${tool(false)} gap-1`}>
              <span className="flex flex-col items-center leading-none">
                <span className="text-[13px] font-bold" style={{ color: active.color || undefined }}>
                  A
                </span>
                <span className="mt-0.5 h-[3px] w-4 rounded-sm" style={{ background: active.color || "linear-gradient(to right,#e11d48,#059669,#2563eb)" }} />
              </span>
              <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3 text-[var(--color-muted)]">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {showColours && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowColours(false)} aria-hidden />
                <div className="absolute left-0 top-full z-50 mt-2 flex items-center gap-1.5 rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-1.5" style={{ boxShadow: "var(--shadow-pop)" }}>
                  {TEXT_COLOURS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      aria-label={`Colour ${hex}`}
                      title={hex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setColour(hex)}
                      className={`h-6 w-6 rounded-full ring-2 transition-transform hover:scale-110 ${active.color === hex ? "ring-[var(--color-primary)]" : "ring-white"}`}
                      style={{ background: hex, boxShadow: "0 0 0 1px var(--color-line)" }}
                    />
                  ))}
                  <span className="mx-0.5 h-5 w-px bg-[var(--color-line)]" />
                  <button
                    type="button"
                    title="Remove colour"
                    aria-label="Remove colour"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setColour(null)}
                    className="flex h-6 w-6 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-paper)] hover:text-[var(--color-ink)]"
                  >
                    <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <span className="text-xs text-[var(--color-muted)]">Select text, then apply. Shown here as it will look; the eBay preview updates after saving.</span>
      </div>
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        spellCheck
        onInput={emit}
        onKeyUp={readActive}
        onMouseUp={readActive}
        onFocus={readActive}
        onPaste={(e) => {
          // Plain text only: pasted HTML would bring styles the markers can't carry.
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        className="input mt-2 whitespace-pre-wrap text-[13px] leading-relaxed outline-none focus:border-[var(--color-primary)]"
        style={{ minHeight, height: "auto", padding: "12px 16px", borderRadius: "var(--radius-field)", overflowY: "auto", maxHeight: "40rem" }}
      />
    </div>
  );
}
