const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";


// The viewer's own time zone (their browser's), for figures about the
// team and the owner's own dashboard. An account's pages use the account's
// eBay site's zone instead (lib/timezone.tsx).
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      try {
        localStorage.removeItem("liston:me");
      } catch {}
    }
    // The approval gate: any 403 carrying accessStatus means this account
    // isn't approved yet — send them to the review screen from anywhere.
    if (res.status === 403 && data.accessStatus && typeof window !== "undefined" && !window.location.pathname.startsWith("/pending")) {
      window.location.assign("/pending");
    }
    throw new ApiError(data.error || "Something went wrong", res.status);
  }

  return data as T;
}

// One account's (or one market's) money for a range, in its own currency:
// sales (what buyers paid), eBay and ad fees, refunds, earnings (what reached
// the seller, eBay's figure), supplier cost and profit (earnings − cost).
export interface MoneySummary {
  currency: string;
  sales: number;
  fees: number;
  adFees: number;
  refunds: number;
  earnings: number;
  sourceCost: number;
  profit: number;
  settledSales: number;
  // Orders placed (cancelled ones apart).
  orders: number;
  cancelled: number;
  // Orders eBay has fee/earnings figures for; the newest are still settling.
  withEarnings: number;
  awaitingEbay: number;
  // Orders with a supplier cost entered.
  withCost: number;
  // Profit as a share of the sales it covers.
  margin: number | null;
}

// Listing work for the Overview: live on eBay now, drafts waiting now, and
// drafts created / listings published from Liston in the chosen dates.
export interface ListingWork {
  live: number;
  waiting: number;
  drafted: number;
  published: number;
}

export interface OverviewAccount {
  id: string;
  label: string;
  status: string;
  marketplace: Marketplace | null;
  ok: boolean;
  error?: string;
  activeListings: number;
  listings: ListingWork | null;
  money: MoneySummary | null;
  financesPending: boolean;
  // False: linked before Liston asked eBay for its finances permission, so
  // fees and earnings need the account reconnected.
  financesAccess: boolean;
}

export interface OverviewMarket {
  id: string;
  label: string;
  name: string;
  flag: string;
  currency: string;
  accounts: number;
  activeListings: number;
  listings: ListingWork;
  money: MoneySummary;
}

export interface Overview {
  range: string;
  accounts: { total: number; active: number; needsAttention: number };
  activeListings: number;
  orders: number;
  drafts: number;
  publishedViaListon: number;
  // Busiest first; each in its own currency.
  markets: OverviewMarket[];
  // Every market as one figure in the busiest market's currency, the others
  // converted at the day's ECB rate (rates: how many of each currency 1 of
  // it buys). Null when no rate could be had.
  combined: { money: MoneySummary; rates: Record<string, number>; ratesDate: string | null } | null;
  // Some accounts' fees and earnings were still being read from eBay.
  financesPending: boolean;
  perAccount: OverviewAccount[];
}

export interface EbayUsage {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
  exhausted: boolean;
  lastSyncedWithEbay: string | null;
  ceilings: { background: number; push: number; user: number };
  paused: { background: boolean; push: boolean };
  deferred: { background: number; push: number };
  byCall: { name: string; count: number }[];
  byAccount: { connectionId: string; label: string; count: number; push: boolean }[];
  accountsTotal: number;
  notificationsUrl: string | null;
  orderPushConfigured: boolean; // eBay's new-order push is set up on this server
  orderPushLive: number; // accounts new-order push has actually arrived for in the last two days
  listingPushLive: number; // … and listing push
  inFlight: number;
  waiting: number;
  // eBay's traffic report has its own, much smaller allowance.
  analytics: AnalyticsUsage;
}

export interface AnalyticsUsage {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
  exhausted: boolean;
  lastSyncedWithEbay: string | null;
  ceilings: { sync: number; view: number; history: number };
  paused: { sync: boolean; view: boolean };
  byKind: { sync: number; view: number; history: number; [kind: string]: number };
  dayReadMaxListings: number;
  // History fills only in the last hours before the reset, from leftover allowance.
  spareWindow: { open: boolean; opensAt: string };
  nightlyReserve: number; // calls held back for nightly reads still due before the reset
  byAccount: {
    connectionId: string;
    label: string;
    timeZone: string | null;
    calls: number;
    finalThrough: string | null;
    detailDays: number;
    history: AnalyticsHistory | null;
    lastSyncedAt: string | null;
    status: "ok" | "reconnect" | "unsupported" | "waiting" | "error";
    lastError: string | null;
  }[];
}

export interface AccessRequest {
  id: string;
  email: string;
  name: string | null;
  access_note: string | null;
  created_at: string;
  email_verified_at: string | null;
  access_status?: "pending" | "active" | "rejected";
  access_reviewed_at?: string | null;
}

