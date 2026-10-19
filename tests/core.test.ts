import { describe, expect, it } from 'vitest';
import { clock, parseClock } from '../packages/core/src/index';

describe('music-control formatting', () => {
  it('formats a player start offset as m:ss', () => {
    expect(clock(215)).toBe('3:35');
    expect(clock(null)).toBe('0:00');
  });

  it('accepts valid m:ss input and rejects invalid seconds', () => {
    expect(parseClock('3:35')).toBe(215);
    expect(parseClock('45')).toBe(45);
    expect(parseClock('1:60')).toBeNull();
    expect(parseClock('start')).toBeNull();
  });
});
