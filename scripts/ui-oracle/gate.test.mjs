import { describe, expect, it } from 'vitest';
import { compareUiOracleEvidence } from './gate.mjs';

function evidence() {
  return {
    nodes: [
      {
        nodeId: 'character-manager',
        order: 0,
        component: 'CharacterManager',
        states: ['ready'],
        actions: [],
        semantic: { role: 'region', name: 'Characters' },
        bounds: { x: 0, y: 0, width: 320, height: 700 },
      },
    ],
    actionTrace: [
      {
        gesture: 'tap',
        nodeId: 'character-manager',
        actionId: 'panel.close',
        beforeState: 'character-manager.cards',
        afterState: 'chat.open',
      },
    ],
    raster: {
      width: 320,
      height: 700,
      sha256: 'd'.repeat(64),
    },
  };
}

describe('four-dimension UI oracle gate', () => {
  it('accepts an identical artifact without a visual judgement step', () => {
    expect(compareUiOracleEvidence(evidence(), evidence())).toEqual({ ok: true, failures: [] });
  });

  it('reports each independent parity dimension', () => {
    const oracle = evidence();
    const candidate = evidence();
    candidate.nodes[0].semantic.name = 'Different';
    candidate.nodes[0].bounds.width = 321;
    candidate.actionTrace[0].afterState = 'wrong';
    candidate.raster.sha256 = 'e'.repeat(64);

    expect(compareUiOracleEvidence(oracle, candidate)).toEqual({
      ok: false,
      failures: [
        { code: 'SEMANTIC_MISMATCH', nodeId: 'character-manager' },
        { code: 'LAYOUT_MISMATCH', nodeId: 'character-manager' },
        { code: 'ACTION_TRACE_MISMATCH' },
        { code: 'RASTER_MISMATCH' },
      ],
    });
  });
});
