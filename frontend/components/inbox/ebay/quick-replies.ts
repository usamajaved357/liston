import { EbayThread, QuickReply } from "@/lib/api";

// Quick replies in the reply box: the account's own (kept in Settings →
// Messages), picked with "/" or the button and loaded into the box to read
// and change, never sent on their own. Their fill-ins ({buyer}, {username},
// {item}, {order}, {carrier}, {tracking}, {delivery}, the same {word} style
// as the delivered message) come from the conversation: the buyer's first
// name from their order (else their eBay username), the item and its
// option, the order's number, carrier, tracking and when it's due. One the
// conversation doesn't have stays in the text as it is, for whoever is
// replying to fill in, and the box won't send until they have. Pure.

export const TOKENS = ["buyer", "username", "item", "order", "carrier", "tracking", "delivery"] as const;
export type Token = (typeof TOKENS)[number];
export type ReplyFacts = Record<Token, string | null>;

const TOKEN_RE = new RegExp(`\\{(${TOKENS.join("|")})\\}`, "gi");
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });

/** When an order should arrive, in words: "between 28 September and 3 October", or "by 3 October". */
export function deliveryText(due: { min: string | null; max: string } | null | undefined): string | null {
  if (!due) return null;
  return due.min && day(due.min) !== day(due.max) ? `between ${day(due.min)} and ${day(due.max)}` : `by ${day(due.max)}`;
}

/** What a reply can say about this conversation's buyer and order. */
export function replyFacts(thread: EbayThread): ReplyFacts {
  const { context, conversation } = thread;
  const order = context.order || null;
  const first = order?.items[0];
  const title = first?.title || context.item?.title || null;
  return {
    buyer: context.buyerName || conversation.otherParty || null,
    username: conversation.otherParty || null,
    item: title ? `${title}${first?.variation ? ` - ${first.variation}` : ""}${order && order.items.length > 1 ? " and the rest of your order" : ""}` : null,
    order: order?.orderId || null,
    carrier: order?.tracking[0]?.carrier || null,
    tracking: order?.tracking[0]?.number || null,
    delivery: deliveryText(order?.estimatedDelivery),
  };
}

/** The reply with each fill-in it knows completed; the ones it doesn't know stay as they are. */
export function fillReply(body: string, facts: Partial<ReplyFacts>): string {
  return body.replace(TOKEN_RE, (whole, key: string) => facts[key.toLowerCase() as Token] || whole);
}

/** The fill-ins still in a text (nothing known to put there): what must be filled in before it's sent. */
export function unfilled(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN_RE)].map((m) => `{${m[1].toLowerCase()}}`))];
}

/** Words in {braces} that aren't fill-ins ("{name}"): they'd go to the buyer as they are. */
export function unknownTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1].toLowerCase()).filter((k) => !(TOKENS as readonly string[]).includes(k)))].map((k) => `{${k}}`);
}

/** The replies whose name has every word typed after "/" (else whose text has them). */
export function matchReplies(replies: QuickReply[], query: string): QuickReply[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return replies;
  const has = (hay: string) => words.every((w) => hay.toLowerCase().includes(w));
  const byName = replies.filter((r) => has(r.name));
  return byName.length ? byName : replies.filter((r) => has(r.body));
}
