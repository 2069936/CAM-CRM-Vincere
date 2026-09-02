/**
 * POST /api/report/pdf — the report DOM up, the client's PDF back down.
 *
 * WHY THIS IS ITS OWN FUNCTION FILE AND NOT A KEY IN api/admin/[action].js.
 * The dispatcher exists because Vercel Hobby caps the project at 12 serverless
 * functions, and its comment reasons in FILE COUNT: client-export rides there
 * because a sixth file "costs" a slot. That reasoning does not transfer here,
 * because what this route drags in is not a file, it is ~76 MB of
 * @sparticuz/chromium and puppeteer-core. Vercel bundles per function, so
 * putting it behind the dispatcher would attach that 76 MB — and its cold-start
 * decompression — to client-export and to all seven ingest-* endpoints, which
 * are on the collector's hot path and have no use for a browser. api/ holds 5
 * files today; this is the 6th of 12, and it leaves six slots. The scarce
 * resource on this deployment is cold-start weight, not slots.
 *
 * WHAT AUTHORIZATION IS FOR HERE, since it is not the usual one. Every other
 * admin route is guarding ROWS: it takes a client id and has to prove the caller
 * is assigned to that client. This route takes no client id. It is handed markup
 * the caller's own browser already had on screen and hands the same markup back
 * as paper, so there is no row it could disclose that the caller did not already
 * hold. What the bearer check is actually for is that this endpoint drives a
 * BROWSER INSIDE THE DEPLOYMENT'S NETWORK, and an unauthenticated HTML-to-PDF
 * renderer is a server-side request forgery primitive pointed at the platform's
 * own metadata service. So: an Active app user, and the render document's CSP
 * (`default-src 'none'`, see server/report/reportPdf.js) closes the hole a second
 * time for anyone who gets past the first.
 *
 * TIMING. A cold start pays for brotli-decompressing chromium and launching it;
 * warm, the render measured 821-1,534 ms per report with a real Chrome. Hobby's
 * default function timeout is 10s, which is not comfortable headroom over a cold
 * start plus a render, so vercel.json raises maxDuration for this route alone.
 */

import process from 'node:process';
import { createApiClients, requireAppUser } from '../../server/apiLib/apiAuth.js';
import { ApiError, handleApiError, readJsonBody, requireMethod } from '../../server/apiLib/http.js';
import {
  MAX_REPORT_HTML_BYTES,
  REPORT_VIEWPORT,
  renderReportPdf,
} from '../../server/report/reportPdf.js';

/**
 * The origin the render document loads the build's stylesheet and fonts from.
 *
 * VERCEL_URL FIRST, and deliberately not the production alias: it names THIS
 * deployment, so the content-hashed /assets/index-<hash>.css it advertises is
 * the one that matches the code now running. A preview deployment pointed at the
 * production alias would ask for a hash that does not exist there and fail —
 * loudly, but for no good reason.
 *
 * THE HOST HEADER IS NEVER TRUSTED ON VERCEL. It is caller-controlled, and
 * trusting it would mean a request carrying `Host: evil.example` makes the
 * function fetch a stylesheet from evil.example and load it into a browser
 * rendering the CAM's report. It is used only when nothing else is set, which is
 * the local `vercel dev` case.
 *
 * ON PRODUCTION THE ALIAS WINS, and this is the fix for a live outage. The
 * reasoning above holds for previews and only for previews. On a production
 * deployment VERCEL_URL still names the deployment host, and that host is what
 * Deployment Protection guards: the function's fetch of its own index.html came
 * back as an SSO login page, resolveReportStylesheets found no stylesheet in it,
 * and every Download PDF returned 502 while Print, which renders in the CAM's
 * own browser, kept working. REPORT_PDF_BASE_URL was the documented way out, but
 * it is a variable someone has to know to set, on a deployment nobody had a
 * reason to think was misconfigured.
 *
 * VERCEL_PROJECT_PRODUCTION_URL is set by Vercel itself and names the production
 * alias, which serves the same build and is not behind the protection. Taking it
 * only when VERCEL_ENV is `production` leaves the preview path untouched: a
 * preview still asks its own deployment for its own asset hashes.
 *
 * WHAT THIS COSTS. During the seconds of a deploy rollover the alias may still
 * serve the previous build, so a report rendered in that window picks up the
 * previous stylesheet. It cannot pick up a hash that does not resolve, because
 * the hash is read out of the same index.html it just fetched, so the pairing is
 * always self-consistent. A few seconds of last-build styling beats a 502 that
 * never clears on its own.
 *
 * REPORT_PDF_BASE_URL still overrides everything, for any deployment shape
 * neither branch fits.
 */
export function resolveReportBaseUrl(env = process.env, req = null) {
  if (env.REPORT_PDF_BASE_URL) return String(env.REPORT_PDF_BASE_URL).trim();
  if (env.VERCEL_ENV === 'production' && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${String(env.VERCEL_PROJECT_PRODUCTION_URL).trim()}`;
  }
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  if (env.VERCEL) {
    throw new ApiError(500, 'report_base_url_unset: set REPORT_PDF_BASE_URL for this deployment');
  }
  const host = req?.headers?.host;
  if (!host) throw new ApiError(500, 'report_base_url_unset');
  const protocol = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) ? 'http' : 'https';
  return `${protocol}://${host}`;
}

/**
 * Chromium, imported only when a report is actually being rendered.
 *
 * A static import would pull 76 MB into module evaluation on every cold start of
 * this function, including the ones that are about to 401. It is also what keeps
 * the unit tests and scripts/verify-report-print-layout.mjs free of the
 * dependency: both inject their own launcher and this function is never reached.
 */
export async function launchServerlessChromium() {
  const [chromiumModule, puppeteerModule] = await Promise.all([
    import('@sparticuz/chromium'),
    import('puppeteer-core'),
  ]);
  const chromium = chromiumModule.default || chromiumModule;
  const puppeteer = puppeteerModule.default || puppeteerModule;
  return puppeteer.launch({
    args: chromium.args,
    // Pinned in reportPdf.js so production and the verification lay the report
    // out in the same box.
    defaultViewport: { ...REPORT_VIEWPORT },
    executablePath: await chromium.executablePath(),
    headless: true,
  });
}

export function createHandler({
  createClients = createApiClients,
  authorize = requireAppUser,
  render = renderReportPdf,
  launchBrowser = launchServerlessChromium,
  resolveBaseUrl = resolveReportBaseUrl,
  fetchImpl = globalThis.fetch,
  env = process.env,
} = {}) {
  return async function handler(req, res) {
    try {
      requireMethod(req, ['POST']);
      res.setHeader('Cache-Control', 'private, no-store');
      const { admin, auth } = createClients();
      await authorize(req, { admin, authClient: auth, roles: ['Manager', 'CAM'] });

      // The envelope carries the DOM plus a little slack for the title and JSON
      // framing; the DOM itself is bounded again inside renderReportPdf.
      const body = await readJsonBody(req, { maxBytes: MAX_REPORT_HTML_BYTES + 8 * 1024 });
      const title = String(body?.title || '').trim();
      if (!title) throw new ApiError(400, 'report_title_required');

      const { bytes, contentDisposition } = await render({
        html: body?.html,
        title,
        baseUrl: resolveBaseUrl(env, req),
        launchBrowser,
        fetchImpl,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', contentDisposition);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', String(bytes.length));
      return res.status(200).send(bytes);
    } catch (error) {
      return handleApiError(res, error, { fallbackMessage: 'report_pdf_failed' });
    }
  };
}

export default createHandler();
