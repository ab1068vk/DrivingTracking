import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import P6ExplicitOperationControl, {
  buildP6ExplicitOperationView,
} from '@/components/P6ExplicitOperationControl';
import {
  P6_EXPLICIT_OPERATION_STATES,
  P6_EXPLICIT_OPERATION_TYPES,
} from '@/lib/p6Contracts';

const record = (state, extra = {}) => ({
  operationId: 'operation-1',
  type: P6_EXPLICIT_OPERATION_TYPES.BROWSER_SPEED_MIGRATION,
  state,
  progress: { itemsWorked: 12, bytesWorked: 2048, turns: 3 },
  updatedAt: 10,
  ...extra,
});

describe('P6 explicit-operation presentation', () => {
  it('renders a direct start entry before an operation exists', () => {
    const html = renderToStaticMarkup(
      <P6ExplicitOperationControl
        operationType={P6_EXPLICIT_OPERATION_TYPES.DERIVED_REPAIR}
        title="Repair trip analytics and route previews"
        description="Rebuild derived data."
        startLabel="Start repair"
      />,
    );
    expect(html).toContain('Repair trip analytics and route previews');
    expect(html).toContain('Not started');
    expect(html).toContain('Start repair');
  });

  it('shows durable progress and resume after restart', () => {
    const operation = record(P6_EXPLICIT_OPERATION_STATES.PAUSED_AFTER_RESTART);
    const view = buildP6ExplicitOperationView(operation);
    expect(view).toMatchObject({ active: true, canResume: true, canCancel: true });
    expect(view.progressLabel).toBe('12 items · 2.0 KiB · 3 bounded turns');

    const html = renderToStaticMarkup(
      <P6ExplicitOperationControl
        operationType={operation.type}
        title="Move saved speeds to protected storage"
        description="Resume safely."
        observedOperation={operation}
      />,
    );
    expect(html).toContain('Paused after Road Sage restarted');
    expect(html).toContain('Resume');
    expect(html).toContain('Cancel');
  });

  it('shows a durable failure and a retry action', () => {
    const operation = record(P6_EXPLICIT_OPERATION_STATES.FAILED, {
      failure: { code: 'E4_PREDECESSOR_CHANGED', message: 'Saved speeds changed during migration.' },
    });
    const html = renderToStaticMarkup(
      <P6ExplicitOperationControl
        operationType={operation.type}
        title="Move saved speeds to protected storage"
        description="Migration status."
        observedOperation={operation}
      />,
    );
    expect(html).toContain('Needs attention');
    expect(html).toContain('Saved speeds changed during migration.');
    expect(html).toContain('Retry');
    expect(html).not.toContain('>Cancel<');
  });

  it('keeps a completed one-time migration visible without offering another run', () => {
    const operation = record(P6_EXPLICIT_OPERATION_STATES.COMPLETED);
    const html = renderToStaticMarkup(
      <P6ExplicitOperationControl
        operationType={operation.type}
        title="Move saved speeds to protected storage"
        description="Migration status."
        observedOperation={operation}
        repeatable={false}
      />,
    );
    expect(html).toContain('Completed');
    expect(html).not.toContain('Run again');
    expect(html).not.toContain('>Cancel<');
  });
});
