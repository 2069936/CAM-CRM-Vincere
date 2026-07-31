import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_CONFIG,
  SIMPLIFIED_REPORT_CONFIG,
  hasClientOverride,
  resolveReportConfig,
} from './reportConfig';

describe('resolveReportConfig', () => {
  it('falls back to defaults when nothing is configured', () => {
    expect(resolveReportConfig(null, null)).toEqual(DEFAULT_REPORT_CONFIG);
    expect(resolveReportConfig({}, {})).toEqual(DEFAULT_REPORT_CONFIG);
  });

  it('applies the CAM config over defaults', () => {
    const resolved = resolveReportConfig({ showStrategies: false }, {});
    expect(resolved.showStrategies).toBe(false);
    expect(resolved.showFlags).toBe(true);
  });

  it('lets a client override the CAM config', () => {
    const cam = { showStrategies: true, showFlags: true };
    const client = { showFlags: false };
    const resolved = resolveReportConfig(cam, client);
    expect(resolved.showStrategies).toBe(true); // inherited from CAM
    expect(resolved.showFlags).toBe(false); // client override
  });

  it('ignores unknown or nullish keys', () => {
    const resolved = resolveReportConfig({ bogus: 1, showFlags: undefined }, null);
    expect(resolved).not.toHaveProperty('bogus');
    expect(resolved.showFlags).toBe(true);
  });

  it('supports a simplified preset applied at the client level', () => {
    const resolved = resolveReportConfig({}, SIMPLIFIED_REPORT_CONFIG);
    expect(resolved.showStrategies).toBe(false);
    expect(resolved.showSegmentTiles).toBe(false);
    expect(resolved.showProgressToTarget).toBe(true);
  });
});

describe('hasClientOverride', () => {
  it('is false for an empty or missing client config', () => {
    expect(hasClientOverride(null)).toBe(false);
    expect(hasClientOverride({})).toBe(false);
  });

  it('is true once the client sets any known key', () => {
    expect(hasClientOverride({ showFlags: false })).toBe(true);
  });
});
