// Quick replies: Liston's starter set, the fill-ins a reply can use, and the
// limits. Pure. The fill-ins are the same {word} style as the delivered
// message in Settings → Messages; the reply box fills them in from the
// conversation, and one it can't (no tracking yet, say) stays in the text
// for whoever is replying to fill in before it goes.

const MAX_NAME = 60;
const MAX_BODY = 2000;
const MAX_PER_ACCOUNT = 100;

const TOKENS = [
  { key: 'buyer', label: "The buyer's first name (their eBay username when the order has no name)" },
  { key: 'username', label: "The buyer's eBay username" },
  { key: 'item', label: 'The item they bought or asked about, with its option' },
  { key: 'order', label: 'The order number' },
  { key: 'carrier', label: 'The delivery company' },
  { key: 'tracking', label: 'The tracking number' },
  { key: 'delivery', label: 'When it should arrive ("between 28 September and 3 October")' },
];

const STARTERS = [
  {
    name: 'Order received',
    body:
      "Hi {buyer},\n\nThank you so much for your order of {item}! We're getting it ready now and it'll be on its way to you soon.\n\n" +
      "If anything isn't quite right when it arrives, please message us here first. We read every message and sort things out quickly, so there's no need to open a case with eBay.\n\n" +
      'We really appreciate your business and hope you love it!',
  },
  {
    name: 'Dispatched',
    body:
      "Hi {buyer},\n\nGood news: your order is on its way! It's travelling with {carrier}, tracking number {tracking}, and should arrive {delivery}.\n\n" +
      'You can follow it from your eBay purchases at any time. If you have any questions, just reply here.\n\nThank you for shopping with us!',
  },
  {
    name: "Where's my order",
    body:
      'Hi {buyer},\n\nThanks for getting in touch. Your order is on its way with {carrier} (tracking number {tracking}) and is due to arrive {delivery}.\n\n' +
      "Deliveries can take a little longer at busy times, but it's coming. If it hasn't arrived by then, please let us know and we'll look into it straight away.",
  },
  {
    name: 'Delivered',
    body:
      "Hi {buyer},\n\nYour order of {item} should have arrived by now. We hope you're happy with it!\n\n" +
      "If anything isn't right, please reply here and we'll put it right straight away. There's no need to open a case with eBay.",
  },
  {
    name: 'Ask for feedback',
    body:
      "Hi {buyer},\n\nWe hope you're enjoying your order! If you're happy with it, we'd be really grateful if you could leave us feedback on eBay. It only takes a moment and means a lot to a small business like ours.\n\n" +
      "And if anything isn't perfect, please message us first so we can make it right.\n\nThank you!",
  },
  {
    name: 'Sorry for the delay',
    body:
      "Hi {buyer},\n\nI'm really sorry your order is taking longer than expected. It's with {carrier} (tracking number {tracking}) and we're keeping an eye on it for you.\n\n" +
      "If it still hasn't arrived in the next few days, please let us know and we'll make sure it's sorted. Thank you for your patience.",
  },
  {
    name: 'Problem with the item',
    body:
      "Hi {buyer},\n\nI'm sorry to hear there's a problem with your order. Could you send us a photo or two showing the issue? As soon as we've seen it we'll put it right for you.\n\n" +
      "There's no need to open a case with eBay: we'll sort it out here.",
  },
];

/** A reply's name and text as kept: trimmed, the text's line breaks tidied, both within their limits. */
function clean({ name, body }) {
  return {
    name: String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME),
    body: String(body || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim().slice(0, MAX_BODY),
  };
}

module.exports = { MAX_NAME, MAX_BODY, MAX_PER_ACCOUNT, TOKENS, STARTERS, clean };
