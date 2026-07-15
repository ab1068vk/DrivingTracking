// @ts-check
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import {
  beginInteractionTask,
  beginNavigationFeedback,
  endInteractionTask,
  endNavigationFeedback,
  subscribeToInteractionFeedback,
} from '@/lib/interactionFeedback';

const initialState = { busy: false, count: 0, label: 'Working' };
const actionableSelector = 'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]';

const actionLabel = (element) => (
  element.getAttribute('aria-label') ||
  element.getAttribute('title') ||
  element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
  'page'
);

export default function AppInteractionFeedback() {
  const location = useLocation();
  const [state, setState] = useState(initialState);
  const fetchingCount = useIsFetching();
  const mutatingCount = useIsMutating();
  const fetchingTaskRef = useRef(null);
  const mutatingTaskRef = useRef(null);

  useEffect(() => subscribeToInteractionFeedback(setState), []);

  useEffect(() => {
    if (fetchingCount > 0 && !fetchingTaskRef.current) {
      fetchingTaskRef.current = beginInteractionTask('Loading data', { timeoutMs: 30_000 });
    } else if (fetchingCount === 0 && fetchingTaskRef.current) {
      endInteractionTask(fetchingTaskRef.current);
      fetchingTaskRef.current = null;
    }
  }, [fetchingCount]);

  useEffect(() => {
    if (mutatingCount > 0 && !mutatingTaskRef.current) {
      mutatingTaskRef.current = beginInteractionTask('Saving changes', { timeoutMs: 30_000 });
    } else if (mutatingCount === 0 && mutatingTaskRef.current) {
      endInteractionTask(mutatingTaskRef.current);
      mutatingTaskRef.current = null;
    }
  }, [mutatingCount]);

  useEffect(() => () => {
    endInteractionTask(fetchingTaskRef.current);
    endInteractionTask(mutatingTaskRef.current);
  }, []);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(endNavigationFeedback);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [location.pathname, location.search]);

  useEffect(() => {
    const onPointerDown = (event) => {
      window.dispatchEvent(new Event('app:user-interaction'));
      const target = event.target instanceof Element ? event.target.closest(actionableSelector) : null;
      if (!target || target.matches(':disabled, [aria-disabled="true"]')) return;
      target.setAttribute('data-app-pressed', 'true');
      window.setTimeout(() => target.removeAttribute('data-app-pressed'), 260);
    };

    const onKeyDown = (event) => {
      window.dispatchEvent(new Event('app:user-interaction'));
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target instanceof Element ? event.target.closest(actionableSelector) : null;
      if (!target || target.matches(':disabled, [aria-disabled="true"]')) return;
      target.setAttribute('data-app-pressed', 'true');
      window.setTimeout(() => target.removeAttribute('data-app-pressed'), 260);
    };

    const onClick = (event) => {
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!target || event.defaultPrevented) return;
      const href = target.getAttribute('href');
      if (!href || href.startsWith('#') || target.getAttribute('target') === '_blank') return;
      try {
        const destination = new URL(href, window.location.href);
        if (destination.origin !== window.location.origin) return;
        const next = `${destination.pathname}${destination.search}`;
        const current = `${window.location.pathname}${window.location.search}`;
        if (next !== current) beginNavigationFeedback(`Opening ${actionLabel(target)}`);
      } catch {
        // Invalid links are handled by the browser/router.
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  return (
    <div
      className="app-interaction-feedback"
      data-active={state.busy ? 'true' : 'false'}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div className="app-interaction-feedback__bar" aria-hidden="true" />
      <span className="sr-only">{state.busy ? `${state.label} in progress` : 'Ready'}</span>
    </div>
  );
}
