import type { ReactNode } from 'react';
import { STEPS, type Step } from '../rum/events';
import { isChaos } from '../lib/order';
import SessionFooter from './SessionFooter';

const STEP_LABELS: Record<Step, string> = {
  order: 'Order',
  checkout: 'Checkout',
  payment: 'Payment',
  tracking: 'Tracking',
};

interface KioskShellProps {
  step: Step;
  children: ReactNode;
}

/**
 * Shared chrome for all four documents. Duplicated *rendering* across hard
 * page loads is the point — each step paints its own header and step rail
 * from scratch, which is what gives every step a real LCP to compare.
 */
export default function KioskShell({ step, children }: KioskShellProps) {
  const currentIndex = STEPS.indexOf(step);

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <h1>🍕 Tracey's Pizzeria</h1>
        {isChaos() && <span className="chaos-badge">CHAOS MODE</span>}
      </header>

      <ol className="step-rail" aria-label="Checkout progress">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={`step-pip ${i === currentIndex ? 'current' : ''} ${
              i < currentIndex ? 'done' : ''
            }`}
            aria-current={i === currentIndex ? 'step' : undefined}
          >
            <span className="step-pip-dot">{i < currentIndex ? '✓' : i + 1}</span>
            <span className="step-pip-label">{STEP_LABELS[s]}</span>
          </li>
        ))}
      </ol>

      {children}

      {/* Last, so it sits below each page's content. Lives here rather than
          in the four page components so every document gets it — including
          the loading and "no order found" early returns. */}
      <SessionFooter />
    </div>
  );
}
