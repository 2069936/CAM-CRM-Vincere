import { describe, expect, it } from 'vitest';
import {
  hoistStrategyParameters,
  redactStrategyParameterValue,
  rehydrateStrategyParameters,
} from '../../export/clientExport.js';

/* THE PAYLOAD THAT IS BUILT TO LEAVE.
 *
 * Measured on production 2026-09-29: 16,273 of 16,916 strategy rows carry a
 * `LicenseKey` in parameters_raw and 12,239 of those carry a real value. The
 * dictionary that deduplicates the column held 5,669 distinct values, 1,144 of
 * them with a licence in them, and this export is handed outside the CRM.
 *
 * The three other egress points - the agent's offline report, the daily email
 * and the set-file catalogue - each name the fields they print. This one
 * cannot: src/domain/setFileMatch.js parses parameters_raw to decide which set
 * file a strategy ran from, so an emptied value answers "no configuration",
 * which is wrong and quiet. Hence a denylist on the key name, asserted here.
 */

const LICENCE = 'V-9E2B00-2613327C-F8C645W';

const row = (overrides = {}) => ({
  id: 's1',
  strategy_name: '0 - URGO-4.5',
  parameters_raw: JSON.stringify({
    LicenseKey: LICENCE, URGO1: 33, StopLossTicks: 300, MyTradeDirection: 'Long',
  }),
  params_parsed: {
    LicenseKey: LICENCE, URGO1: 33, StopLossTicks: 300, MyTradeDirection: 'Long',
  },
  ...overrides,
});

describe('what a configuration may not carry out', () => {
  it('drops the licence from the serialised map', () => {
    const cleaned = redactStrategyParameterValue('parameters_raw', row().parameters_raw);
    expect(cleaned).not.toContain(LICENCE);
    expect(cleaned).not.toContain('LicenseKey');
  });

  it('drops it from the parsed map too', () => {
    const cleaned = redactStrategyParameterValue('params_parsed', row().params_parsed);
    expect(cleaned).not.toHaveProperty('LicenseKey');
    expect(JSON.stringify(cleaned)).not.toContain(LICENCE);
  });

  it('keeps the tuning, which is what the matcher compares', () => {
    // A denylist, not an allowlist: setFileMatch.js needs the configuration to
    // decide which set file a strategy ran from.
    const cleaned = JSON.parse(redactStrategyParameterValue('parameters_raw', row().parameters_raw));
    expect(cleaned).toEqual({ URGO1: 33, StopLossTicks: 300, MyTradeDirection: 'Long' });
  });

  it('removes the key rather than blanking it', () => {
    /* A licence is not part of a set file's identity, so dropping it makes two
     * clients running the same configuration compare equal. Blanking it to ""
     * would instead read as "licensed to nobody". */
    const cleaned = JSON.parse(redactStrategyParameterValue('parameters_raw', row().parameters_raw));
    expect(Object.keys(cleaned)).not.toContain('LicenseKey');
    expect(cleaned.LicenseKey).toBeUndefined();
  });

  it('catches the other names a secret travels under', () => {
    const value = JSON.stringify({
      licence: 'a', LICENSEKEY: 'b', ApiKey: 'c', api_key: 'd',
      Password: 'e', authToken: 'f', Credential: 'g', StopLossTicks: 300,
    });
    const cleaned = JSON.parse(redactStrategyParameterValue('parameters_raw', value));
    expect(Object.keys(cleaned)).toEqual(['StopLossTicks']);
  });

  it('leaves null and empty alone', () => {
    expect(redactStrategyParameterValue('parameters_raw', null)).toBeNull();
    expect(redactStrategyParameterValue('parameters_raw', '')).toBe('');
    expect(redactStrategyParameterValue('params_parsed', null)).toBeNull();
  });

  it('passes through a value it cannot read rather than guessing', () => {
    /* A format this does not understand must fail loudly downstream, not be
     * silently replaced here. If parameters_raw ever stops being JSON, this
     * test is the one that says the redaction stopped applying. */
    expect(redactStrategyParameterValue('parameters_raw', 'not json at all'))
      .toBe('not json at all');
    expect(redactStrategyParameterValue('parameters_raw', '[1,2,3]')).toBe('[1,2,3]');
  });
});

describe('the dictionary the payload ships', () => {
  it('carries no licence in any entry', () => {
    const { entries } = hoistStrategyParameters([row(), row({ id: 's2' })]);
    const text = JSON.stringify(entries);
    expect(text).not.toContain(LICENCE);
    expect(text).not.toContain('LicenseKey');
  });

  it('collapses two rows that differ only by their licence', () => {
    /* Cleaned BEFORE the dedup key is computed. The same configuration run on
     * two machines has two licences and one set file, so this is both smaller
     * and more correct. */
    const a = row();
    const b = row({
      id: 's2',
      parameters_raw: JSON.stringify({
        LicenseKey: 'V-000000-11111111-2222222', URGO1: 33, StopLossTicks: 300, MyTradeDirection: 'Long',
      }),
      params_parsed: {
        LicenseKey: 'V-000000-11111111-2222222', URGO1: 33, StopLossTicks: 300, MyTradeDirection: 'Long',
      },
    });
    const { rows, entries } = hoistStrategyParameters([a, b]);
    expect(entries).toHaveLength(1);
    expect(rows[0].parameters_ref).toBe(rows[1].parameters_ref);
  });

  it('still gives every row a ref and round-trips', () => {
    // The contract the payload's envelope documents, unchanged by the redaction.
    const { rows, entries } = hoistStrategyParameters([row(), { id: 's3', parameters_raw: null, params_parsed: null }]);
    expect(rows.every((r) => typeof r.parameters_ref === 'number')).toBe(true);
    const back = rehydrateStrategyParameters({
      tables: { strategy_snapshots: rows },
      dictionaries: { strategyParameters: { entries } },
    });
    expect(back).toHaveLength(2);
    expect(JSON.parse(back[0].parameters_raw)).toEqual({
      URGO1: 33, StopLossTicks: 300, MyTradeDirection: 'Long',
    });
  });
});
