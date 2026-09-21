"use client";

import { useEffect, useRef, useState } from "react";

// A small what-you-see editor for the description. The description is
// stored as plain text with light markers (**bold**, ==highlight==,
// [color=#hex]…[/color], [size=sm|lg|xl]…[/size]) that the eBay template
// renders; this shows those as real bold, highlight, colour and size while
// editing and writes the markers back on every change. Formatting is applied
// to the selection in place, so the caret and scroll position stay where
// they are.
//
// Lists are plain text too: a line that starts with a marker and a space
// ("• ", "✓ ", "1. " …) is a list item — the same shape the AI writes and the
// eBay template renders (listings/description-template.js, LIST_ITEM). The
// editor lays each line out as its own block with a hanging indent, and
// Enter / Backspace behave the way they do in Word.

const SIZE_PX: Record<string, string> = { sm: "12px", lg: "18px", xl: "22px" };
const HIGHLIGHT = "#fff59d";
export const TEXT_COLOURS = ["#e11d48", "#d97706", "#059669", "#2563eb", "#7c3aed", "#0f172a"];

// ---- lists ----------------------------------------------------------------

export const BULLETS = [
  { id: "dot", glyph: "•", label: "Dot" },
  { id: "circle", glyph: "○", label: "Circle" },
  { id: "square", glyph: "▪", label: "Square" },
  { id: "diamond", glyph: "◆", label: "Diamond" },
  { id: "arrow", glyph: "➤", label: "Arrow" },
  { id: "check", glyph: "✓", label: "Check" },
  { id: "tick", glyph: "✔", label: "Bold check" },
  { id: "star", glyph: "★", label: "Star" },
  { id: "dash", glyph: "–", label: "Dash" },
] as const;
export const NUMBERINGS = [
  { id: "num-dot", label: "1. 2. 3.", format: (n: number) => `${n}.` },
  { id: "num-paren", label: "1) 2) 3)", format: (n: number) => `${n})` },
] as const;

// An emoji leading a line (the AI's Key Features lines: "❄️ Cooling Comfort –
// …") is a marker too; © ® ™ are not. Built with RegExp for the "u" flag.
const EMOJI = "(?![©®™])\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?(?:\\u200D\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)*";
const LIST_RE = new RegExp(`^([•●○◦▪■◆◇➤►▸→✓✔☑★☆–\\-*]|\\d{1,3}[.)]|${EMOJI})[ \\u00a0]+`, "u");
const isNumbering = (style: string | null) => !!style && style.startsWith("num-");

// The list style a line carries ("dot", "check", "num-dot" …), or null.
function lineStyle(line: string): string | null {
  const m = line.match(LIST_RE);
  if (!m) return null;
  const marker = m[1];
  if (/\d/.test(marker)) return marker.endsWith(")") ? "num-paren" : "num-dot";
  if (marker === "-" || marker === "*") return "dot";
  return BULLETS.find((b) => b.glyph === marker)?.id ?? "other";
}
const stripList = (line: string) => line.replace(LIST_RE, "");
const lineNumber = (line: string) => Number(line.match(/^(\d{1,3})[.)]/)?.[1] || 0);

function prefixFor(style: string, n: number) {
  const numbering = NUMBERINGS.find((x) => x.id === style);
  if (numbering) return `${numbering.format(n)} `;
  return `${BULLETS.find((b) => b.id === style)?.glyph ?? "•"} `;
}

// Renumbers the numbered run that starts at `from`, blank lines between items
// included (descriptions often space their points out), stopping at the
// first line that isn't an item of the same numbering.
function renumber(lines: string[], from: number, start: number) {
  const style = lineStyle(lines[from] || "");
  if (!isNumbering(style)) return;
  let n = start;
  for (let i = from; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (lineStyle(lines[i]) !== style) break;
    lines[i] = prefixFor(style!, n++) + stripList(lines[i]);
  }
}

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

// A note the buyer must not miss ("**Important:** …", "Note: …") is shown as
// a highlighted callout, matching the eBay template (description-template.js,
// NOTE_LINE). Tested against the stored line, markers included, or a line's
// visible text.
const NOTE_RE = /^(?:\*\*)?(?:important|please note|note|warning|caution|attention)(?:\s*:\s*\*\*|\s*\*\*\s*:|\s*:)/i;
const NOTE_STYLE: Record<string, string> = {
  background: "#FFF7E6",
  borderLeft: "3px solid #F59E0B",
  borderRadius: "8px",
  padding: "6px 12px",
  margin: "4px 0",
  color: "#7C2D12",
};
const NOTE_CSS = "background:#FFF7E6;border-left:3px solid #F59E0B;border-radius:8px;padding:6px 12px;margin:4px 0;color:#7C2D12";

