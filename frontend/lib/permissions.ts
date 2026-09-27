import { Connection } from "@/lib/api";

// Where to send a viewer when they open a connection from a list — an owner
// (permissions undefined) always lands on Overview. A member lands wherever
// they actually have something to see: Overview only has content when they
// have Orders access (it's just the Earnings widget), so skip it otherwise
// and fall through to their first granted feature tab.
const FEATURE_PATHS: Record<string, string> = {
  orders: "",
  listings: "/listings",
  analytics: "/analytics",
  inbox: "/inbox",
  campaigns: "/campaigns",
  hunting: "/hunting",
  hunting_review: "/hunting",
};
const FEATURE_PRIORITY = ["orders", "listings", "hunting_review", "hunting", "analytics", "inbox", "campaigns"];

export function landingPathForConnection(connection: Connection): string {
  const base = `/accounts/${connection.id}`;
  if (!connection.permissions) return base;

  const granted = FEATURE_PRIORITY.find((feature) => connection.permissions?.[feature]);
  return granted ? `${base}${FEATURE_PATHS[granted]}` : base;
}

// Whether the viewer can open a section of an account ("" is its Overview):
// an owner (no permissions) every one; a member what their access allows,
// as the account sidebar shows it.
const SECTION_FEATURES: Record<string, string[]> = {
  "": ["orders"],
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
