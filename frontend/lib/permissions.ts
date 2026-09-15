import { Connection } from "@/lib/api";

// Where to send a viewer when they open a connection from a list — an owner
// (permissions undefined) always lands on Overview. A member lands wherever
// they actually have something to see: Overview only has content when they
// have Orders access (it's just the Earnings widget), so skip it otherwise
// and fall through to their first granted feature tab.
const FEATURE_PATHS: Record<string, string> = {
  orders: "",
  listings: "/listings",
  inbox: "/inbox",
  campaigns: "/campaigns",
};
const FEATURE_PRIORITY = ["orders", "listings", "inbox", "campaigns"];

export function landingPathForConnection(connection: Connection): string {
  const base = `/accounts/${connection.id}`;
  if (!connection.permissions) return base;

  const granted = FEATURE_PRIORITY.find((feature) => connection.permissions?.[feature]);
  return granted ? `${base}${FEATURE_PATHS[granted]}` : base;
}
