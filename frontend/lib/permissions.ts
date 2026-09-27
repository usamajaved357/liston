import { Connection } from "@/lib/api";

// Where to send a viewer when they open a connection from a list: its
// Overview, for an owner (the money) and a member alike (their own work
// there, and the order queue with Orders access). A member only sees
// accounts they have some access to.
export function landingPathForConnection(connection: Connection): string {
  return `/accounts/${connection.id}`;
}

// Whether the viewer can open a section of an account ("" is its Overview):
// an owner (no permissions) every one; a member what their access allows,
// as the account sidebar shows it.
const SECTION_FEATURES: Record<string, string[]> = {
  "": ["orders", "listings", "hunting", "hunting_review", "analytics", "inbox", "campaigns"],
  orders: ["orders"],
  listings: ["listings"],
  research: ["listings"],
  hunting: ["hunting", "hunting_review", "listings"],
  analytics: ["analytics"],
  inbox: ["inbox"],
  campaigns: ["campaigns"],
  settings: [],
};

export function sectionAllowed(connection: Connection, section: string): boolean {
  if (!connection.permissions) return true;
  const features = SECTION_FEATURES[section] ?? [];
  return features.some((f) => connection.permissions?.[f]);
}
