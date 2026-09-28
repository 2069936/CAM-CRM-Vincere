/* The single entry the Edge Function imports.
 *
 * Nothing is defined here. It exists so the bundle has one door, and so the
 * list of what the function is allowed to reach is a file somebody can read
 * rather than a set of imports spread across a hand written index.ts.
 */
export { runDailyEmails, usersFromRows } from './dailyEmailJob';
export { sendViaBrevo, EmailDeliveryError } from './emailDelivery';
export { buildDailyEmailPackage } from './dailyEmailPackage';
export { planDailyEmails } from './dailyEmailPlan';
/* The agent relay's half. Same function the Vercel ingest route calls, so a
 * report mailed from a machine is byte for byte the report mailed from the
 * desk, whichever door it came through. */
export { AgentReportError, buildAgentReportMessage } from './agentReportMail.js';
