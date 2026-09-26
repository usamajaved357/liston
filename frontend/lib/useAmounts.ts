"use client";

import { useCallback, useState } from "react";

// Whether the Overview's money amounts show, or sit behind dots (the
// default: the figures stay private when a screen is shared or someone looks
// over a shoulder). Counts and percentages always show. The choice lasts
// while the page is open (changing dates or tabs keeps it); leaving the
// page forgets it, so coming back to either Overview starts hidden again.

export function useAmounts(): { hidden: boolean; toggle: () => void } {
  const [hidden, setHidden] = useState(true);
  const toggle = useCallback(() => setHidden((h) => !h), []);
  return { hidden, toggle };
}
