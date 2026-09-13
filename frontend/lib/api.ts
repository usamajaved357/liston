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

export interface Connection {
  id: string;
  label: string;
  status: "active" | "expired" | "error" | "suspended";
  platform_key: string;
  platform_name: string;
  created_at: string;
  updated_at: string;
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
};