export interface User {
  id: string;
  email: string;
  name?: string | null;
  role?: "owner" | "member";
  plan_id: string;
  plan_name?: string;
  max_connections?: number;
  listings_included_per_month?: number;
  connections_used?: string;
  listings_used_this_month?: number;
  email_verified_at?: string | null;
  avatar_url?: string | null;
  access_status?: "pending" | "active" | "rejected";
  is_admin?: boolean;
  created_at: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface EbaySettings {
  marketplaceId: string;
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  merchantLocationKey?: string;
}

// Present only when the caller is a team member — resolved per-feature
// access for this connection, per the deny-by-default rule (see
// src/modules/team on the backend). Absent for an owner, who always sees
// everything.
export interface ConnectionPermissions {
  orders: boolean;
  listings: boolean;
  analytics: boolean;
  inbox: boolean;
  campaigns: boolean;
  [feature: string]: boolean;
}

export interface Connection {
  id: string;
  label: string;
  status: "active" | "expired" | "error" | "suspended";
  platform_key: string;
  platform_name: string;
  settings?: { ebay?: EbaySettings; pricing?: PricingSettings; template?: DescriptionTemplate };
  marketplace?: Marketplace | null;
  permissions?: ConnectionPermissions;
  created_at: string;
  updated_at: string;
}

export interface TeamMemberPermission {
  id: string;
  connection_id: string | null;
  feature: string;
  allowed: boolean;
}

export interface TeamMember {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  last_login_at?: string | null;
  deactivated_at?: string | null; // removed: no login, history kept
  lastActiveAt?: string | null; // their last recorded action
  today?: TeamMetrics; // what they've done today (Team page cards)
  permissions: TeamMemberPermission[];
}

// A member's figures (backend team/activity.js METRICS). An order line or
// listing counts once per range, however often it was touched.
export type TeamMetricKey = "active_days" | "supplier_orders" | "dispatched" | "cases" | "published" | "edited" | "relisted" | "ended" | "drafted" | "draft_work";
export type TeamMetrics = Record<TeamMetricKey, number>;
export type TeamRange = "today" | "yesterday" | "7d" | "30d" | "this_month" | "last_month" | "custom";

export interface MemberOverview {
  member: TeamMember & { lastActiveAt: string | null };
  recordingSince: string | null; // when Liston started noting who did what (listing work before it isn't attributed)
  range: { key: TeamRange; from: string; to: string; days: number; timeZone: string; previous: { from: string; to: string } };
  metrics: { key: TeamMetricKey; label: string }[];
  totals: TeamMetrics;
  previous: TeamMetrics;
  actions: number; // every recorded action in the range
  series: ({ day: string } & TeamMetrics)[];
  previousSeries: ({ day: string } & TeamMetrics)[]; // the period before, lined up day by day
  accounts: ({ connectionId: string | null; label: string; actions: number } & TeamMetrics)[];
  permissions: TeamMemberPermission[];
  connections: { id: string; label: string }[];
  knownFeatures: string[];
}

export interface MemberActivityItem {
  id: string;
  kind: string;
  label: string;
  subjectType: "order" | "listing" | "draft" | "account" | "session";
  subjectId: string;
  subjectPart: string | null;
  title: string | null;
  amount: number | null;
  currency: string | null;
  detail: Record<string, unknown>;
  connectionId: string | null;
  connectionLabel: string | null;
  at: string;
}

export interface PermissionUpdate {
  connectionId: string | null;
  feature: string;
  // null is only valid when connectionId is set — it clears that
  // connection's override so the global default takes over again. The
  // global default itself (connectionId: null) must be a real boolean,
  // since there's nothing higher for it to defer to.
  allowed: boolean | null;
}

// One eBay site an account sells on, as eBay's copies show it, and the
// connection holding it (null: not linked separately yet).
export interface EbaySite {
  marketplace: Marketplace;
  listings: number;
  orders: number;
  connectionId: string | null;
}

export interface Platform {
  id: string;
  key: string;
  name: string;
  role: "source" | "destination" | "both";
  status: "active" | "coming_soon";
  connectable: boolean;
  // eBay: the sites an account can be linked for, one connection each.
  marketplaces?: Marketplace[];
}

export interface Money {
  amount: number;
  currency?: string;
}

export interface Listing {
  itemId: string;
  sku: string | null;
  title: string;
  price: Money | null;
  convertedPrice: Money | null;
  quantity: number;
  quantityAvailable: number;
  quantitySold: number;
  imageUrl: string | null;
  viewItemUrl: string | null;
  startTime: string | null;
  endTime: string | null;
  lastSoldAt?: string | null; // its latest sale in the orders Liston holds (90 days)
  lastEditedAt?: string | null; // its latest edit from Liston
}

// The Orders page's orders (backend orders/order-sort.js). Left unset, the
// backend picks: the nearest dispatch deadline on Awaiting dispatch, else newest.
export type OrderSort = "newest" | "oldest" | "dispatch_soonest" | "total_high";

// The Listings tab's orders (backend listing-sort.js).
export type ListingSort = "newest" | "edited" | "best_selling" | "last_sold" | "not_selling" | "low_stock" | "price_high" | "price_low";

export interface OrderLineItem {
  itemId: string | null;
  title: string | null;
  quantityPurchased: number;
  price: Money | null;
  variation: { name: string; value: string }[];
  trackingCarrier: string | null;
  trackingNumber: string | null;
  handleByTime: string | null;
  imageUrl: string | null;
  quantityAvailable: number | null;
  viewItemUrl: string | null;
}

export interface Order {
  orderId: string;
  status: string;
  createdAt: string;
  total: Money | null;
  subtotal: Money | null;
  buyerName: string | null;
  buyerUserId: string | null;
  shippingAddress: { name: string; street1: string; street2: string; city: string; state: string; postalCode: string; country: string; phone: string } | null;
  itemTitle: string | null;
  itemId: string | null;
  itemCount: number;
  checkoutStatus: string | null;
  paidTime: string | null;
  shippedTime: string | null;
  cancelStatus: string | null;
  dispatchByTime: string | null;
  // When the carrier confirmed the last item delivered.
  deliveredAt?: string | null;
  lineItems: OrderLineItem[];
  derivedStatus?: OrderStatusFilter;
  // Liston's supplier-order rows for this order (one per line item).
  sourcing?: OrderSourcing[];
}

// --- one order in full (Fulfillment API shape) + Liston's sourcing --------

export interface Amount {
  value: number;
  currency: string;
}

export interface OrderSourcing {
  id: string;
  lineItemId: string;
  status: "to_order" | "ordered" | "shipped" | "delivered" | "problem";
  sourcePlatform: string;
  sourceAccountId: string | null;
  sourceAccountLabel: string | null;
  sourceAccountEmail: string | null;
  sourceEmail: string | null;
  sourcePassword: string | null;
  sourceOrderNo: string | null;
  placedAt: string | null;
  placedBy: { id: string; name: string | null } | null;
  cardLabel: string | null;
  cost: Amount | null;
  trackingNumber: string | null;
  carrier: string | null;
  notes: string | null;
  dispatchedAt: string | null;
  dispatchedBy: { id: string; name: string | null } | null;
  ebayFulfillmentId: string | null;
  updatedAt: string;
}

export interface OrderDetailLine {
  lineItemId: string | null;
  sourcingKey: string;
  itemId: string | null;
  legacyVariationId: string | null;
  sku: string | null;
  title: string | null;
  quantity: number;
  unitPrice: Amount | null;
  total: Amount | null;
  deliveryCost: Amount | null;
  variation: { name: string; value: string }[];
  fulfillmentStatus: string | null;
  shipByDate: string | null;
  minEstimatedDelivery: string | null;
  maxEstimatedDelivery: string | null;
  promotions: { description: string | null; discount: Amount | null }[];
  refunds: { amount: Amount | null; date: string; referenceId: string | null }[];
  ebayCollectedTax: Amount | null;
  imageUrl: string | null;
  viewItemUrl: string | null;
  quantityAvailable?: number | null;
  // The listing's item specifics (Brand, Colour, Material…), as eBay shows
  // them under "See more item specifics".
  itemSpecifics?: Record<string, string[]>;
  listingId?: string;
  priceBreakdown?: PriceBreakdown | null;
  sourcing: OrderSourcing | null;
}

export interface OrderDetail {
  orderId: string;
  legacyOrderId: string | null;
  salesRecordReference: string | null;
  createdAt: string;
  lastModified: string | null;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  cancelState: string;
  cancelRequests: { id: string; state: string; reason: string; requestedAt: string; completedAt: string | null; initiator: string }[];
  buyer: { username: string | null; feedbackScore?: number | null; feedbackPercent?: string | null; repeatBuyer?: boolean };
  buyerCheckoutNotes: string | null;
  shipTo: { name: string; street1: string; street2: string; city: string; state: string; postalCode: string; country: string; phone: string; email: string } | null;
  shippingService: string | null;
  shippingCarrier: string | null;
  // When the carrier confirmed delivery (from the account's order copy).
  deliveredAt?: string | null;
  estimatedDelivery: { min: string | null; max: string | null };
  pricing: { subtotal: Amount | null; discount: Amount | null; delivery: Amount | null; deliveryDiscount: Amount | null; tax: Amount | null; adjustment: Amount | null; total: Amount | null };
  payments: { method: string | null; status: string; amount: Amount | null; date: string; referenceId: string | null }[];
  refunds: { amount: Amount | null; date: string; status: string; referenceId: string | null }[];
  totalDueSeller: Amount | null;
  totalMarketplaceFee: Amount | null;
  // From eBay's Finances API: what eBay took and where the money is. Null
  // until eBay has recorded the sale, or without the finances scope.
  earnings?: {
    fundsStatus: string;
    fundsStatusCode: string | null;
    payoutId: string | null;
    fees: { code: string; label: string; amount: Amount }[];
    totalFees: Amount;
    gross: Amount;
    earnings: Amount;
  } | null;
  // Why `earnings` is null: the token lacks the finances permission
  // (reconnect), eBay hasn't posted the sale yet, or the read failed.
  earningsUnavailable?: "scope" | "pending" | "error" | null;
  lineItems: OrderDetailLine[];
  // Put away from Liston's order list (Seller Hub's "Archive").
  archived?: boolean;
  fulfillments: { fulfillmentId: string | null; carrier: string | null; trackingNumber: string | null; shippedDate: string | null; lineItems: { lineItemId: string; quantity: number }[] }[];
}

export interface OrderReturn {
  id: string;
  state: string | null;
  status: string | null;
  type: string | null;
  reason: string | null;
  buyerComment: string | null;
  itemId: string | null;
  quantity: number | null;
  openedAt: string | null;
  respondBy: string | null;
  refundAmount: Amount | null;
  tracking: string | null;
  carrier: string | null;
  closed: boolean;
}

export interface OrderInquiry {
  id: string;
  state: string | null;
  status: string | null;
  itemId: string | null;
  openedAt: string | null;
  respondBy: string | null;
  claimAmount: Amount | null;
  closed: boolean;
}

export interface OrderDispute {
  id: string;
  status: string | null;
  reason: string | null;
  amount: Amount | null;
  openedAt: string | null;
  respondBy: string | null;
  closed: boolean;
}

export interface OrderCases {
  returns: OrderReturn[];
  inquiries: OrderInquiry[];
  disputes: OrderDispute[];
  unavailable: "scope" | "error" | null;
  returnDeclineReasons: { code: string; label: string }[];
}

export interface OrderEvent {
  id: string;
  kind: string;
  lineItemId?: string | null;
  detail: Record<string, unknown>;
  actor: { id: string; name: string | null } | null;
  at: string;
}

export interface OrderDetailResponse {
  order: OrderDetail;
  actionsEnabled: boolean;
  source: "fulfillment" | "trading";
  events: OrderEvent[];
  carriers: { code: string; label: string }[];
  cancelReasons?: { code: string; label: string }[];
  refundReasons?: { code: string; label: string }[];
}

export interface SourcingPatch {
  status?: OrderSourcing["status"];
  sourceAccountId?: string | null;
  sourceEmail?: string;
  sourcePassword?: string;
  sourceOrderNo?: string;
  placedAt?: string | null;
  placedBy?: string | null;
  cardLabel?: string;
  cost?: { value: string | number; currency: string } | null;
  trackingNumber?: string;
  carrier?: string;
  notes?: string;
  quantity?: number;
  dispatchOnEbay?: boolean;
}

export interface SourceAccount {
  id: string;
  platform: string;
  label: string;
  email: string;
  password: string | null;
  notes: string | null;
  archived: boolean;
}

export interface OrderCounts {
  all: number;
  awaiting_payment: number;
  awaiting_dispatch: number;
  dispatched: number;
  delivered: number;
  cancelled: number;
}

// Where an order's supplier order stands (the Orders page's Supplier filter).
export type SupplierFilter = "any" | "pending" | "ordered" | "shipped" | "delivered" | "problem";

export interface Policy {
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  name: string;
  marketplaceId: string;
}

export interface LocationAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateOrProvince?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  name?: string;
  company?: string;
}

