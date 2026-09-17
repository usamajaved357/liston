import { redirect } from "next/navigation";

// Workspace-level settings were all placeholders; everything real is set per
// account (business policies, pricing, template) under /accounts/:id/settings.
// Old links and bookmarks land on the account page instead of a 404.
export default function SettingsRedirect() {
  redirect("/account");
}
