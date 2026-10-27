import { useEffect, useMemo, useRef, useState } from 'react';
import KioskShell from '../components/KioskShell';
import OrderSummary from '../components/OrderSummary';
import {
  cacheOrder,
  getSessionId,
  isChaos,
  readCachedOrder,
  validateOrderComplete,
  type OrderIssue,
  type OrderSnapshot,
} from '../lib/order';
import { emitAppError, emitValidationError, namedAction } from '../rum/events';
import { hardNavigate } from '../rum/navigate';
import { startOperation } from '../rum/operation';
import { usePageEntered } from '../rum/use-page-entered';

interface ChatBubble {
  role: 'user' | 'tracey';
  text: string;
}

export default function OrderPage() {
  const sessionId = useMemo(() => getSessionId(), []);
  const chaos = useMemo(() => isChaos(), []);

  const [messages, setMessages] = useState<ChatBubble[]>([
    {
      role: 'tracey',
      text: "Welcome to Tracey's — we've got 47 toppings and zero patience for pineapple discourse. What'll it be?",
    },
  ]);
  const [snapshot, setSnapshot] = useState<OrderSnapshot | null>(() => {
    // Only trust the cache if it describes an order still being built; a
    // cached *placed* order belongs to the tracking page, not here.
    const cached = readCachedOrder();
    return cached && !cached.order.receipt ? cached : null;
  });
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<OrderIssue[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  usePageEntered('order', {
    // Whether this is a fresh start or a customer coming back to an order
    // already in progress — the difference between an empty chat window and
    // one the cache repainted.
    'traceys.pizzeria.page.restored_from_cache': snapshot !== null,
    // No chaos flag here: bootstrapPage seeds it into the order context, so
    // createOrderContextLogRecordProcessor already stamps
    // traceys.pizzeria.chaos_mode on this record — and on every other span
    // and log the document emits.
  });

  useEffect(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  }, [messages.length]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    setLoading(true);

    const op = startOperation('order.send_message', { 'traceys.pizzeria.funnel.step': 'order' });
    try {
      const res = await op.run(() =>
        fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, message: text, chaos }),
        })
      );
      if (!res.ok) throw new Error(`chat failed with ${res.status}`);
      const data = (await res.json()) as {
        reply: string;
        order: OrderSnapshot['order'];
        pricing: OrderSnapshot['pricing'];
      };

      setMessages((prev) => [...prev, { role: 'tracey', text: data.reply }]);

      const fresh = { order: data.order, pricing: data.pricing };
      setSnapshot(fresh);
      // Cache it so the checkout document can paint instantly after the
      // hard transition, before its own hydration fetch returns.
      cacheOrder(fresh);
      // Re-validate against the order Tracey just updated, so a notice the
      // customer has already addressed clears itself instead of lingering.
      setIssues((prev) => (prev.length ? validateOrderComplete(fresh) : prev));
    } catch (err) {
      op.fail(err);
      emitAppError('ChatError', err, { 'traceys.pizzeria.funnel.step': 'order' }, op.ctx);
      setMessages((prev) => [
        ...prev,
        { role: 'tracey', text: "The kitchen's on fire (probably not literally). Try again?" },
      ]);
    } finally {
      op.end();
      setLoading(false);
    }
  }

  function goToCheckout() {
    const found = validateOrderComplete(snapshot);
    setIssues(found);

    if (found.length > 0) {
      // One RUM Error per unmet requirement, same shape the checkout and
      // payment pages use — so "where does the funnel stall, and on which
      // field" is a single group-by across all three steps.
      for (const issue of found) {
        emitValidationError(issue.field, issue.rule, issue.message, 'order');
      }
      return;
    }

    void hardNavigate('order', 'checkout');
  }

  return (
    <KioskShell step="order">
      <div className="chat-window">
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.text}
          </div>
        ))}
        {loading && <div className="bubble tracey typing">Tracey is thinking…</div>}
        <div ref={bottomRef} />
      </div>

      {snapshot && (snapshot.order.size || snapshot.order.toppings.length > 0) && (
        <OrderSummary snapshot={snapshot} showPricing={false} />
      )}

      {issues.length > 0 && (
        <div className="banner-error order-issues" role="alert">
          <strong>
            {issues.length === 1 ? 'One thing first:' : 'A couple of things first:'}
          </strong>
          <ul>
            {issues.map((issue) => (
              <li key={issue.field}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="action-row">
        <button
          className="primary"
          onClick={goToCheckout}
          {...namedAction('order.continue_to_checkout')}
        >
          Checkout →
        </button>
      </div>

      <div className="input-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="large pepperoni, extra cheese, thin crust..."
        />
        <button
          onClick={sendMessage}
          disabled={loading}
          {...namedAction('order.send_message')}
        >
          Send
        </button>
      </div>
    </KioskShell>
  );
}
