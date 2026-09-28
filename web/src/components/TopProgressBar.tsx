import { useBackgroundActivity } from '../lib/busy';

/**
 * A slim indeterminate bar across the very top of the app, shown whenever a
 * request has been running long enough that the page could otherwise look
 * frozen (see lib/busy.ts for the threshold/debounce). Not tied to any one
 * feature — anything that goes through the api client covers itself.
 */
export function TopProgressBar() {
  const active = useBackgroundActivity();
  if (!active) return null;
  return (
    <div className="top-progress" role="status" aria-label="Loading">
      <div className="top-progress-bar" />
    </div>
  );
}
