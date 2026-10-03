// The team (Slack's workspace) this tab works in: one login can be in
// several owners' teams. Every request names it (X-Liston-Workspace) and
// the API answers for that team. Kept per tab (sessionStorage) so two tabs
// can be in two teams, and remembered (localStorage) for the next tab; both
// keyed by who's signed in, so another login on this browser never inherits
// it. A link with ?ws= (a notification from another team) opens in that
// team. Without one the API picks the login's last team.

const KEY = "liston:team";

// Who the stored sign-in is (the token's subject), so the team is theirs.
function signedIn(): string | null {
  try {
    const token = localStorage.getItem("token");
    const payload = token?.split(".")[1];
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).sub || null;
  } catch {
    return null;
  }
}

const keyFor = (who: string | null) => (who ? `${KEY}:${who}` : null);
const UUID = /^[0-9a-f-]{36}$/i;

/** The team this tab is in, or null to let the API pick. */
export function currentTeam(): string | null {
  if (typeof window === "undefined") return null;
  const key = keyFor(signedIn());
  if (!key) return null;
  try {
    const fromLink = new URLSearchParams(window.location.search).get("ws");
    if (fromLink && UUID.test(fromLink)) {
      if (sessionStorage.getItem(key) !== fromLink) rememberTeam(fromLink);
      return fromLink;
    }
    return sessionStorage.getItem(key) || localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** This tab (and the next one opened) works in this team; null forgets it. */
export function rememberTeam(id: string | null) {
  if (typeof window === "undefined") return;
  const key = keyFor(signedIn());
  if (!key) return;
  try {
    if (id) {
      sessionStorage.setItem(key, id);
      localStorage.setItem(key, id);
    } else {
      sessionStorage.removeItem(key);
      localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable: the API picks the last team
  }
}

/** The header every request to the API carries. */
export function teamHeaders(): Record<string, string> {
  const team = currentTeam();
  return team ? { "X-Liston-Workspace": team } : {};
}

/** Where someone lands in a team: an owner (or owner access) on the Overview, a member on their Dashboard. */
export function homeFor(role: string | undefined) {
  return role === "member" ? "/connections" : "/dashboard";
}