// A list line's hanging indent before the editor measures the real marker
// width (and in read-only views, which never measure); a note line's callout.
function lineOpen(line: string) {
  const m = line.match(LIST_RE);
  if (!m && NOTE_RE.test(line)) return `<div data-note style="${NOTE_CSS}">`;
  if (!m) return "<div>";
  const em = /\d/.test(m[1]) || m[1].length > 1 ? 1.6 : 1.1;
  return `<div data-list style="padding-left:${em}em;text-indent:-${em}em">`;
}

export function markersToHtml(text: string): string {
  // One block per line, so a list item can hang its wrapped lines under its
  // text. Markers never span lines, so each line renders on its own.
  return text
    .split("\n")
    .map((line) => `${lineOpen(line)}${lineToHtml(line) || "<br>"}</div>`)
    .join("");
}

function lineToHtml(text: string): string {
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
  return html;
}

// ---- HTML → markers (for saving) --------------------------------------------

function rgbToHex(color: string): string | null {
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}
const DEFAULT_INK = new Set(["#000000", "#0f172a", "#1c1c1c", "#111827"]);

function fmtOf(el: HTMLElement, inherited: Fmt): Fmt {
  // A note line's callout colours are the editor's display, not the seller's
  // formatting: never saved as [color] / ==highlight== markers.
  if (el.hasAttribute("data-note")) return inherited;
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
  // A trailing <br> the browser keeps after Enter is not content.
  return serialize(root).replace(/\n$/, "");
}

