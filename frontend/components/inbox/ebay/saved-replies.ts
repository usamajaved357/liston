import { EbayThread } from "@/lib/api";

// Saved replies for eBay buyers, picked with "/" in the reply box (or its
// button) and loaded into it to read and change before it's sent, never
// sent on their own. Each is written for a moment in an order's life
// (thanks for the order, on its way, where is it, delivered, feedback,
// running late, a problem) and filled in from the conversation: the
// buyer's first name (from their order, else their eBay username), the
// item, the carrier and tracking number, the dates it went and is due.
// What isn't known is left out gracefully rather than shown as a gap. Pure.

export type ReplyFacts = {
  name: string;
  item: string | null;
  tracking: { number: string; carrier: string | null } | null;
  shippedAt: string | null;
  dispatchBy: string | null;
  deliveredAt: string | null;
  due: { min: string | null; max: string } | null;
};

export type SavedReply = { key: string; name: string; hint: string; text: (f: ReplyFacts) => string };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long" });
const dueText = (due: ReplyFacts["due"]) => (due ? (due.min && day(due.min) !== day(due.max) ? `between ${day(due.min)} and ${day(due.max)}` : `by ${day(due.max)}`) : null);
const trackingText = (t: ReplyFacts["tracking"]) => (t ? `${t.carrier ? `with ${t.carrier}, ` : ""}tracking number ${t.number}` : null);
const lines = (...parts: (string | null | false | undefined)[]) => parts.filter(Boolean).join("\n\n");

/** What a reply can say about this conversation's buyer and order. */
export function replyFacts(thread: EbayThread): ReplyFacts {
  const { context, conversation } = thread;
  const order = context.order || null;
  const first = order?.items[0];
  const title = first?.title || context.item?.title || null;
  const item = title ? `${title}${first?.variation ? ` - ${first.variation}` : ""}${order && order.items.length > 1 ? " and the rest of your order" : ""}` : null;
  return {
    name: context.buyerName || conversation.otherParty || "there",
    item,
    tracking: order?.tracking[0] || null,
    shippedAt: order?.shippedAt || null,
    dispatchBy: order?.dispatchBy || null,
    deliveredAt: order?.deliveredAt || null,
    due: order?.estimatedDelivery || null,
  };
}

export const SAVED_REPLIES: SavedReply[] = [
  {
    key: "order-received",
    name: "Order received",
    hint: "Thanks for the order",
    text: (f) =>
      lines(
        `Hi ${f.name},`,
        `Thank you so much for your order${f.item ? ` of ${f.item}` : ""}! We're getting it ready now and it'll be on its way to you soon.`,
        "If anything isn't quite right when it arrives, please message us here first. We read every message and sort things out quickly, so there's no need to open a case with eBay.",
        "We really appreciate your business and hope you love it!"
      ),
  },
  {
    key: "dispatched",
    name: "Dispatched",
    hint: "On its way, with tracking",
    text: (f) =>
      lines(
        `Hi ${f.name},`,
        `Good news: your order is on its way! ${f.tracking ? `It's travelling ${trackingText(f.tracking)}.` : "It's been sent and is making its way to you."}${dueText(f.due) ? ` It should arrive ${dueText(f.due)}.` : ""}`,
        f.tracking ? "You can follow it from your eBay purchases at any time. If you have any questions, just reply here." : "If you have any questions, just reply here.",
        "Thank you for shopping with us!"
      ),
  },
  {
    key: "where-is-it",
    name: "Where's my order",
    hint: "When they ask where it is",
    text: (f) =>
      f.shippedAt
        ? lines(
            `Hi ${f.name},`,
            `Thanks for getting in touch. Your order was sent on ${day(f.shippedAt)}${f.tracking ? ` ${trackingText(f.tracking)}` : ""}, and ${dueText(f.due) ? `it's due to arrive ${dueText(f.due)}` : "it should be with you in the next few days"}.`,
            `Deliveries can take a little longer at busy times, but it's on its way. If it hasn't arrived ${f.due ? `by ${day(f.due.max)}` : "by the end of the week"}, please let us know and we'll look into it straight away.`
          )
        : lines(
            `Hi ${f.name},`,
            `Thanks for getting in touch. Your order is being prepared and will be sent ${f.dispatchBy ? `by ${day(f.dispatchBy)}` : "very soon"}.${dueText(f.due) ? ` It should reach you ${dueText(f.due)}.` : ""}`,
            "We'll let you know as soon as it's on its way. Thank you for your patience!"
          ),
  },
  {
    key: "delivered",
    name: "Delivered",
    hint: "Check it arrived well",
    text: (f) =>
      lines(
        `Hi ${f.name},`,
        `Your order should have arrived${f.deliveredAt ? ` on ${day(f.deliveredAt)}` : ""}. We hope you're happy with it!`,
        "If anything isn't right, please reply here and we'll put it right straight away. There's no need to open a case with eBay."
      ),
  },
  {
    key: "feedback",
    name: "Ask for feedback",
    hint: "Once they're happy",
    text: (f) =>
      lines(
        `Hi ${f.name},`,
        "We hope you're enjoying your order! If you're happy with it, we'd be really grateful if you could leave us feedback on eBay. It only takes a moment and means a lot to a small business like ours.",
        "And if anything isn't perfect, please message us first so we can make it right.",
        "Thank you!"
      ),
  },
  {
    key: "delay",
    name: "Sorry for the delay",
    hint: "When it's running late",
    text: (f) =>
      lines(
        `Hi ${f.name},`,
        `I'm really sorry your order is taking longer than expected. ${f.tracking ? `It's ${trackingText(f.tracking)}, and we're keeping an eye on it for you.` : "We're looking into it for you now."}`,
        "If it still hasn't arrived in the next few days, please let us know and we'll make sure it's sorted. Thank you for your patience."
      ),
  },
  {
    key: "problem",
    name: "Problem with the item",
    hint: "Ask for a photo",
    text: (f) =>
      lines(
        `Hi ${f.name},`,
        "I'm sorry to hear there's a problem with your order. Could you send us a photo or two showing the issue? As soon as we've seen it we'll put it right for you.",
        "There's no need to open a case with eBay: we'll sort it out here."
      ),
  },
];

/** The replies whose name or hint has every word typed after "/". */
export function matchReplies(query: string): SavedReply[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return SAVED_REPLIES;
  return SAVED_REPLIES.filter((r) => {
    const hay = `${r.name} ${r.hint}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
