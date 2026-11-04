import { useEffect, useState } from 'react';
import { getTelemetrySessionId, subscribeTelemetrySession } from './telemetry';

/**
 * The live RUM session id, or null until the SDK has started — and null
 * forever if no telemetry is installed, which the footer renders as
 * "starting…".
 *
 * Re-renders on session rollover, so a page left open past the 15-minute
 * inactivity timeout shows the id that new events are actually being tagged
 * with rather than the one it loaded with.
 */
export function useSessionId(): string | null {
  // Seeded synchronously so a component mounting after the SDK is already up
  // paints the real id on its first render instead of flashing "starting…".
  const [sessionId, setSessionId] = useState<string | null>(() => getTelemetrySessionId());

  useEffect(() => subscribeTelemetrySession(setSessionId), []);

  return sessionId;
}
