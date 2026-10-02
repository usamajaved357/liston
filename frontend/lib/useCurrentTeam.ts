"use client";

import { useSyncExternalStore } from "react";
import { UserTeam } from "@/lib/api";
import { useCachedUser } from "@/lib/session";
import { currentTeam } from "@/lib/team";

// The team this tab is in, and every team the signed-in person can switch
// to, from the remembered profile. The tab's own team (lib/team.ts) picks
// which: the remembered profile is shared by every tab, and two tabs can be
// in two teams.

const noChange = () => () => {};

export function useCurrentTeam(): { team: UserTeam | null; teams: UserTeam[] } {
  const me = useCachedUser();
  const id = useSyncExternalStore(noChange, currentTeam, () => null);
  const teams = me?.teams || [];
  return { team: teams.find((t) => t.id === id) || me?.team || null, teams };
}
