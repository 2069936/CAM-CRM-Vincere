/* ---------------------------------------------------------------------------
 * What a capture may not carry once it leaves the machine that made it.
 *
 * Measured on a real machine's queue on 2026-09-28: one strategy row holds 149
 * entries in `extraValues`, among them a LicenseKey with a live value, URGO1
 * through URGO4, the stop and the three profit targets, the day filters, the
 * trade window times and EdgeLeverage. That is the desk's tuning and a working
 * licence. The report names the algorithm and says nothing about how it was set
 * up, so none of it is needed anywhere downstream of a capture.
 *
 * THE SAME RULE EXISTS TWICE, IN TWO LANGUAGES, ON PURPOSE. The C# copy is
 * collector/src/Vincere.AutoExport.Agent.UI/OfflineReportWriter.cs, and it runs
 * where the file is written to a client machine's Desktop. This one runs where
 * a capture is turned into a report on the desk's own server. Neither can call
 * the other and neither may be dropped: they guard two different files that
 * leave by two different doors.
 *
 * EMPTIED, NOT REMOVED, and that is not a detail. src/domain/autoExportContract
 * validates a snapshot before anything reads it and requires `parameters` to be
 * an object. The first version of the C# copy deleted the property, and every
 * capture with a strategy then rendered "strategies[0].parameters must be an
 * object" where the client's day should have been.
 *
 * STRATEGY ROWS ONLY. `accounts[].accountValues` is the other large map in a
 * capture and it stays: NetLiquidation, BuyingPower, the drawdown limits. That
 * is the client's own account, which is the subject of the report.
 * ------------------------------------------------------------------------- */

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * A copy of the capture with every strategy's configuration emptied.
 *
 * Returns a new object; the input is not touched, because a caller that goes on
 * to upload the same capture must upload what the machine actually reported.
 */
export function redactCapture(capture) {
  if (Array.isArray(capture)) return capture.map(redactCapture);
  if (!isPlainObject(capture)) return capture;

  /* A strategy row is the only thing in a capture carrying either of these.
   * Recognised by its own fields rather than by where it sits, so a capture
   * that grows a second place to put strategies is covered without this being
   * edited again. */
  const isStrategyRow = capture.parameterCaptureStatus !== undefined
    || capture.parameters !== undefined;

  const out = {};
  for (const [key, value] of Object.entries(capture)) {
    if (isStrategyRow && key === 'parametersRaw') continue;
    if (isStrategyRow && (key === 'parameters' || key === 'extraValues') && isPlainObject(value)) {
      out[key] = {};
      continue;
    }
    out[key] = redactCapture(value);
  }
  return out;
}

/** The field names this removes, for a message that has to say what it did. */
export const REDACTED_FIELDS = Object.freeze(['parameters', 'parametersRaw', 'extraValues']);