// The markers for everything under `root`, a trailing line break included —
// callers counting lines need it.
function serialize(root: HTMLElement): string {
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
      // The <br> a browser keeps as the last child of a line block only
      // holds the line open; the block itself is the line break.
      const parent = el.parentElement;
      if (parent && parent !== root && BLOCK.has(parent.tagName) && !el.nextSibling) return;
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
    // Text straight after a block starts a new line.
    const next = el.nextSibling;
    if (block && next && !(next.nodeType === Node.ELEMENT_NODE && (BLOCK.has((next as HTMLElement).tagName) || (next as HTMLElement).tagName === "BR"))) {
      runs.push({ text: "\n", f: NONE });
    }
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
  return out;
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
  const [menu, setMenu] = useState<"colour" | "bullets" | "numbering" | null>(null);
  const [active, setActive] = useState<Fmt>(NONE);
  // The list style of the caret's line, and the last style picked of each
  // kind — the main Bullets / Numbering buttons reuse it, as Word does.
  const [activeList, setActiveList] = useState<string | null>(null);
  const [lastBullet, setLastBullet] = useState("dot");
  const [lastNumbering, setLastNumbering] = useState("num-dot");

  useEffect(() => {
    if (!ref.current || value === lastEmitted.current) return;
    ref.current.innerHTML = markersToHtml(value);
    lastEmitted.current = value;
    hangIndents();
  }, [value]);

  function emit() {
    if (!ref.current) return;
    // Line styles first: a line Enter split off a note still carries the
    // note's callout style until this runs, and must not be read with it.
    hangIndents();
    const next = htmlToMarkers(ref.current);
    lastEmitted.current = next;
    onChange(next);
    readActive();
  }

  // Each list line hangs its wrapped text exactly under its first word: the
  // indent is the rendered width of that line's own marker ("•␠", "10.␠").
  // Note lines ("Important: …") are highlighted.
  function hangIndents() {
    const root = ref.current;
    if (!root) return;
    let ctx: CanvasRenderingContext2D | null = null;
    for (const child of Array.from(root.children) as HTMLElement[]) {
      const m = (child.textContent || "").match(LIST_RE);
      if (m) {
        // Measured as laid out on the page (emoji render wider than a canvas
        // reports); the canvas is only the fallback for an odd DOM shape.
        let w = 0;
        const first = child.firstChild;
        if (first && first.nodeType === Node.TEXT_NODE && (first.textContent || "").length >= m[0].length) {
          const r = document.createRange();
          r.setStart(first, 0);
          r.setEnd(first, m[0].length);
          w = r.getBoundingClientRect().width;
        }
        if (!w) {
          ctx = ctx || document.createElement("canvas").getContext("2d");
          if (ctx) {
            ctx.font = getComputedStyle(child).font;
            w = ctx.measureText(m[0].replace(/\u00a0/g, " ")).width;
          }
        }
        w = Math.ceil(w);
        child.style.paddingLeft = `${w}px`;
        child.style.textIndent = `-${w}px`;
        child.setAttribute("data-list", "");
      } else if (child.hasAttribute("data-list")) {
        child.style.paddingLeft = "";
        child.style.textIndent = "";
        child.removeAttribute("data-list");
      }
      // Note lines get the callout; a line that stops being one (or a new
      // line Enter split off it, which inherits its style) loses it.
      const note = !m && NOTE_RE.test(child.textContent || "");
      if (note && !child.hasAttribute("data-note")) {
        Object.assign(child.style, NOTE_STYLE);
        child.setAttribute("data-note", "");
      } else if (!note && (child.hasAttribute("data-note") || child.style.borderLeft)) {
        for (const key of Object.keys(NOTE_STYLE)) child.style.setProperty(key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), "");
        child.removeAttribute("data-note");
      }
    }
  }

  // ---- where the selection is, in lines of the stored text ----

  // The markers from the start of the editor (or to its end) up to a point.
  function textAround(node: Node, offset: number, side: "before" | "after") {
    const root = ref.current!;
    const r = document.createRange();
    if (side === "before") {
      r.setStart(root, 0);
      r.setEnd(node, offset);
    } else {
      r.setStart(node, offset);
      r.setEnd(root, root.childNodes.length);
    }
    const tmp = document.createElement("div");
    tmp.appendChild(r.cloneContents());
    return serialize(tmp);
  }
  const countLines = (s: string) => s.split("\n").length - 1;

  function selectionLines(): { start: number; end: number; range: Range } | null {
    const sel = window.getSelection();
    const root = ref.current;
    if (!root || !sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const start = countLines(textAround(range.startContainer, range.startOffset, "before"));
    const beforeEnd = textAround(range.endContainer, range.endOffset, "before");
    let end = countLines(beforeEnd);
    // A selection that runs to the very start of the next line (a triple-
    // click) doesn't take that line along.
    if (!range.collapsed && end > start && beforeEnd.endsWith("\n")) end -= 1;
    return { start, end, range };
  }

  // Replaces the whole text, then puts the selection back: over lines
  // [from, to], or a caret `caret` characters into line `from`.
  function rewrite(lines: string[], from: number, to: number, caret?: number) {
    const root = ref.current;
    if (!root) return;
    const next = lines.join("\n");
    root.innerHTML = markersToHtml(next);
    lastEmitted.current = next;
    onChange(next);
    hangIndents();
    root.focus({ preventScroll: true });
    const first = root.children[Math.min(from, root.children.length - 1)];
    const last = root.children[Math.min(to, root.children.length - 1)];
    const sel = window.getSelection();
    if (!first || !last || !sel) return;
    const r = document.createRange();
    if (caret !== undefined) {
      const text = first.firstChild;
      if (text && text.nodeType === Node.TEXT_NODE) r.setStart(text, Math.min(caret, text.textContent!.length));
      else r.setStart(first, 0);
      r.collapse(true);
    } else {
      r.setStart(first, 0);
      r.setEnd(last, last.childNodes.length);
    }
    sel.removeAllRanges();
    sel.addRange(r);
    readActive();
  }

  // Bullets / numbering on every selected line, Word-style: applying the
  // style the lines already have takes it off; blank lines stay blank.
  function applyList(style: string | null) {
    setMenu(null);
    if (disabled || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    const at = selectionLines();
    if (!at) return;
    const lines = serialize(ref.current).replace(/\n$/, "").split("\n");
    const { start, end } = at;
    const picked = lines.slice(start, end + 1);
    const filled = picked.filter((l) => stripList(l).trim());
    const off = style === null || (filled.length > 0 && filled.every((l) => lineStyle(l) === style));
    if (style && !off) {
      if (isNumbering(style)) setLastNumbering(style);
      else setLastBullet(style);
    }
    // Numbering carries on from a numbered item just above the selection.
    let n = 1;
    if (style && isNumbering(style)) {
      for (let i = start - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        if (lineStyle(lines[i]) === style) n = lineNumber(lines[i]) + 1;
        break;
      }
    }
    for (let i = start; i <= end; i++) {
      const body = stripList(lines[i]);
      lines[i] = off || !body.trim() ? body : prefixFor(style!, n++) + body;
    }
    // Items below that belonged to the same numbering follow on.
    let after = end + 1;
    while (after < lines.length && !lines[after].trim()) after++;
    if (after < lines.length) {
      const prev = lines.slice(0, after).reverse().find((l) => l.trim());
      const prevStyle = prev ? lineStyle(prev) : null;
      if (isNumbering(lineStyle(lines[after])) && lineStyle(lines[after]) === prevStyle) renumber(lines, after, lineNumber(prev!) + 1);
      else if (isNumbering(lineStyle(lines[after]))) renumber(lines, after, 1);
    }
    rewrite(lines, start, end);
  }

  // Enter on a list line starts the next item; Enter on an empty item ends
  // the list; Backspace just after a marker removes it — as in Word.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "Enter" && e.key !== "Backspace") return;
    if (e.key === "Enter" && e.shiftKey) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed || !ref.current) return;
    const range = sel.getRangeAt(0);
    const before = textAround(range.startContainer, range.startOffset, "before");
    const after = textAround(range.startContainer, range.startOffset, "after");
    const head = before.slice(before.lastIndexOf("\n") + 1);
    const tail = after.split("\n")[0];
    const line = countLines(before);
    const style = lineStyle(head + tail);
    if (!style) return;
    const lines = serialize(ref.current).replace(/\n$/, "").split("\n");
    const marker = (head + tail).match(LIST_RE)![0];

    if (e.key === "Backspace") {
      if (head !== marker) return;
      e.preventDefault();
      lines[line] = stripList(lines[line]);
      renumber(lines, line + 1, 1);
      rewrite(lines, line, line, 0);
      return;
    }

    e.preventDefault();
    if (!stripList(head + tail).trim()) {
      lines[line] = "";
      renumber(lines, line + 1, 1);
      rewrite(lines, line, line, 0);
      return;
    }
    const bullet = style === "other" ? `${marker.trim()} ` : prefixFor(style, lineNumber(head) + 1);
    // The caret sits inside the marker: the new item goes above, untouched.
    if (head.length < marker.length) {
      lines.splice(line, 0, "");
      rewrite(lines, line + 1, line + 1, marker.length);
      return;
    }
    lines.splice(line, 1, head, bullet + tail);
    if (isNumbering(style)) renumber(lines, line + 1, lineNumber(head) + 1);
    rewrite(lines, line + 1, line + 1, bullet.length);
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
    const lineEl = chain.find((e) => e.parentElement === ref.current);
    setActiveList(lineEl ? lineStyle(lineEl.textContent || "") : null);
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
    setMenu(null);
  };

  const tool = (on: boolean) =>
    `flex h-8 min-w-8 items-center justify-center rounded-full px-2 transition-colors disabled:opacity-40 ${
      on ? "bg-[var(--color-primary)] text-white" : "text-[var(--color-ink)] hover:bg-[var(--color-paper)]"
    }`;
  const divider = <span className="mx-0.5 h-5 w-px bg-[var(--color-line)]" />;

  return (
    <div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="relative inline-flex items-center rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] p-0.5">
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
            <button type="button" disabled={disabled} title="Text colour" aria-label="Text colour" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu((m) => (m === "colour" ? null : "colour"))} className={`${tool(false)} gap-1`}>
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
            {menu === "colour" && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} aria-hidden />
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
          {divider}
          <ListButton
            kind="bullets"
            disabled={disabled}
            on={!!activeList && !isNumbering(activeList)}
            open={menu === "bullets"}
            onApply={() => applyList(activeList && !isNumbering(activeList) ? activeList : lastBullet)}
            onToggleMenu={() => setMenu((m) => (m === "bullets" ? null : "bullets"))}
            toolClass={tool}
          />
          <ListButton
            kind="numbering"
            disabled={disabled}
            on={isNumbering(activeList)}
            open={menu === "numbering"}
            onApply={() => applyList(isNumbering(activeList) ? activeList : lastNumbering)}
            onToggleMenu={() => setMenu((m) => (m === "numbering" ? null : "numbering"))}
            toolClass={tool}
          />
          {(menu === "bullets" || menu === "numbering") && (
            <ListLibrary kind={menu} current={activeList} onPick={applyList} onClose={() => setMenu(null)} />
          )}
        </div>
        <span className="text-xs text-[var(--color-muted)]">Select text, then apply. Lists work on whole lines. Shown here as it will look; the eBay preview updates after saving.</span>
      </div>
      <div
        ref={ref}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        spellCheck
        onInput={emit}
        onKeyDown={onKeyDown}
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

