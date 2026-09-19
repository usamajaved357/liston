const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

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

export interface Overview {
  range: string;
  accounts: { total: number; active: number; needsAttention: number };
  activeListings: number;
  earnings: { amount: number; currency: string };
  orders: number;
  drafts: number;
  publishedViaListon: number;
  perAccount: {
    id: string;
    label: string;
    status: string;
    ok: boolean;
    error?: string;
    activeListings: number;
    earnings: { amount: number; currency: string } | null;
    orders: number;
  }[];
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
  inFlight: number;
  waiting: number;
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
  permissions: TeamMemberPermission[];
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

export interface Platform {
  id: string;
  key: string;
  name: string;
  role: "source" | "destination" | "both";
  status: "active" | "coming_soon";
  connectable: boolean;
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
}

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
  lineItems: OrderLineItem[];
  derivedStatus?: OrderStatusFilter;
}

export interface OrderCounts {
  all: number;
  awaiting_payment: number;
  awaiting_dispatch: number;
  dispatched: number;
  cancelled: number;
}

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
  profit: number;
  roiPercent: number;
  currency: string;
  targetRoiPercent: number;
  costIsExact?: boolean;
  // Which rule set the price: our ROI floor, or the competitor's own price.
  basis?: "target-roi" | "competitor";
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
}

export type ListingStatusFilter = "active" | "inactive";
export type OrderRange = "7d" | "30d" | "90d";
export type OrderStatusFilter = "all" | "awaiting_payment" | "awaiting_dispatch" | "dispatched" | "cancelled";
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
  overview: (range = "30d") => request<Overview>(`/api/overview?range=${range}`),

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

  startEbayAuth: (label: string) =>
    request<{ authorizeUrl: string }>("/api/connections/ebay/authorize", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),

  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: "DELETE" }),

  updateAvatar: (avatarUrl: string) =>
    request<{ message: string }>("/api/users/me/avatar", {
      method: "PATCH",
      body: JSON.stringify({ avatarUrl }),
    }),

  deleteAvatar: () => request<{ message: string }>("/api/users/me/avatar", { method: "DELETE" }),

  getConnectionListings: (id: string, status: ListingStatusFilter, page = 1, perPage: number | "all" = 25, search = "") => {
    const params = new URLSearchParams({ status, page: String(page), perPage: String(perPage) });
    if (search) params.set("q", search);
    return request<{ items: Listing[]; totalEntries: number; totalPages: number; page: number; perPage: number; allCount: number; syncedAt: string | null }>(
      `/api/connections/${id}/listings?${params.toString()}`
    );
  },

  // Re-reads the account from eBay now (once a minute per account).
  refreshConnection: (id: string) => request<{ syncedAt: string }>(`/api/connections/${id}/refresh`, { method: "POST" }),

  getConnectionOrders: (
    id: string,
    params: { range: OrderRange; status: OrderStatusFilter; search?: string; page?: number; perPage?: number }
  ) => {
    const query = new URLSearchParams({
      range: params.range,
      status: params.status,
      page: String(params.page ?? 1),
      perPage: String(params.perPage ?? 25),
    });
    if (params.search) query.set("search", params.search);
    return request<{
      orders: Order[];
      counts: OrderCounts;
      totalEntries: number;
      totalPages: number;
      syncedAt: string | null;
      page: number;
      perPage: number;
    }>(`/api/connections/${id}/orders?${query.toString()}`);
  },

  getConnectionEarnings: (id: string, range: EarningsRange, custom?: { from: string; to: string }) => {
    const params = new URLSearchParams({ range });
    if (range === "custom" && custom) {
      params.set("from", custom.from);
      params.set("to", custom.to);
    }
    return request<{ earnings: Money; orderCount: number; truncated: boolean }>(
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
  startLiveEdit: (connectionId: string, itemId: string) =>
    request<{ listing: DraftListing }>(`/api/connections/${connectionId}/listings/${itemId}/edit`, { method: "POST" }),

  listDraftListings: (connectionId: string) =>
    request<{ drafts: DraftListing[] }>(`/api/connections/${connectionId}/listings/drafts`),

  getDraftListing: (listingId: string) =>
    request<{ listing: DraftListing; policies: ConnectionPolicies | null; category: DraftCategoryInfo | null }>(`/api/listings/${listingId}`),

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
  getStoreCategories: (connectionId: string) =>
    request<{ categories: StoreCategory[]; unavailable?: string }>(`/api/connections/${connectionId}/store-categories`),

  publishDraftListing: (listingId: string) =>
    request<{ listing: DraftListing; warnings?: string[] }>(`/api/listings/${listingId}/publish`, { method: "POST" }),

  // A draft lives only in Liston until Publish, so every edit below is a
  // plain update — nothing touches eBay until the seller decides to go live.
  updateDraftListing: (listingId: string, patch: DraftPatch) =>
    request<{ listing: DraftListing; imageCheck: ImageCheck }>(`/api/listings/${listingId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteDraftListing: (listingId: string) => request<void>(`/api/listings/${listingId}`, { method: "DELETE" }),
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
    request<{ members: TeamMember[]; knownFeatures: string[] }>("/api/team/members"),

  addTeamMember: (input: { email: string; name?: string; password: string }) =>
    request<{ member: TeamMember }>("/api/team/members", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  removeTeamMember: (id: string) => request<void>(`/api/team/members/${id}`, { method: "DELETE" }),
  setTeamMemberPassword: (id: string, password: string) =>
    request<void>(`/api/team/members/${id}/password`, { method: "PUT", body: JSON.stringify({ password }) }),

  updateMemberPermissions: (memberId: string, permissions: PermissionUpdate[]) =>
    request<{ permissions: TeamMemberPermission[] }>(`/api/team/members/${memberId}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),
};
