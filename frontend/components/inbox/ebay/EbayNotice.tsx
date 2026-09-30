"use client";

import { useEffect, useMemo, useRef } from "react";
import { EbayMessage } from "@/lib/api";
import { Meta } from "../ChatBubble";
import { timeLabel } from "../inbox-format";

// eBay's own messages as eBay designs them: each notice's HTML (its
// headline, figures, buttons and photos) drawn in a card the width eBay
// lays its emails out for, under a slim line with the subject and the time.
// The HTML is cleaned first (nothing that runs, embeds or submits; links
// only to web, mail or phone addresses, each opening in a new tab) and drawn
// in a sandboxed frame that can't run anything whatever is left, with a
// policy that loads only pictures, styles and fonts. The frame takes the
// notice's height; a notice laid out wider than the card is scaled down to
// fit rather than cut off. Older notices in a conversation fold to one line
// (subject, first words, time) and open on a click.

// Never drawn: what runs, embeds, submits or points the page elsewhere.
const DROP = new Set(["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "input", "select", "textarea", "option", "link", "meta", "base", "title", "template", "svg", "math", "audio", "video", "source", "track", "canvas", "dialog", "portal"]);
// Kept for what's inside them, the element itself dropped.
const UNWRAP = new Set(["form", "button"]);
const LINK_OK = /^(https?:|mailto:|tel:)/i;
const IMAGE_OK = /^(https?:|data:image\/(png|gif|jpe?g|webp);)/i;

const BASE_STYLE =
  'html,body{margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#191919;overflow-wrap:break-word;-webkit-text-size-adjust:100%}img{border:0}a{color:#3665f3}';
// After eBay's own styles: the frame takes the notice's height, so nothing inside scrolls.
const FIT_STYLE = "html,body{height:auto!important;min-height:0!important;overflow:hidden!important}";
const POLICY = "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:; form-action 'none'; base-uri 'none'";

function clean(el: Element) {
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag)) {
      child.remove();
      continue;
    }
    clean(child);
    if (UNWRAP.has(tag)) {
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const { name, value } of Array.from(child.attributes)) {
      const n = name.toLowerCase();
      const v = value.trim();
      if (n.startsWith("on") || n === "srcdoc" || n === "srcset" || n === "formaction" || n === "action" || n.includes(":")) child.removeAttribute(name);
      else if (n === "href" && !LINK_OK.test(v)) child.removeAttribute(name);
      else if ((n === "src" || n === "background" || n === "poster") && !IMAGE_OK.test(v)) child.removeAttribute(name);
    }
    if ((tag === "a" || tag === "area") && child.hasAttribute("href")) {
      child.setAttribute("target", "_blank");
      child.setAttribute("rel", "noopener noreferrer");
    }
  }
}

/** A notice's HTML as a whole, cleaned page for the sandboxed frame. */
export function noticeDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  clean(doc.documentElement);
  const head = doc.head;
  const policy = doc.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", POLICY);
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const viewport = doc.createElement("meta");
  viewport.setAttribute("name", "viewport");
  viewport.setAttribute("content", "width=device-width, initial-scale=1");
  const base = doc.createElement("base");
  base.setAttribute("target", "_blank");
  const baseStyle = doc.createElement("style");
  baseStyle.textContent = BASE_STYLE;
  head.prepend(charset, policy, viewport, base, baseStyle);
  const fit = doc.createElement("style");
  fit.textContent = FIT_STYLE;
  head.append(fit);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** The frame takes its notice's height, the notice scaled down to the card's width when it's laid out wider. */
function fitFrame(el: HTMLIFrameElement | null) {
  const doc = el?.contentDocument;
  if (!el || !doc?.body) return;
  doc.body.style.zoom = "";
  const width = el.clientWidth;
  const wide = Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth);
  if (width && wide > width + 1) doc.body.style.zoom = String(width / wide);
  el.style.height = `${Math.ceil(doc.documentElement.getBoundingClientRect().height)}px`;
}

function NoticeFrame({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => (typeof DOMParser === "undefined" ? "" : noticeDocument(html)), [html]);

  // Fitted again when the card's width changes (the window, a phone turned).
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitFrame(el);
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  return (
    <iframe
      ref={frame}
      title={title}
      srcDoc={srcDoc}
      // Nothing inside can run; its links open in a new tab, outside the sandbox.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={(e) => {
        const el = e.currentTarget;
        fitFrame(el);
        el.contentDocument?.fonts?.ready.then(() => fitFrame(el)).catch(() => {});
      }}
      className="block h-[180px] w-full border-0 bg-white"
    />
  );
}

/** One of eBay's notices as eBay designed it; `open` false folds it to a line that opens it. */
export function NoticeCard({ m, open, onToggle, latest }: { m: EbayMessage & { html: string }; open: boolean; onToggle: () => void; latest: boolean }) {
  const subject = m.subject || "Message from eBay";
  const time = <Meta>{timeLabel(m.createdAt)}</Meta>;
  const preview = m.text.replace(/\s+/g, " ").trim();
  return (
    <div className="flex mt-4 px-[clamp(12px,1.5%,20px)]" data-latest-notice={latest || undefined}>
      <article className="w-full max-w-[640px] overflow-hidden rounded-md bg-[var(--color-panel)] shadow-[var(--shadow-bubble-sharp)]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={`flex w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-black/[0.02] ${open ? "border-b border-[var(--color-line)] py-2" : "py-2.5"}`}
          title={open ? "Fold this message" : "Open this message"}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-[18px] text-[var(--color-ink)]">{subject}</span>
            {!open && preview && <span className="mt-0.5 block truncate text-[12.5px] leading-[17px] text-[var(--color-muted)]">{preview}</span>}
          </span>
          {time}
          <svg viewBox="0 0 20 20" fill="none" className={`h-4 w-4 flex-shrink-0 text-[var(--color-muted)] transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
            <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && <NoticeFrame html={m.html} title={subject} />}
      </article>
    </div>
  );
}
