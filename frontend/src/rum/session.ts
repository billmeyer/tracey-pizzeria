import type { SessionManager } from '@opentelemetry/browser-sdk/session';

/**
 * ── Reading the live RUM session id from the UI ────────────────────────────
 * The session id is the join key for everything this app emits: the session
 * processors stamp it as `session.id` on every span and log record, and it is
 * what a Datadog RUM session is keyed on. Showing it in the footer turns
 * "which session was I just in?" into a copy-paste instead of a hunt.
 *
 * Two details make this more than a getter:
 *
 *  1. `bootstrapPage` renders React *before* the async `initOtelRum`
 *     resolves, so a component can ask for the id before a SessionManager
 *     exists. Subscribers registered early are parked here and attached once
 *     the manager shows up.
 *
 *  2. `addObserver` only reports *future* starts and ends — it does not
 *     replay the current session. So a late subscriber has to be handed
 *     `getSessionId()` directly, and an early one gets its value from
 *     `onSessionStarted` during `sessionManager.start()`. Doing both is what
 *     makes the hook correct regardless of mount timing.
 *
 * Sessions roll over (15 min inactivity, 4h max — see otel.ts), and
 * `onSessionStarted` fires for the new one, so subscribers stay accurate
 * rather than pinning the id they first saw.
 * ──────────────────────────────────────────────────────────────────────────
 */

type Listener = (sessionId: string | null) => void;

let manager: SessionManager | undefined;
const listeners = new Set<Listener>();

function publish(): void {
  const id = getRumSessionId();
  for (const listener of listeners) listener(id);
}

/**
 * Hand the active SessionManager to the UI layer. Called by `initOtelRum`
 * *before* `sessionManager.start()`, so the observer below is in place for
 * the very first `onSessionStarted`.
 */
export function registerSessionManager(next: SessionManager): void {
  manager = next;

  manager.addObserver({
    onSessionStarted: () => publish(),
    onSessionEnded: () => publish(),
  });

  // Deliberately does NOT read the id here. `SessionManager.getSession()`
  // mints a brand-new session (and persists it) whenever its `_session` is
  // still unset, and `start()` populates that field asynchronously. Reading
  // during registration therefore races the restore and overwrites the
  // stored session with a fresh one — a new id on every document load.
  // `notifySessionReady()` below is called once start() has resolved.
}

/**
 * Publish the restored-or-created session to subscribers. Must be called
 * after `sessionManager.start()` resolves.
 *
 * Needed because `start()` only notifies observers when it *creates* a
 * session; a session restored from localStorage fires no `onSessionStarted`,
 * so observers would otherwise never learn the id of a continuing session.
 */
export function notifySessionReady(): void {
  publish();
}

/** The current RUM session id, or null before the SDK is up. */
export function getRumSessionId(): string | null {
  return manager?.getSessionId() ?? null;
}

/**
 * Subscribe to session id changes. Invokes `listener` immediately with the
 * current value (null if the SDK has not started yet). Returns an
 * unsubscribe function.
 */
export function subscribeRumSession(listener: Listener): () => void {
  listeners.add(listener);
  listener(getRumSessionId());
  return () => {
    listeners.delete(listener);
  };
}
