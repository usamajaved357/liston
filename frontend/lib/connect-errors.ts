// What went wrong linking an eBay account, from the `ebayError` code the
// OAuth callback redirects with.
const EBAY_ERRORS: Record<string, string> = {
  plan_limit: "Your plan has no room for another eBay account. Adding another site of an account you already have doesn't count.",
  access_denied: "eBay access wasn't approved.",
  invalid_or_expired_state: "The sign-in took too long. Start again.",
};

export function ebayConnectError(code: string, retry: string): string {
  return EBAY_ERRORS[code] ?? `Couldn't connect your eBay account (${code}). ${retry}`;
}
