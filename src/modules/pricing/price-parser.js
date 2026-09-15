// Turns a displayed price string into a number AND the currency it was
// quoted in.
//
// The currency half is the important half. Supplier pages quote in whatever
// currency they think the viewer wants, and this server's apparent location
// is not the seller's market — the same AliExpress product quoted "Rs.849"
// from here and "￡0.99" once the storefront was pinned to the UK. Since a
// scraped price now drives the eBay sell price, reading 849 as pounds would
// set the listing ~350× wrong. So a price whose currency doesn't match what
// was expected is REFUSED, never guessed at or converted with an assumed rate.

const SYMBOLS = [
  // Fullwidth ￡/＄ appear on AliExpress's own rendering, not just ASCII.
  { currency: 'GBP', pattern: /[£￡]/ },
  { currency: 'EUR', pattern: /[€]/ },
  { currency: 'USD', pattern: /(US\s?\$|\$|＄)/i },
  { currency: 'PKR', pattern: /\bRs\.?/i },
  { currency: 'INR', pattern: /[₹]/ },
  { currency: 'JPY', pattern: /[¥]/ },
  { currency: 'RUB', pattern: /[₽]/ },
];

function detectCurrency(text) {
  const value = String(text || '');
  const code = value.match(/\b(GBP|USD|EUR|PKR|INR|JPY|AUD|CAD)\b/i);
  if (code) return code[1].toUpperCase();
  for (const { currency, pattern } of SYMBOLS) {
    if (pattern.test(value)) return currency;
  }
  return null;
}

// Supplier pages show ranges ("£1.99 - £4.99") when options differ in price.
// The low end is the "from" price and belongs to the cheapest option, so it's
// the only figure that means anything definite — but a range is itself a
// signal that per-option costs differ, which the caller needs to know.
function parseAmounts(text) {
  const cleaned = String(text || '').replace(/\s/g, '');
  const matches = cleaned.match(/\d+(?:[.,]\d+)*/g) || [];
  return matches
    .map((raw) => {
      // "1,234.56" → 1234.56; "1.234,56" → 1234.56 (European grouping)
      const normalized =
        raw.lastIndexOf(',') > raw.lastIndexOf('.')
          ? raw.replace(/\./g, '').replace(',', '.')
          : raw.replace(/,/g, '');
      return Number(normalized);
    })
    .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * @param text             the displayed price, e.g. "￡0.99" or "Rs.849"
 * @param expectedCurrency the currency the caller requires
 * @returns { ok, amount, currency, isRange, reason }
 */
function parsePrice(text, expectedCurrency = 'GBP') {
  const currency = detectCurrency(text);
  const amounts = parseAmounts(text);

  if (!amounts.length) {
    return { ok: false, reason: 'no-amount', currency, amount: null, isRange: false };
  }
  if (!currency) {
    return { ok: false, reason: 'unknown-currency', currency: null, amount: amounts[0], isRange: amounts.length > 1 };
  }
  if (currency !== expectedCurrency) {
    // Deliberately no conversion: an assumed FX rate would be invisible in the
    // output and wrong the moment it drifts.
    return { ok: false, reason: 'wrong-currency', currency, amount: amounts[0], isRange: amounts.length > 1 };
  }

  return {
    ok: true,
    amount: Math.min(...amounts),
    currency,
    isRange: amounts.length > 1 && Math.max(...amounts) !== Math.min(...amounts),
    reason: null,
  };
}

module.exports = { parsePrice, detectCurrency, parseAmounts };
