// The opt-in gate on the client report's simulation section.
//
// WHY THIS IS ASSERTED ON THE SOURCE. The mount lives inside App.jsx's report
// preview, seven thousand lines into a component wired to Supabase, routing and
// a dozen panels; there is no seam to render it through, and adding one to make
// it testable would change shipped code to satisfy a test. So this file asserts
// the wiring textually and leaves the behaviour of the section itself to
// SimulationReportSection.test.jsx, which renders it.
//
// It exists because a mutation pass over commit dcd3196 changed the gate to
// `{true ? ... }` — the section printed on every client report whether or not a
// CAM asked for it, including the ten clients whose Sim101 sits untouched at
// NinjaTrader's stock $100,000 — and then to `{false ? ... }`, which deletes
// the feature from the product while leaving every file in place. Both passed
// all 1782 tests.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_CONFIG, REPORT_FIELDS, SIMPLIFIED_REPORT_CONFIG, resolveReportConfig } from './reportConfig';

const APP = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');

describe('the report simulation section is opt-in, and reachable', () => {
  it('mounts only behind cfg.showSimulation', () => {
    const mounts = APP.match(/<SimulationReportSection\b/g) || [];
    expect(mounts).toHaveLength(1);

    // The one mount is the consequent of a cfg.showSimulation conditional.
    // `{true ? <SimulationReportSection .../> : null}` and
    // `{false ? ... }` both fail here.
    expect(APP).toMatch(
      /\{\s*cfg\.showSimulation\s*\?\s*\(\s*<SimulationReportSection\b/,
    );
  });

  it('is off unless a CAM or a client turns it on', () => {
    // Most clients carry an untouched Sim101 from the NinjaTrader install.
    // Printing a simulation block for them is noise on a client-facing report.
    expect(DEFAULT_REPORT_CONFIG.showSimulation).toBe(false);
    expect(SIMPLIFIED_REPORT_CONFIG.showSimulation).toBe(false);
    expect(resolveReportConfig(null, null).showSimulation).toBe(false);
  });

  it('can be turned on, per CAM and per client, through the report designer', () => {
    // A gate nobody can open is the same as no feature. The toggle has to be
    // offered in the designer and both scopes have to reach it.
    expect(REPORT_FIELDS.map((field) => field.key)).toContain('showSimulation');
    expect(resolveReportConfig({ showSimulation: true }, null).showSimulation).toBe(true);
    expect(resolveReportConfig(null, { showSimulation: true }).showSimulation).toBe(true);
    expect(resolveReportConfig({ showSimulation: true }, { showSimulation: false }).showSimulation).toBe(false);
  });
});
