"use client";

import { createContext, useContext } from "react";

// Whose clock an account's pages read in: the account's eBay site's time
// zone (eBay UK → Europe/London), wherever the viewer is, so a date in
// Liston matches the same order or listing in Seller Hub. AccountShell
// provides it; outside an account (Dashboard, Team) there is none and dates
// are the viewer's own.
const AccountTimeZone = createContext<string | undefined>(undefined);

export const AccountTimeZoneProvider = AccountTimeZone.Provider;

/** The account's time zone inside an account's pages; undefined (the viewer's own) elsewhere. */
export function useAccountTimeZone(): string | undefined {
  return useContext(AccountTimeZone);
}
