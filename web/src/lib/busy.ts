import { useEffect, useState } from 'react';

/**
 * Tracks in-flight API requests and reports when a global "something is
 * loading in the background" indicator should show, so a slow request never
 * just looks like the page has frozen. Fast requests — the routine
 * state-polling churn most of the app runs on — never trigger it: only ones
 * still pending past a short threshold count as "slow". A minimum visible
 * time keeps the bar from flashing for a single frame if a slow request
 * finishes right after being flagged.
 */
const SHOW_AFTER_MS = 400;
const MIN_VISIBLE_MS = 500;

let slowCount = 0;
let visible = false;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let shownAt = 0;
const listeners = new Set<(v: boolean) => void>();

function notify() {
  for (const l of listeners) l(visible);
}

function setVisible(v: boolean) {
  if (v === visible) return;
  visible = v;
  if (v) shownAt = Date.now();
  notify();
}

/** Call at the start of a request; call the returned function when it settles. */
export function beginRequest(): () => void {
  let flagged = false;
  const timer = setTimeout(() => {
    flagged = true;
    slowCount++;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    setVisible(true);
  }, SHOW_AFTER_MS);

  return () => {
    clearTimeout(timer);
    if (!flagged) return;
    slowCount = Math.max(0, slowCount - 1);
    if (slowCount > 0) return;
    const elapsed = Date.now() - shownAt;
    const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { setVisible(false); hideTimer = null; }, wait);
  };
}

export function useBackgroundActivity(): boolean {
  const [v, setV] = useState(visible);
  useEffect(() => {
    listeners.add(setV);
    setV(visible);
    return () => { listeners.delete(setV); };
  }, []);
  return v;
}
