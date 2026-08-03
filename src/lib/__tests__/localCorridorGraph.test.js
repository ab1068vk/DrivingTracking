import { describe, expect, it } from 'vitest';
import { buildLocalCorridorGraph, summarizeLocalCorridorGraph } from '@/lib/localCorridorGraph';

describe('local corridor graph', () => {
  it('marks speed boundaries and keeps nearby parallel roads separate', () => {
    const graph = buildLocalCorridorGraph([
      { id: 'a', source: 'user_confirmed_posted_sign', limitKmh: 40, sectionPoints: [{ lat: 43, lng: -79 }, { lat: 43.001, lng: -79 }] },
      { id: 'b', source: 'local_road_memory', limitKmh: 60, sectionPoints: [{ lat: 43.001, lng: -79 }, { lat: 43.002, lng: -79 }] },
      { id: 'parallel', source: 'local_road_memory', limitKmh: 40, sectionPoints: [{ lat: 43, lng: -78.9994 }, { lat: 43.001, lng: -78.9994 }] },
    ]);
    const summary = summarizeLocalCorridorGraph(graph);
    expect(summary.boundaries).toBe(2);
    expect(summary.parallelProtected).toBeGreaterThanOrEqual(2);
    expect(graph.sections.find((section) => section.id === 'parallel').graphDuplicateOf).toBeNull();
  });
});
