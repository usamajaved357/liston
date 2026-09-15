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
    throw new ApiError(data.error || "Something went wrong", res.status);
  }

  return data as T;
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
  settings?: { ebay?: EbaySettings; pricing?: PricingSettings };
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

export interface MerchantLocation {
  merchantLocationKey: string;
  name?: string;
}

export interface ConnectionPolicies {
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

export interface SingleDraftContent {
  title: string;
  description: string;
  imageUrls: string[];
  aspects?: Record<string, string[]>;
  condition?: string;
  quantity: number;
  categoryId: string;
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
  marketplaceId?: string;
  merchantLocationKey: string;
  listingPolicies?: ListingPolicies;
  warnings?: string[];
}

export type DraftContent = SingleDraftContent | VariationDraftContent;

export function isVariationDraft(content: DraftContent): content is VariationDraftContent {
  return "variants" in content;
}

export interface GenerateDraftInput {
  competitorUrl: string;
  sourceUrl: string;
}

// Listing settings — every sell price is derived from these plus the
// supplier's own cost, so the seller never types a price per draft.
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
  variants?: Record<string, { price?: OfferPrice; quantity?: number; imageUrls?: string[] }>;
  removeAxisValues?: { axis: string; value: string }[];
  variantSkusToRemove?: string[];
}

export interface ImageCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface TextProposal {
  changes: Partial<Pick<SingleDraftContent, "title" | "description" | "aspects">> & {
    commonTitle?: string;
    commonDescription?: string;
  };
  summary: string;
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
}

export type ListingStatusFilter = "active" | "inactive";
export type OrderRange = "7d" | "30d" | "90d";
export type OrderStatusFilter = "all" | "awaiting_payment" | "awaiting_dispatch" | "dispatched" | "cancelled";
export type EarningsRange = "today" | "7d" | "30d" | "90d" | "this_month" | "last_month" | "custom" | "all_time";

export const api = {
  signup: (email: string, password: string) =>
    request<AuthResponse>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  me: () => request<{ user: User }>("/api/users/me"),

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

  getConnectionListings: (id: string, status: ListingStatusFilter, page = 1) =>
    request<{ items: Listing[]; totalEntries: number; totalPages: number }>(
      `/api/connections/${id}/listings?status=${status}&page=${page}`
    ),

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

  getConnectionPolicies: (id: string, marketplaceId = "EBAY_GB") =>
    request<ConnectionPolicies>(`/api/connections/${id}/policies?marketplaceId=${marketplaceId}`),

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

  generateDraftListing: (connectionId: string, input: GenerateDraftInput) =>
    request<{ listing: DraftListing }>(`/api/connections/${connectionId}/listings/drafts`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  listDraftListings: (connectionId: string) =>
    request<{ drafts: DraftListing[] }>(`/api/connections/${connectionId}/listings/drafts`),

  getDraftListing: (listingId: string) =>
    request<{ listing: DraftListing; policies: ConnectionPolicies | null }>(`/api/listings/${listingId}`),

  publishDraftListing: (listingId: string) =>
    request<{ listing: DraftListing }>(`/api/listings/${listingId}/publish`, { method: "POST" }),

  // A draft lives only in Liston until Publish, so every edit below is a
  // plain update — nothing touches eBay until the seller decides to go live.
  updateDraftListing: (listingId: string, patch: DraftPatch) =>
    request<{ listing: DraftListing; imageCheck: ImageCheck }>(`/api/listings/${listingId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteDraftListing: (listingId: string) => request<void>(`/api/listings/${listingId}`, { method: "DELETE" }),

  // AI revisions PROPOSE; nothing changes until the seller accepts.
  reviseDraftText: (listingId: string, instruction: string) =>
    request<TextProposal>(`/api/listings/${listingId}/revise`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
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

  listTeamMembers: () =>
    request<{ members: TeamMember[]; knownFeatures: string[] }>("/api/team/members"),

  addTeamMember: (input: { email: string; name?: string; password: string }) =>
    request<{ member: TeamMember }>("/api/team/members", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  removeTeamMember: (id: string) => request<void>(`/api/team/members/${id}`, { method: "DELETE" }),

  updateMemberPermissions: (memberId: string, permissions: PermissionUpdate[]) =>
    request<{ permissions: TeamMemberPermission[] }>(`/api/team/members/${memberId}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),
};
