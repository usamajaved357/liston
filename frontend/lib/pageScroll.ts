// The element a page scrolls in. On a laptop that's the area under the
// pinned page header (`[data-scroller]`); on a phone the header scrolls away
// with the page, so it's the whole page column (`[data-page-column]`, see
// globals.css). Whichever is actually scrolling is the one returned.
export function pageScroller(from?: Element | null): HTMLElement | null {
  const scroller = (from?.closest("[data-scroller]") ?? document.querySelector("[data-scroller]")) as HTMLElement | null;
  if (!scroller) return null;
  if (/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) return scroller;
  return scroller.closest<HTMLElement>("[data-page-column]") ?? scroller;
}

/** Back to the top of the page (a new page of a list, say). */
export function scrollPageToTop(behavior: ScrollBehavior = "smooth") {
  pageScroller()?.scrollTo({ top: 0, behavior });
}