// ---- list toolbar pieces ----------------------------------------------------

const Chevron = () => (
  <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3">
    <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function ListIcon({ kind }: { kind: "bullets" | "numbering" }) {
  const rows = [6, 12, 18];
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-[18px] w-[18px]">
      {rows.map((y, i) =>
        kind === "bullets" ? (
          <circle key={y} cx="4.5" cy={y} r="1.6" fill="currentColor" />
        ) : (
          <text key={y} x="2.2" y={y + 2.6} fontSize="7" fontWeight="700" fill="currentColor" fontFamily="system-ui, sans-serif">
            {i + 1}
          </text>
        )
      )}
      {rows.map((y) => (
        <path key={`l${y}`} d={`M9 ${y}h12`} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      ))}
    </svg>
  );
}

// A split button like Word's: the icon applies the current / last style, the
// chevron opens the library.
function ListButton({
  kind,
  disabled,
  on,
  open,
  onApply,
  onToggleMenu,
  toolClass,
}: {
  kind: "bullets" | "numbering";
  disabled?: boolean;
  on: boolean;
  open: boolean;
  onApply: () => void;
  onToggleMenu: () => void;
  toolClass: (on: boolean) => string;
}) {
  const label = kind === "bullets" ? "Bullets" : "Numbering";
  return (
    <span className="flex items-center">
      <button type="button" disabled={disabled} title={label} aria-label={label} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={onApply} className={`${toolClass(on)} !min-w-0 !rounded-r-none !pr-1`}>
        <ListIcon kind={kind} />
      </button>
      <button
        type="button"
        disabled={disabled}
        title={`${label} library`}
        aria-label={`${label} library`}
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleMenu}
        className={`${toolClass(open)} !min-w-0 !rounded-l-none !px-1 ${open ? "" : "text-[var(--color-muted)]"}`}
      >
        <Chevron />
      </button>
    </span>
  );
}

