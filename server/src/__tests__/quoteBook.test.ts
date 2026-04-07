import { describe, it, expect } from 'vitest';
import { assessQuoteQuality } from '../services/quoteBook';

describe('assessQuoteQuality', () => {
  it('returns GOOD for tight spread + deep book', () => {
    expect(assessQuoteQuality(0.1, 20_000_000)).toBe('GOOD');
    expect(assessQuoteQuality(0.2, 10_000_000)).toBe('GOOD');
    expect(assessQuoteQuality(0.0, 100_000_000)).toBe('GOOD');
  });

  it('returns FAIR for moderate spread or moderate depth', () => {
    // Spread too wide for GOOD, but depth is acceptable for FAIR
    expect(assessQuoteQuality(0.3, 15_000_000)).toBe('FAIR');
    expect(assessQuoteQuality(0.5, 5_000_000)).toBe('FAIR');
    // Depth too shallow for GOOD, but spread is tight
    expect(assessQuoteQuality(0.1, 5_000_000)).toBe('FAIR');
    expect(assessQuoteQuality(0.2, 3_000_000)).toBe('FAIR');
  });

  it('returns POOR for wide spread', () => {
    expect(assessQuoteQuality(0.6, 10_000_000)).toBe('POOR');
    expect(assessQuoteQuality(1.0, 50_000_000)).toBe('POOR');
    expect(assessQuoteQuality(2.0, 100_000_000)).toBe('POOR');
  });

  it('returns POOR for insufficient depth', () => {
    expect(assessQuoteQuality(0.1, 2_000_000)).toBe('POOR');
    expect(assessQuoteQuality(0.0, 1_000_000)).toBe('POOR');
    expect(assessQuoteQuality(0.2, 2_999_999)).toBe('POOR');
  });

  it('boundary conditions', () => {
    // Exactly at GOOD thresholds (inclusive)
    expect(assessQuoteQuality(0.2, 10_000_000)).toBe('GOOD');
    // Just above GOOD thresholds
    expect(assessQuoteQuality(0.21, 10_000_000)).toBe('FAIR');
    expect(assessQuoteQuality(0.2, 9_999_999)).toBe('FAIR');
    // Exactly at FAIR thresholds (inclusive)
    expect(assessQuoteQuality(0.5, 3_000_000)).toBe('FAIR');
    // Just above FAIR thresholds
    expect(assessQuoteQuality(0.51, 3_000_000)).toBe('POOR');
    expect(assessQuoteQuality(0.5, 2_999_999)).toBe('POOR');
  });
});
