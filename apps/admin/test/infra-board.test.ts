import { describe, expect, it } from 'vitest';
import { checkTone, summarize, worstStatus } from '../src/lib/infra.js';

/**
 * G-13 — the infrastructure board must not be optimistic. These tests exist because a dashboard
 * that paints everything green is worse than no dashboard at all.
 */
describe('infrastructure board logic', () => {
  it('reports the worst status on the board, not the last one', () => {
    expect(worstStatus([{ status: 'OK' }, { status: 'WARN' }])).toBe('WARN');
    expect(worstStatus([{ status: 'DOWN' }, { status: 'OK' }])).toBe('DOWN');
    expect(worstStatus([{ status: 'OK' }, { status: 'OK' }])).toBe('OK');
    expect(worstStatus([])).toBe('OK');
  });

  it('counts each colour so the header can say what it sees', () => {
    expect(summarize([{ status: 'OK' }, { status: 'WARN' }, { status: 'WARN' }])).toEqual({
      OK: 1,
      WARN: 2,
      DOWN: 0,
    });
  });

  it('gives each colour its own tone — two statuses cannot share a colour', () => {
    const tones = new Set([checkTone('OK'), checkTone('WARN'), checkTone('DOWN')]);
    expect(tones.size).toBe(3);
  });
});