// Word's Bullet / Numbering Library: each tile previews three lines.
function ListLibrary({
  kind,
  current,
  onPick,
  onClose,
}: {
  kind: "bullets" | "numbering";
  current: string | null;
  onPick: (style: string | null) => void;
  onClose: () => void;
}) {
  const tiles: { id: string; label: string; markers: string[] }[] =
    kind === "bullets"
      ? BULLETS.map((b) => ({ id: b.id, label: b.label, markers: [b.glyph, b.glyph, b.glyph] }))
      : NUMBERINGS.map((n) => ({ id: n.id, label: n.label, markers: [1, 2, 3].map(n.format) }));
  const tile = (selected: boolean) =>
    `flex h-[62px] w-[62px] flex-col justify-center gap-1 rounded-lg border px-2 transition-colors ${
      selected ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]" : "border-[var(--color-line)] bg-white hover:border-[var(--color-primary)]"
    }`;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        role="menu"
        aria-label={kind === "bullets" ? "Bullet library" : "Numbering library"}
        className="absolute right-0 top-full z-50 mt-2 w-[252px] rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3"
        style={{ boxShadow: "var(--shadow-pop)" }}
      >
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">{kind === "bullets" ? "Bullet library" : "Numbering library"}</p>
        <div className="grid grid-cols-3 gap-2">
          <button type="button" role="menuitem" title="None" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(null)} className={`${tile(!current)} items-center !justify-center text-[12px] font-medium text-[var(--color-muted)]`}>
            None
          </button>
          {tiles.map((t) => (
            <button key={t.id} type="button" role="menuitem" title={t.label} aria-label={t.label} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(t.id)} className={tile(current === t.id)}>
              {t.markers.map((m, i) => (
                <span key={i} className="flex items-center gap-1.5">
                  <span className={`w-3 text-center text-[11px] font-bold leading-none ${kind === "bullets" ? "text-[var(--color-primary)]" : "text-[var(--color-ink)]"}`}>{m}</span>
                  <span className="h-[3px] flex-1 rounded-full bg-[var(--color-line-strong,#cbd5e1)]" />
                </span>
              ))}
            </button>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] leading-snug text-[var(--color-muted)]">Applies to every line you selected. Enter adds the next item; Enter on an empty one ends the list.</p>
      </div>
    </>
  );
}