export interface MerchantLocation {
  merchantLocationKey: string;
  name?: string;
  status?: string | null;
  address?: LocationAddress | null;
}

// Which eBay site a connection sells on, detected from the account itself.
export interface Marketplace {
  id: string;
  label: string;
  name: string;
  flag: string;
  currency: string;
  country: string;
  countryName: string;
  itemHost: string;
  // The site's own time zone ("Europe/London"): the account's dates are shown in it.
  timeZone?: string;
  // The market's wording for the description template.
  template?: { tagline: string; warehouse: string; carrier: string; region: string; postageWord: string };
}

export interface ConnectionPolicies {
  marketplace: Marketplace;
  registrationAddress: LocationAddress | null;
  fulfillmentPolicies: Policy[];
  paymentPolicies: Policy[];
  returnPolicies: Policy[];
  merchantLocations: MerchantLocation[];
}

export interface OfferPrice {
  value: string;
  currency: string;
}

// Present once persisted server-side (see DraftListing.generated_data) — the
// policies actually attached at draft time, not the connection's current defaults.
export interface ListingPolicies {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

// eBay's own guesses at the right leaf category for a product.
export interface CategorySuggestion {
  id: string;
  name: string;
  path: string[];
}

// One row of the category picker.
export interface CategoryNode {
  id: string;
  name: string;
  leaf: boolean;
  childCount: number;
  path?: string[];
}

// One item specific eBay lists for a category, filled or not.
export interface AspectSchemaEntry {
  name: string;
  required: boolean;
  recommended: boolean;
  selectionOnly: boolean;
  multiValue: boolean;
  variation: boolean;
  allowedValues: string[];
  hasMoreValues: boolean;
}

export interface VariationFixes {
  axes: string[];
  allowedHere: string[];
  categories: { id: string; name: string; path: string[]; axisNames: Record<string, string> }[];
}

export interface DraftCategoryInfo {
  id: string;
  path: string[] | { id: string; name: string }[];
  variationsSupported: boolean | null;
  aspects: AspectSchemaEntry[];
  // Attribute names eBay accepts as variations in this category; null when unknown.
  variationAspects?: string[] | null;
  // Item specifics of this category eBay does NOT let a listing vary by
  // ("Unit Quantity"); any other name, including the seller's own, is accepted.
  blockedVariationAspects?: string[] | null;
}

export interface StoreCategory {
  id: string;
  name: string;
  children: StoreCategory[];
}

export interface StoreCategoriesResponse {
  categories: StoreCategory[];
  // true: the account has an eBay Shop; false: no Shop subscription, so no
  // departments can exist; null: eBay couldn't be read (see `unavailable`).
  hasStore: boolean | null;
  unavailable?: string;
  created?: StoreCategory;
  warnings?: string[];
}

export interface SingleDraftContent {
  title: string;
  description: string;
  imageUrls: string[];
  aspects?: Record<string, string[]>;
  condition?: string;
  quantity: number;
  categoryId: string;
  categoryPath?: string[];
  categorySuggestions?: CategorySuggestion[];
  secondaryCategoryId?: string | null;
  storeCategoryNames?: string[];
  sku?: string;
  price: OfferPrice;
  priceBreakdown?: PriceBreakdown;
  marketplaceId?: string;
  merchantLocationKey: string;
  listingPolicies?: ListingPolicies;
  // Things the automated drafting steps couldn't do — dropped item specifics,
  // supplier photos that were marketing graphics, variations with no photo of
  // their own. Shown on the review page rather than failing the draft.
  warnings?: string[];
}

export interface VariationDraftVariant {
  sku?: string;
  imageUrls: string[];
  aspects: Record<string, string[]>;
  condition?: string;
  quantity: number;
  price: OfferPrice;
  priceBreakdown?: PriceBreakdown;
}

export interface VariationDraftContent {
  commonTitle: string;
  commonDescription: string;
  imageUrls: string[];
  variesBy: {
    aspects: Record<string, string[]>;
    aspectsImageVariesBy: string[];
    specifications: { name: string; values: string[] }[];
  };
  variants: VariationDraftVariant[];
  categoryId: string;
  categoryPath?: string[];
  categorySuggestions?: CategorySuggestion[];
  secondaryCategoryId?: string | null;
  storeCategoryNames?: string[];
  sku?: string;
  marketplaceId?: string;
  merchantLocationKey: string;
  listingPolicies?: ListingPolicies;
  warnings?: string[];
}

export type DraftContent = SingleDraftContent | VariationDraftContent;

export function isVariationDraft(content: DraftContent): content is VariationDraftContent {
  return "variants" in content;
}

// Step one of drafting: both listings read, nothing generated. Enough for
// the seller to choose which variations to list before anything is paid for.
export interface DraftPreviewAxisValue {
  value: string;
  imageUrl: string | null;
  combinations: number;
}

export interface DraftPreview {
  previewId: string;
  competitor: { title: string; priceText: string | null; categoryPath: string[]; axes: { name: string; values: string[] }[] } | null;
  category: { id: string; path: string[] };
  categorySuggestions: CategorySuggestion[];
  source: {
    title: string;
    priceText: string | null;
    imageUrls: string[];
    // The variation axes as the draft will have them: `name` is the
    // supplier's, `ebayName` what the listing will call it, `via` how that
    // was decided (exact | competitor | synonym | source | unresolved).
    axes: { name: string; ebayName: string; via: string; hasImages: boolean; values: DraftPreviewAxisValue[] }[];
    // Supplier options with a single value: a property of the product, not a choice.
    fixed: { name: string; value: string }[];
    allowedAxes: string[];
    warnings: string[];
    totalCombinations: number;
  };
}

export type GenerateDraftInput =
  | { competitorUrl?: string; sourceUrl: string }
  | { previewId: string; variantSelection?: Record<string, string[]> };

// Listing settings — every sell price is derived from these plus the
// supplier's own cost, so the seller never types a price per draft.
// The store's description template: branding, delivery and returns copy
// that wraps every listing this account publishes. Per account — two
// stores on one Liston get two different descriptions from the same draft.
// The typefaces a template can use — font stacks buyers already have, since
// eBay strips external stylesheets from a description. Mirrors FONTS in
// src/modules/listings/description-template.js.
export const TEMPLATE_FONTS: { id: string; name: string; stack: string; note: string }[] = [
  { id: "modern", name: "Modern Sans", stack: "Nunito,'Segoe UI',Helvetica,Arial,sans-serif", note: "Friendly and clear — the default" },
  { id: "classic", name: "Classic Sans", stack: "'Helvetica Neue',Helvetica,Arial,sans-serif", note: "Neutral, timeless" },
  { id: "humanist", name: "Humanist", stack: "Verdana,Tahoma,'Segoe UI',sans-serif", note: "Wide and very readable" },
  { id: "geometric", name: "Geometric", stack: "'Trebuchet MS','Gill Sans','Century Gothic',sans-serif", note: "Crisp, a little characterful" },
  { id: "rounded", name: "Rounded", stack: "'Avenir Next Rounded','Arial Rounded MT Bold','Nunito',sans-serif", note: "Soft, approachable" },
  { id: "system", name: "System", stack: "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", note: "Whatever the buyer's device uses" },
  { id: "serif", name: "Classic Serif", stack: "Georgia,'Times New Roman',Times,serif", note: "Traditional, editorial" },
  { id: "elegant", name: "Elegant Serif", stack: "'Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif", note: "Refined, boutique" },
];

export interface DescriptionTemplate {
  storeName: string;
  tagline: string;
  logoUrl: string;
  accentColor: string;
  darkColor: string;
  // One of TEMPLATE_FONTS' ids; the template's typeface.
  fontFamily: string;
  feedbackPercent: string;
  dispatchTime: string;
  dispatchNote: string;
  carrier: string;
  deliveryTime: string;
  freePostage: boolean;
  returnsDays: number;
  recommendedCount: number;
  responseTime: string;
  reviews: { stars: number; text: string; buyer: string; date: string }[];
  // The seller's own HTML with {{placeholders}}; empty uses Liston's layout.
  customHtml: string;
}

export interface StoreReview {
  stars: number;
  text: string;
  buyer: string;
  date: string;
  itemTitle?: string;
}

export interface PricingSettings {
  targetRoiPercent: number;
  adsFeePercent: number;
  processingFeePercent: number;
  fixedFeePerOrder: number;
  shippingCostPerOrder: number;
  currency: string;
  roundTo99: boolean;
  // The target ROI is a floor. When the competitor already sells above it,
  // match their price and take the wider margin instead.
  followCompetitorPrice: boolean;
}

// The full working behind one price, so the review page can show why a
// number is what it is instead of asking the seller to trust it.
export interface PriceBreakdown {
  sellPrice: number;
  itemCost: number;
  shippingCost: number;
  totalCost: number;
  fees: { ads: number; processing: number; fixed: number };
  feeRates?: { adsPercent: number; processingPercent: number };
  profit: number;
  roiPercent: number;
  currency: string;
  targetRoiPercent: number;
  costIsExact?: boolean;
  // Which rule set the price: our ROI floor, or the competitor's own price.
  basis?: "target-roi" | "competitor" | "manual";
  floorPrice?: number;
  competitorPrice?: number | null;
}

// Only what changed. Variants are keyed by index (a local draft has no SKUs
// yet); removals are expressed as such rather than as a replacement array.
export interface DraftPatch {
  title?: string;
  commonTitle?: string;
  description?: string;
  commonDescription?: string;
  condition?: string;
  aspects?: Record<string, string[]>;
  imageUrls?: string[];
  price?: OfferPrice;
  quantity?: number;
  listingPolicies?: ListingPolicies;
  variants?: Record<string, { price?: OfferPrice; quantity?: number; imageUrls?: string[] }>;
  removeAxisValues?: { axis: string; value: string }[];
  renameAxisValues?: { axis: string; from: string; to: string }[];
  renameAxes?: { from: string; to: string }[];
  addAxisValues?: { axis: string; value: string; copyFrom?: string }[];
  variantSkusToRemove?: string[];
  sku?: string;
  categoryId?: string;
  secondaryCategoryId?: string | null;
  storeCategoryNames?: string[];
}

export interface ImageCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// What the AI may change on a draft: everything on the editor except the
// photos. Variations are addressed by index, options by their current name.
export interface RevisionChanges {
  title?: string;
  commonTitle?: string;
  description?: string;
  commonDescription?: string;
  aspects?: Record<string, string[]>;
  removeAspects?: string[];
  condition?: string;
  price?: OfferPrice;
  quantity?: number;
  sku?: string;
  variants?: { index: number; price?: OfferPrice; quantity?: number }[];
  allVariants?: { price?: OfferPrice; quantity?: number };
  renameAxes?: { from: string; to: string }[];
  renameAxisValues?: { axis: string; from: string; to: string }[];
  removeAxisValues?: { axis: string; value: string }[];
  addAxisValues?: { axis: string; value: string; copyFrom?: string }[];
  removeVariants?: number[];
  listingPolicies?: Partial<ListingPolicies>;
  storeCategoryNames?: string[];
}

// The editor's state as the AI sees it (unsaved edits included).
export interface RevisionCurrentState {
  title: string;
  description: string;
  aspects: Record<string, string[]>;
  condition: string;
  sku: string;
  currency: string;
  price?: string;
  quantity?: number;
  specifications: { name: string; values: string[] }[];
  variants: { index: number; options: string; price: string; quantity: number }[];
  policies?: { postage?: string; payment?: string; returns?: string };
  storeCategoryNames: string[];
  storeCategories?: string[];
}

export interface TextProposal {
  changes: RevisionChanges;
  summary: string;
  cannotDo?: boolean;
}

export interface ImageProposal {
  proposalId: string;
  operation: "scene" | "background" | "text_overlay";
  summary: string;
  policyWarning: string | null;
  previewDataUrl: string;
}

export interface DraftListing {
  id: string;
  connection_id: string;
  sku: string | null;
  status: string;
  generated_data: DraftContent;
  platform_offer_id: string | null;
  platform_group_key: string | null;
  external_product_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  // Set when this row is a live listing opened for editing (never a draft).
  edit_of_item_id?: string | null;
  // `ended`: the listing had ended when opened, so publishing relists it.
  source_data?: { ended?: boolean } | null;
}

export type ListingStatusFilter = "active" | "inactive";
export type OrderRange = "7d" | "30d" | "90d";
export type OrderStatusFilter = "all" | "awaiting_payment" | "awaiting_dispatch" | "dispatched" | "delivered" | "cancelled";
// ---- listing analytics ---------------------------------------------------------
// Days are eBay's reporting days (US Pacific), "YYYY-MM-DD".

export type AnalyticsRange = "7d" | "30d" | "this_month" | "last_month" | "90d";

// Traffic figures are null where eBay's figures aren't stored yet; sales
// always come from the orders.
export interface AnalyticsMetrics {
  impressions: number | null;
  views: number | null;
  ctr: number | null; // 0..1
  sold: number | null;
  orders: number | null;
  sales: number | null;
  conversion: number | null; // 0..1
}
export type AnalyticsChanges = Record<keyof AnalyticsMetrics, number | null>; // fraction, e.g. 0.12 = +12%

export interface AnalyticsDay {
  day: string;
  impressions: number | null;
  views: number | null;
  ctr: number | null;
  sold: number | null; // null before the 90 days of orders Liston keeps
  sales: number | null;
  partial: boolean; // eBay's day still running
}

export interface AnalyticsSource {
  key: "search" | "store" | "direct" | "other_ebay" | "off_ebay";
  label: string;
  views: number;
}

// A listing's health over a range (backend listing-health.js): where buyers
// drop off from search to sale, judged against the account's typical
// listing, why that's likely, and roughly what it costs.
export type HealthStage = "new" | "unmeasured" | "low_data" | "not_shown" | "not_clicked" | "not_bought" | "declining" | "converting" | "healthy";
export type HealthFix = "title" | "description" | "photo" | "photos" | "specifics" | "price" | "offer" | "restock";

export interface HealthReason {
  key: string;
  status: "fail" | "warn" | "pass" | "info";
  text: string;
  fix?: HealthFix;
}

export interface HealthRates {
  impressionsPerDay: number;
  ctr: number | null;
  conversion: number | null;
}

export interface ListingHealth {
  stage: HealthStage;
  label: string;
  tone: "good" | "warn" | "bad" | "neutral";
  problem: boolean; // worth attention: at least half a sale more at stake
  minor?: boolean; // a weak step, but worth under half a sale over these days
  detail: string;
  flags: ("restock" | "watchers")[];
  rates?: HealthRates;
  normal?: HealthRates; // the account's typical listing
  opportunity?: { units: number; amount: number }; // more sales at the typical rate, over these days
  reasons?: HealthReason[];
}

export interface AnalyticsBenchmarks {
  impressionsPerDay: number;
  ctr: number;
  conversion: number;
  listings: number; // listings with enough data behind them
}

// What a deeper check found (the live listing, its category's item
// specifics, similar listings' prices), or Liston's own draft.
export interface ListingQuality {
  source: "draft" | "check";
  titleLength?: number;
  photos?: number | null;
  specificsCount?: number;
  specificsMissing?: string[] | null;
  specificsRecommended?: number | null;
  descriptionLength?: number;
  categoryId?: string | null;
  shippingCost?: number | null;
  dispatchDays?: number | null;
  returnsAccepted?: boolean | null;
  currency?: string | null;
  competitor?: { query?: string; compared?: number; cheapest: number | null; median?: number | null; error?: string } | null;
  editedAt?: string; // brought up to date by an edit published from Liston (no eBay call)
}

export interface HealthCheck {
  checkedAt: string;
  quality: ListingQuality;
  calls: number;
}

export interface ListingEditFigures {
  days: number;
  impressionsPerDay: number;
  viewsPerDay: number;
  ctr: number | null;
  soldPerDay: number | null;
  conversion: number | null;
}

// A live edit made in Liston and the listing's figures either side of it.
export interface ListingEdit {
  id: string;
  changedAt: string;
  day: string;
  fields: ("title" | "main_photo" | "photos" | "price" | "quantity" | "specifics" | "description")[];
  before: { title?: string; mainPhoto?: string | null; photos?: number; price?: number | null; quantity?: number; specifics?: number };
  after: { title?: string; mainPhoto?: string | null; photos?: number; price?: number | null; quantity?: number; specifics?: number };
  figuresBefore: ListingEditFigures | null;
  figuresAfter: ListingEditFigures | null;
  waitDays: number; // complete days still needed before "after" is judged
}

export interface AnalyticsRangeInfo {
  key: AnalyticsRange;
  from: string;
  to: string;
  days: number;
  partial: boolean; // Today: the running day, so far
  previous: { from: string; to: string };
}

// How a listing's traffic for a range is known:
//   measured  exact figures (zero included) from eBay's report for the range
//   below     not among the busiest 200 read: fewer impressions than the cutoff
//   unknown   no report (not read yet, allowance used, or no traffic access)
// pending: the stored history doesn't reach this range yet; below: a big
// store's listing outside eBay's busiest 200 on some day.
export type ListingTrafficState = "measured" | "pending" | "below" | "unknown";

// A listing's latest edit from Liston, for the Analytics table.
export interface ListingLastEdit {
  changedAt: string;
  day: string; // in the seller's time zone
  fields: ListingEdit["fields"];
  waiting: boolean; // its results aren't in yet: kept out of Needs attention
  resultsFrom: string; // the day its effect is first judged
}

export interface ListingAnalyticsRow extends AnalyticsMetrics {
  itemId: string;
  title: string;
  imageUrl: string | null;
  url: string | null;
  price: Money | null;
  quantityAvailable: number | null;
  watchers: number | null; // buyers watching it now
  traffic: ListingTrafficState;
  changes: AnalyticsChanges;
  health: ListingHealth | null;
  lastEdit: ListingLastEdit | null; // its latest edit from Liston in the last 2 weeks
}

export type AnalyticsStatus = "ok" | "reconnect" | "unsupported";

// How much of an account's day-by-day listing history is stored: ranges
// inside it are added up in Liston, with no eBay calls.
export interface AnalyticsHistory {
  stored: number;
  needed: number;
  complete: boolean;
}

export interface ListingReportInfo {
  state: "ok" | "filling" | "none" | "allowance" | "error";
  message?: string;
  busiest?: boolean; // history: exact for eBay's busiest 200 each day, not the rest
  scope?: string; // "history" (added up from stored days) | "top" (busiest 200, or every listing of a store of ≤200) | "all"
  cutoff?: number | null; // impressions of the 200th listing; null = every listing read
  measured?: number;
  fetchedAt?: string;
  live: number;
  loadAllCalls: number;
  canLoadAll: boolean;
}

export interface AccountAnalytics {
  status: AnalyticsStatus;
  timeZone: string;
  range: AnalyticsRangeInfo;
  currency: string | null;
  totals: AnalyticsMetrics;
  previous: AnalyticsMetrics;
  changes: AnalyticsChanges;
  series: AnalyticsDay[];
  previousSeries: AnalyticsDay[]; // the comparison period, day by day
  leadInSeries?: AnalyticsDay[] | null; // a single-day range: the 14 days ending with it, for the chart
  sources: AnalyticsSource[];
  listings: ListingAnalyticsRow[];
  benchmarks: AnalyticsBenchmarks | null; // the account's typical listing over this range
  listingReport: ListingReportInfo;
  sync: {
    lastSyncedAt: string | null;
    lastError: string | null;
    waitingForAllowance: boolean; // today's allowance ran out before this account's read
    finalThrough: string | null;
    nextSyncAt: string;
    history: AnalyticsHistory | null;
    syncing: boolean;
  };
  listingsSyncedAt: number | null;
}

export interface ListingAnalytics {
  status: AnalyticsStatus;
  timeZone: string;
  listing: {
    itemId: string;
    title: string;
    imageUrl: string | null;
    url: string | null;
    price: Money | null;
    quantityAvailable: number | null;
    quantitySold: number | null;
    watchers: number | null;
    startTime: string | null;
  };
  range: AnalyticsRangeInfo;
  currency: string | null;
  traffic: ListingTrafficState;
  cutoff: number | null;
  totals: AnalyticsMetrics;
  previous: AnalyticsMetrics | null;
  changes: AnalyticsChanges;
  series: AnalyticsDay[];
  previousSeries: AnalyticsDay[];
  leadInSeries?: AnalyticsDay[] | null;
  sources: AnalyticsSource[];
  health: ListingHealth | null;
  benchmarks: AnalyticsBenchmarks | null;
  check: HealthCheck | null; // the last deeper check, if one was run
  checkCalls: { listing: number; competitor: number };
  edits: ListingEdit[];
  dailyTrafficDays: number; // days in the range with this listing's daily traffic
  comparable: boolean; // false when the listing started after the previous period began
  canRead: boolean; // "Read this listing" is offered (not in the stored days, allowance left)
  readCalls: number;
  sync: { finalThrough: string | null };
}


export type EarningsRange = "today" | "7d" | "30d" | "90d" | "this_month" | "last_month" | "custom" | "all_time";

export const api = {
  signup: (email: string, password: string, extra: { name?: string; accessNote?: string } = {}) =>
    request<AuthResponse>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password, ...extra }),
    }),

  // Admin: today's use of the shared eBay allowance.
  getEbayUsage: (sync = false) => request<EbayUsage>(`/api/ebay/usage${sync ? "?sync=1" : ""}`),

  listAccessRequests: () =>
    request<{ requests: AccessRequest[]; reviewed: AccessRequest[] }>("/api/auth/access/requests"),
  decideAccessRequest: (userId: string, status: "active" | "rejected") =>
    request<{ user: { id: string; email: string; access_status: string; deleted?: boolean } }>(`/api/auth/access/requests/${userId}`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),

  login: (email: string, password: string) =>
    request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ user: User }>("/api/users/me"),
  // The owner's dashboard: "today" is the viewer's own day.
  overview: (range = "30d") => request<Overview>(`/api/overview?range=${range}&tz=${encodeURIComponent(viewerTimeZone())}`),

  verifyEmail: (token: string) =>
    request<{ user: User }>("/api/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  resendVerification: () =>
    request<{ message: string }>("/api/auth/resend-verification", {
      method: "POST",
    }),

  forgotPassword: (email: string) =>
    request<{ message: string }>("/api/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, password: string) =>
    request<{ message: string }>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),

  deleteAccount: () => request<void>("/api/users/me", { method: "DELETE" }),

  updateEmail: (email: string, currentPassword: string) =>
    request<{ message: string }>("/api/users/me/email", {
      method: "PATCH",
      body: JSON.stringify({ email, currentPassword }),
    }),

  updatePassword: (currentPassword: string, newPassword: string) =>
    request<{ message: string }>("/api/users/me/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  listConnections: () =>
    request<{ connections: Connection[]; maxConnections: number }>("/api/connections"),

  listPlatforms: () => request<{ platforms: Platform[] }>("/api/connections/platforms"),

  getConnection: (id: string) => request<{ connection: Connection }>(`/api/connections/${id}`),

  // `marketplaceId`: the eBay site to link the account for. The same eBay
  // account can be linked once per site.
  startEbayAuth: (label: string, marketplaceId?: string) =>
    request<{ authorizeUrl: string }>("/api/connections/ebay/authorize", {
      method: "POST",
      body: JSON.stringify({ label, marketplaceId }),
    }),

  getEbaySites: (id: string) => request<{ sites: EbaySite[] }>(`/api/connections/${id}/sites`),

  // Another site of the account as its own connection; no eBay sign-in.
  addEbaySite: (id: string, marketplaceId: string) =>
    request<{ connection: Connection }>(`/api/connections/${id}/sites`, { method: "POST", body: JSON.stringify({ marketplaceId }) }),

  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: "DELETE" }),

  // Re-runs eBay's consent for an existing account so its token gains the
  // scopes added since it was linked (order actions). Same connection id.
  reauthorizeConnection: (id: string, returnTo?: string) =>
    request<{ authorizeUrl: string }>(`/api/connections/${id}/reauthorize`, { method: "POST", body: JSON.stringify({ returnTo }) }),

  updateAvatar: (avatarUrl: string) =>
    request<{ message: string }>("/api/users/me/avatar", {
      method: "PATCH",
      body: JSON.stringify({ avatarUrl }),
    }),

  deleteAvatar: () => request<{ message: string }>("/api/users/me/avatar", { method: "DELETE" }),

  getConnectionListings: (id: string, status: ListingStatusFilter, page = 1, perPage: number | "all" = 25, search = "", sort: ListingSort = "newest") => {
    const params = new URLSearchParams({ status, page: String(page), perPage: String(perPage), sort });
    if (search) params.set("q", search);
    return request<{ items: Listing[]; totalEntries: number; totalPages: number; page: number; perPage: number; sort: ListingSort; allCount: number; syncedAt: string | null }>(
      `/api/connections/${id}/listings?${params.toString()}`
    );
  },

  // Re-reads the account from eBay now (once a minute per account).
  refreshConnection: (id: string) => request<{ syncedAt: string }>(`/api/connections/${id}/refresh`, { method: "POST" }),

  getConnectionOrders: (
    id: string,
    params: { range: OrderRange; status: OrderStatusFilter; search?: string; sort?: OrderSort; page?: number; perPage?: number; archived?: boolean; supplier?: SupplierFilter }
  ) => {
    const query = new URLSearchParams({
      range: params.range,
      status: params.status,
      page: String(params.page ?? 1),
      perPage: String(params.perPage ?? 25),
    });
    if (params.search) query.set("search", params.search);
    if (params.sort) query.set("sort", params.sort);
    if (params.archived) query.set("archived", "1");
    if (params.supplier && params.supplier !== "any") query.set("supplier", params.supplier);
    return request<{
      orders: Order[];
      counts: OrderCounts;
      supplier?: SupplierFilter;
      // Orders in the chosen tab at each supplier state.
      supplierCounts?: Partial<Record<SupplierFilter, number>> | null;
      totalEntries: number;
      totalPages: number;
      syncedAt: string | null;
      page: number;
      perPage: number;
      archivedCount?: number;
    }>(`/api/connections/${id}/orders?${query.toString()}`);
  },

  getOrder: (connectionId: string, orderId: string) =>
    request<OrderDetailResponse>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}`),
  // Saves one line's supplier-order details; a new tracking number also
  // dispatches the line on eBay (see `dispatch` in the response).
  saveOrderSourcing: (connectionId: string, orderId: string, lineKey: string, patch: SourcingPatch) =>
    request<{ sourcing: OrderSourcing; dispatch: { ok: boolean; fulfillmentId?: string | null; reason?: string; code?: string | null } | null }>(
      `/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/sourcing/${encodeURIComponent(lineKey)}`,
      { method: "PUT", body: JSON.stringify(patch) }
    ),
  addOrderNote: (connectionId: string, orderId: string, text: string) =>
    request<{ event: OrderEvent }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/notes`, { method: "POST", body: JSON.stringify({ text }) }),
  // Seller Hub's "More actions", done from Liston.
  dispatchOrder: (connectionId: string, orderId: string, input: { trackingNumber?: string; carrier?: string; lineItemIds?: string[] }) =>
    request<{ fulfillmentId: string | null; lines: number }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/dispatch`, { method: "POST", body: JSON.stringify(input) }),
  refundOrder: (connectionId: string, orderId: string, input: { amount?: string | null; reason: string; comment?: string }) =>
    request<{ refundId: string | null; status: string | null; amount: Amount | null }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/refund`, { method: "POST", body: JSON.stringify(input) }),
  cancelOrder: (connectionId: string, orderId: string, input: { reason?: string }) =>
    request<{ cancelId: string | null; approved: boolean }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST", body: JSON.stringify(input) }),
  // Post-sale cases on an order (returns, item-not-received inquiries,
  // payment disputes) and the seller's answers to them.
  getOrderCases: (connectionId: string, orderId: string) =>
    request<OrderCases>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/cases`),
  declineCancellation: (connectionId: string, orderId: string) =>
    request<{ declined: boolean }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/cancel/decline`, { method: "POST" }),
  respondToReturn: (connectionId: string, orderId: string, input: { returnId: string; action: "accept" | "decline" | "received" | "refund" | "message"; comment?: string; declineReason?: string; amount?: string | null }) =>
    request<{ ok: boolean }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/returns`, { method: "POST", body: JSON.stringify(input) }),
  respondToInquiry: (connectionId: string, orderId: string, input: { inquiryId: string; action: "shipment" | "refund" | "message"; carrier?: string; trackingNumber?: string; message?: string }) =>
    request<{ ok: boolean }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/inquiries`, { method: "POST", body: JSON.stringify(input) }),
  respondToDispute: (connectionId: string, orderId: string, input: { disputeId: string; action: "accept" | "contest" }) =>
    request<{ ok: boolean }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/disputes`, { method: "POST", body: JSON.stringify(input) }),
  archiveOrder: (connectionId: string, orderId: string, archived: boolean) =>
    request<{ archived: boolean }>(`/api/connections/${connectionId}/orders/${encodeURIComponent(orderId)}/archive`, { method: "POST", body: JSON.stringify({ archived }) }),
  listSourceAccounts: (includeArchived = false) => request<{ accounts: SourceAccount[] }>(`/api/source-accounts${includeArchived ? "?archived=1" : ""}`),
  createSourceAccount: (input: { label: string; email: string; password?: string | null; notes?: string | null; platform?: string }) =>
    request<{ account: SourceAccount }>(`/api/source-accounts`, { method: "POST", body: JSON.stringify(input) }),
  updateSourceAccount: (id: string, patch: Partial<{ label: string; email: string; password: string | null; notes: string | null; archived: boolean }>) =>
    request<{ account: SourceAccount }>(`/api/source-accounts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  // Listing analytics: eBay traffic (stored daily) + sales from orders.
  getAnalytics: (id: string, range: AnalyticsRange) => request<AccountAnalytics>(`/api/connections/${id}/analytics?range=${range}`),
  getListingAnalytics: (id: string, itemId: string, range: AnalyticsRange) =>
    request<ListingAnalytics>(`/api/connections/${id}/analytics/listings/${encodeURIComponent(itemId)}?range=${range}`),
  loadAllListingAnalytics: (id: string, range: AnalyticsRange) =>
    request<{ calls: number; listings: number }>(`/api/connections/${id}/analytics/listings/all?range=${range}`, { method: "POST" }),
  readListingAnalytics: (id: string, itemId: string, range: AnalyticsRange) =>
    request<{ calls: number }>(`/api/connections/${id}/analytics/listings/${encodeURIComponent(itemId)}/read?range=${range}`, { method: "POST" }),
  checkListingHealth: (id: string, itemId: string, competitor: boolean) =>
    request<HealthCheck>(`/api/connections/${id}/analytics/listings/${encodeURIComponent(itemId)}/check`, { method: "POST", body: JSON.stringify({ competitor }) }),

  getConnectionEarnings: (id: string, range: EarningsRange, custom?: { from: string; to: string }) => {
    const params = new URLSearchParams({ range });
    if (range === "custom" && custom) {
      params.set("from", custom.from);
      params.set("to", custom.to);
    }
    // `otherEarnings`: sales on the account's other eBay sites (not linked
    // separately), in their own currencies; never added into `earnings`.
    return request<{ earnings: Money; otherEarnings?: Money[]; orderCount: number; truncated: boolean }>(
      `/api/connections/${id}/earnings?${params.toString()}`
    );
  },

  // The marketplace is the account's own (detected server-side); no argument.
  getConnectionPolicies: (id: string) => request<ConnectionPolicies>(`/api/connections/${id}/policies`),

  // Creates an eBay inventory location from a confirmed address and makes it
  // the connection's shipping location.
  createConnectionLocation: (id: string, input: { name: string } & LocationAddress) =>
    request<{ merchantLocationKey: string }>(`/api/connections/${id}/locations`, { method: "POST", body: JSON.stringify(input) }),

  updateConnectionPolicies: (id: string, settings: EbaySettings) =>
    request<{ settings: { ebay: EbaySettings } }>(`/api/connections/${id}/policies`, {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

  updateConnectionPricing: (id: string, pricing: PricingSettings) =>
    request<{ settings: { pricing: PricingSettings } }>(`/api/connections/${id}/pricing`, {
      method: "PUT",
      body: JSON.stringify(pricing),
    }),

  getStoreProfile: (id: string) =>
    request<{
      storeName: string | null;
      logoUrl: string | null;
      storeDescription: string | null;
      storeUrl: string | null;
      username: string | null;
      feedbackScore: number | null;
      feedbackPercent: string | null;
    }>(`/api/connections/${id}/store-profile`),
  // Colour pairs suggested from the store logo (saved URL, or eBay's when blank).
  // The built-in template as editable HTML with placeholders.
  getTemplateSource: (id: string) => request<{ html: string; placeholders: [string, string][] }>(`/api/connections/${id}/template/source`),
  // The template rendered over a sample product, before saving.
  previewTemplate: (id: string, template: DescriptionTemplate) =>
    request<{ html: string }>(`/api/connections/${id}/template/preview`, { method: "POST", body: JSON.stringify(template) }),
  // The best five positive reviews buyers left on eBay.
  getStoreReviews: (id: string, refresh = false) => request<{ reviews: StoreReview[]; unavailable?: string }>(`/api/connections/${id}/store-reviews${refresh ? "?refresh=1" : ""}`),

  getTemplatePalette: (id: string, logoUrl?: string) =>
    request<{ logoUrl: string; colors: string[]; palettes: { name: string; accentColor: string; darkColor: string }[] }>(
      `/api/connections/${id}/template/palette${logoUrl ? `?url=${encodeURIComponent(logoUrl)}` : ""}`
    ),

  updateConnectionTemplate: (id: string, template: DescriptionTemplate) =>
    request<{ settings: { template: DescriptionTemplate } }>(`/api/connections/${id}/template`, {
      method: "PUT",
      body: JSON.stringify(template),
    }),
  previewDraftDescription: (listingId: string) =>
    request<{ html: string }>(`/api/listings/${listingId}/description-preview`),
  previewDraftListing: (connectionId: string, input: { competitorUrl?: string; sourceUrl: string }) =>
    request<DraftPreview>(`/api/connections/${connectionId}/listings/drafts/preview`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  generateDraftListing: (connectionId: string, input: GenerateDraftInput) =>
    request<{ listing: DraftListing }>(`/api/connections/${connectionId}/listings/drafts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // Permanently removes an ended listing (eBay inventory objects Liston
  // created, Liston's records, and hides it from the Inactive tab).
  removeInactiveListing: (connectionId: string, itemId: string) =>
    request<void>(`/api/connections/${connectionId}/listings/${itemId}`, { method: "DELETE" }),

  // Ends a live eBay listing now. It moves to Inactive; eBay keeps it under Unsold.
  endLiveListing: (connectionId: string, itemId: string) =>
    request<{ itemId: string; endTime: string | null; warnings: string[] }>(`/api/connections/${connectionId}/listings/${itemId}/end`, { method: "POST" }),

  // Opens a live eBay listing in the editor; returns the transient working copy.
  // `inactive`: opened from the Inactive tab to relist it.
  startLiveEdit: (connectionId: string, itemId: string, { inactive = false }: { inactive?: boolean } = {}) =>
    request<{ listing: DraftListing }>(`/api/connections/${connectionId}/listings/${itemId}/edit${inactive ? "?inactive=1" : ""}`, { method: "POST" }),

  listDraftListings: (connectionId: string) =>
    request<{ drafts: DraftListing[] }>(`/api/connections/${connectionId}/listings/drafts`),

  getDraftListing: (listingId: string) =>
    request<{ listing: DraftListing; policies: ConnectionPolicies | null; category: DraftCategoryInfo | null; policyWords?: string[] }>(`/api/listings/${listingId}`),

  // Ways out when eBay refuses the draft's variation attribute in its category.
  getVariationFixes: (listingId: string) => request<VariationFixes>(`/api/listings/${listingId}/variation-fixes`),
  applyVariationFix: (listingId: string, fix: { categoryId: string; axisNames: Record<string, string> }) =>
    request<{ listing: DraftListing; imageCheck: ImageCheck }>(`/api/listings/${listingId}/variation-fixes`, { method: "POST", body: JSON.stringify(fix) }),

  // Lifts one variation out into a single-item draft of its own.
  splitDraftVariant: (listingId: string, index: number) =>
    request<{ listing: DraftListing }>(`/api/listings/${listingId}/variants/${index}/split`, { method: "POST" }),

  // Category picker data, from eBay's tree for the account's marketplace.
  searchCategories: (connectionId: string, q: string) =>
    request<{ results: CategoryNode[] }>(`/api/connections/${connectionId}/categories/search?q=${encodeURIComponent(q)}`),
  categoryChildren: (connectionId: string, parentId?: string) =>
    request<{ children: CategoryNode[]; path: { id: string; name: string }[] }>(
      `/api/connections/${connectionId}/categories/children${parentId ? `?parent=${encodeURIComponent(parentId)}` : ""}`
    ),
  getCategory: (connectionId: string, categoryId: string) =>
    request<DraftCategoryInfo>(`/api/connections/${connectionId}/categories/${encodeURIComponent(categoryId)}`),
  getStoreCategories: (connectionId: string, options?: { refresh?: boolean }) =>
    request<StoreCategoriesResponse>(`/api/connections/${connectionId}/store-categories${options?.refresh ? "?refresh=1" : ""}`),
  // Creates a department in the seller's eBay Shop (top level, or under
  // `parentId`) and returns the refreshed tree.
  addStoreCategory: (connectionId: string, input: { name: string; parentId?: string }) =>
    request<StoreCategoriesResponse>(`/api/connections/${connectionId}/store-categories`, { method: "POST", body: JSON.stringify(input) }),

  publishDraftListing: (listingId: string) =>
    request<{ listing: DraftListing & { relisted?: boolean; relistedFrom?: string }; warnings?: string[] }>(`/api/listings/${listingId}/publish`, { method: "POST" }),

  // A draft lives only in Liston until Publish, so every edit below is a
  // plain update — nothing touches eBay until the seller decides to go live.
  updateDraftListing: (listingId: string, patch: DraftPatch) =>
    request<{ listing: DraftListing; imageCheck: ImageCheck }>(`/api/listings/${listingId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteDraftListing: (listingId: string) => request<void>(`/api/listings/${listingId}`, { method: "DELETE" }),
  // Rewrites every word eBay's hazardous-materials filter reacts to, on the
  // draft itself (AI first, fixed replacements as backstop), and saves.
  fixDraftPolicyWords: (listingId: string) =>
    request<{ changed: boolean; before: string[]; remaining: string[]; summary: string; listing: DraftListing }>(`/api/listings/${listingId}/policy-words/fix`, { method: "POST" }),
  // A fresh custom label nothing else on the account uses, saved to the draft.
  regenerateDraftSku: (listingId: string) => request<{ sku: string; listing: DraftListing }>(`/api/listings/${listingId}/sku`, { method: "POST" }),

  // AI revisions PROPOSE; nothing changes until the seller accepts.
  reviseDraftText: (listingId: string, instruction: string, current?: RevisionCurrentState) =>
    request<TextProposal>(`/api/listings/${listingId}/revise`, {
      method: "POST",
      body: JSON.stringify({ instruction, current }),
    }),
  reviseDraftImage: (listingId: string, imageUrl: string, instruction: string) =>
    request<ImageProposal>(`/api/listings/${listingId}/images/revise`, {
      method: "POST",
      body: JSON.stringify({ imageUrl, instruction }),
    }),
  acceptDraftImage: (listingId: string, proposalId: string, replaces: string) =>
    request<{ listing: DraftListing; imageUrl: string }>(`/api/listings/${listingId}/images/accept`, {
      method: "POST",
      body: JSON.stringify({ proposalId, replaces }),
    }),
  // The seller's own photo, sent as a data: URL. `replaces` swaps an existing
  // image wherever it appears; `variantIndex` sets a variation's photo;
  // neither appends to the gallery.
  uploadDraftImage: (listingId: string, file: File, target: { replaces?: string; variantIndex?: number } = {}) =>
    new Promise<{ listing: DraftListing; imageUrl: string }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new ApiError("Couldn't read that file.", 400));
      reader.onload = () =>
        request<{ listing: DraftListing; imageUrl: string }>(`/api/listings/${listingId}/images/upload`, {
          method: "POST",
          body: JSON.stringify({ dataUrl: reader.result, ...target }),
        }).then(resolve, reject);
      reader.readAsDataURL(file);
    }),
  // Downloads go through the API (eBay's CDN won't let the browser force a
  // cross-origin download); the token has to ride along, so it's fetched as
  // a blob and saved from an object URL.
  downloadDraftImage: async (listingId: string, url: string, n: number) => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const res = await fetch(`${API_URL}/api/listings/${listingId}/images/download?url=${encodeURIComponent(url)}&n=${n}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError("Couldn't download that image.", res.status);
    const blob = await res.blob();
    const name = res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || `image-${n}.jpg`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  listTeamMembers: () =>
    request<{ members: TeamMember[]; knownFeatures: string[] }>(`/api/team/members?tz=${encodeURIComponent(viewerTimeZone())}`),

  addTeamMember: (input: { email: string; name?: string; password: string }) =>
    request<{ member: TeamMember }>("/api/team/members", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  removeTeamMember: (id: string) => request<void>(`/api/team/members/${id}`, { method: "DELETE" }),
  restoreTeamMember: (id: string) => request<void>(`/api/team/members/${id}/restore`, { method: "POST" }),

  // A member's page: figures for a range (the viewer's own days), per day and account.
  getMemberOverview: (id: string, range: TeamRange, custom?: { from: string; to: string }) => {
    const q = new URLSearchParams({ range, tz: viewerTimeZone() });
    if (range === "custom" && custom) {
      q.set("from", custom.from);
      q.set("to", custom.to);
    }
    return request<MemberOverview>(`/api/team/members/${id}/overview?${q.toString()}`);
  },

  // Their activity log, newest first; `before` pages on, `kind` is an activity kind or a figure's key.
  getMemberActivity: (
    id: string,
    params: { range: TeamRange; from?: string; to?: string; kind?: string; connectionId?: string; before?: string; limit?: number }
  ) => {
    const q = new URLSearchParams({ range: params.range, tz: viewerTimeZone() });
    for (const [k, v] of Object.entries(params)) if (k !== "range" && v !== undefined && v !== "") q.set(k, String(v));
    return request<{ items: MemberActivityItem[]; next: string | null; range: { key: TeamRange; from: string; to: string; timeZone: string } }>(
      `/api/team/members/${id}/activity?${q.toString()}`
    );
  },
  setTeamMemberPassword: (id: string, password: string) =>
    request<void>(`/api/team/members/${id}/password`, { method: "PUT", body: JSON.stringify({ password }) }),

  updateMemberPermissions: (memberId: string, permissions: PermissionUpdate[]) =>
    request<{ permissions: TeamMemberPermission[] }>(`/api/team/members/${memberId}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),
};
