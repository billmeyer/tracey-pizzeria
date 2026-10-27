import { useEffect, useRef } from 'react';
import { emitPageEnteredAction, type PageAttributes, type Step } from './events';

/**
 * Emit one `traceys.pizzeria.page.entered` INFO record when a funnel page mounts.
 *
 * The ref guard is load-bearing, not defensive: `bootstrapPage` renders every
 * page inside `<React.StrictMode>`, which in development mounts, unmounts and
 * remounts each component to surface effect-cleanup bugs. Without the guard
 * every page view would log twice in dev and once in a production build —
 * exactly the kind of discrepancy that makes people distrust the telemetry.
 * The ref survives the StrictMode remount because React reuses the fiber.
 *
 * `attributes` is read on the first mount only. That is the intent: this
 * records what the page knew on arrival, so a value that changes once
 * hydration lands should not retroactively rewrite the entry log.
 */
export function usePageEntered(step: Step, attributes: PageAttributes = {}): void {
  const emitted = useRef(false);
  const initialAttributes = useRef(attributes);

  useEffect(() => {
    if (emitted.current) return;
    emitted.current = true;
    emitPageEnteredAction(step, initialAttributes.current);
  }, [step]);
}
