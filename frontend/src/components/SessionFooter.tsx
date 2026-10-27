import { useEffect, useState } from 'react';
import { namedAction } from '../rum/events';
import { useRumSessionId } from '../rum/use-rum-session';

type CopyState = 'idle' | 'copied' | 'failed';

const RESET_COPY_STATE_MS = 1600;

/**
 * Datadog web UI host for a DD_SITE value.
 *
 * Deliberately not just `app.${site}`. The multi-region sites already carry
 * their region in the hostname and are served *without* the `app.` prefix,
 * while US1, EU1 and US1-FED take it:
 *
 *   datadoghq.com      ->  app.datadoghq.com
 *   datadoghq.eu       ->  app.datadoghq.eu
 *   ddog-gov.com       ->  app.ddog-gov.com
 *   us3.datadoghq.com  ->  us3.datadoghq.com
 *   us5.datadoghq.com  ->  us5.datadoghq.com
 *   ap1.datadoghq.com  ->  ap1.datadoghq.com
 *
 * Blindly prefixing would yield `app.us5.datadoghq.com` — a hostname that
 * looks right in a footer and fails only when someone clicks it.
 */
const REGIONAL_SITE = /^(us3|us5|ap1|ap2)\./;

function datadogAppHost(site: string): string {
  return REGIONAL_SITE.test(site) ? site : `app.${site}`;
}

// Falls back to US1 when DD_SITE is unset, matching the Datadog SDKs' own
// default rather than rendering a broken `https://app./…` link.
const DD_SITE = import.meta.env.VITE_DD_SITE || 'datadoghq.com';
const DD_RUM_SESSIONS_URL = `https://${datadogAppHost(DD_SITE)}/rum/sessions`;

/**
 * The RUM session explorer, filtered to one session.
 *
 * The separator between facet and value is a colon, encoded `%3A`. Writing a
 * bare `%` there instead produces a malformed percent-escape: with an id
 * starting `28d4…`, `%28` decodes to `(` and the query silently matches
 * nothing. `encodeURIComponent` on the whole term is what keeps that correct
 * rather than hand-assembling the escapes.
 */
function datadogSessionUrl(sessionId: string): string {
  return `${DD_RUM_SESSIONS_URL}?query=${encodeURIComponent(`@session.id:${sessionId}`)}`;
}

/**
 * Shows the live RUM session id as a link into Datadog, plus a copy button.
 *
 * The full 32-char value is rendered rather than a truncation, because the
 * point of showing it is to find the session in Datadog — a shortened id is
 * not searchable, so prettier here would mean useless.
 */
export default function SessionFooter() {
  const sessionId = useRumSessionId();
  const [copyState, setCopyState] = useState<CopyState>('idle');

  // Clear the "Copied" acknowledgement, and cancel the timer on unmount so a
  // hard navigation mid-acknowledgement cannot set state on a dead component.
  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), RESET_COPY_STATE_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copy() {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopyState('copied');
    } catch {
      // Clipboard access can be refused (permissions policy, insecure
      // context). Say so rather than showing a false "Copied" — the id is
      // selectable text, so manual copy still works.
      setCopyState('failed');
    }
  }

  return (
    <footer className="kiosk-footer">
      <span className="session-label">Session ID:</span>

      {sessionId ? (
        <>
          {/* New tab, deliberately: following this in place would unload the
              document and end the very session you are trying to inspect. */}
          <a
            className="session-id"
            href={datadogSessionUrl(sessionId)}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this session in Datadog RUM"
            {...namedAction('footer.open_datadog_session')}
          >
            <code>{sessionId}</code>
            <span className="session-link-hint" aria-hidden="true">
              ↗
            </span>
          </a>

          <button
            type="button"
            className="session-copy"
            onClick={copy}
            title="Copy session ID"
            aria-label="Copy session ID"
            {...namedAction('footer.copy_session_id')}
          >
            <span aria-hidden="true">
              {copyState === 'copied' ? '✓' : copyState === 'failed' ? '⚠' : '⧉'}
            </span>
          </button>
        </>
      ) : (
        <code className="session-id pending">starting…</code>
      )}

      {/* Announced to screen readers; the icon swap above is decorative. */}
      <span role="status" aria-live="polite" className="session-copy-status">
        {copyState === 'copied' ? 'Session ID copied' : ''}
        {copyState === 'failed' ? 'Could not copy — select the ID to copy it' : ''}
      </span>
    </footer>
  );
}
