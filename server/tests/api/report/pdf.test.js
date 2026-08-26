// The endpoint around the renderer: who may call it, what it answers with, and
// where it is allowed to believe the deployment lives.

import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { createHandler, resolveReportBaseUrl } from '../../../../api/report/pdf.js';
import { ApiError } from '../../../apiLib/http.js';

const PDF = Buffer.from('%PDF-1.4\npretend paper');
const TITLE = 'Wren Larch - 2026-08-24 daily report';

function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

function setup({ authorize, render, env } = {}) {
  const rendered = vi.fn(async ({ title }) => ({
    bytes: PDF,
    fileName: `${title}.pdf`,
    contentDisposition: `attachment; filename="${title}.pdf"`,
  }));
  const handler = createHandler({
    createClients: () => ({ admin: {}, auth: {} }),
    authorize: authorize || vi.fn(async () => ({ id: 'u1', role: 'CAM', status: 'Active' })),
    render: render || rendered,
    launchBrowser: vi.fn(),
    fetchImpl: vi.fn(),
    env: env || { REPORT_PDF_BASE_URL: 'https://cam.example.test' },
  });
  return { handler, rendered };
}

const request = (overrides = {}) => ({
  method: 'POST',
  headers: { host: 'cam.example.test' },
  body: { html: '<div class="report-sheet">x</div>', title: TITLE },
  ...overrides,
});

describe('POST /api/report/pdf', () => {
  it('answers with the PDF itself, not a link or a base64 envelope', async () => {
    const { handler } = setup();
    const res = response();
    await handler(request(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PDF);
    expect(res.headers['Content-Type']).toBe('application/pdf');
    expect(res.headers['Content-Length']).toBe(String(PDF.length));
  });

  it('tells the browser to save it under the name the desk files by', async () => {
    // The other half of the CAM's complaint. Today the file is named from
    // document.title and lands wherever the dialog last pointed; this puts the
    // exact name on the response and the file in the downloads folder.
    const { handler } = setup();
    const res = response();
    await handler(request(), res);
    expect(res.headers['Content-Disposition']).toBe(`attachment; filename="${TITLE}.pdf"`);
    // A PDF the browser is told to save must not also be sniffable as something
    // else it might decide to run.
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('never caches a client\'s report', async () => {
    const { handler } = setup();
    const res = response();
    await handler(request(), res);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
  });

  it('only answers POST', async () => {
    const { handler } = setup();
    const res = response();
    await handler(request({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('requires an active app user', async () => {
    // Not because the markup is secret — the caller's own browser just had it on
    // screen — but because this endpoint drives a BROWSER INSIDE THE
    // DEPLOYMENT'S NETWORK, and an open HTML-to-PDF renderer is a server-side
    // request forgery primitive pointed at the platform's metadata service.
    const authorize = vi.fn(async () => { throw new ApiError(401, 'Missing bearer token.'); });
    const { handler } = setup({ authorize });
    const res = response();
    await handler(request(), res);
    expect(res.statusCode).toBe(401);
    expect(res.headers['Content-Type']).toBeUndefined();
  });

  it('lets a CAM and a Manager through and nobody else', async () => {
    const authorize = vi.fn(async () => ({ id: 'u1', role: 'CAM' }));
    const { handler } = setup({ authorize });
    await handler(request(), response());
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ roles: ['Manager', 'CAM'] }));
  });

  it('refuses a request with no title, because the title IS the file name', async () => {
    const { handler } = setup();
    const res = response();
    await handler(request({ body: { html: '<div>x</div>', title: '   ' } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/report_title_required/);
  });

  it('passes the caller\'s markup and title straight to the renderer', async () => {
    const { handler, rendered } = setup();
    await handler(request(), response());
    expect(rendered).toHaveBeenCalledWith(expect.objectContaining({
      html: '<div class="report-sheet">x</div>',
      title: TITLE,
      baseUrl: 'https://cam.example.test',
    }));
  });

  it('surfaces a missing-font failure as a failure and not as paper', async () => {
    // The measured hazard: with the fonts absent a real report goes from one
    // sheet to two. A 200 here would ship that to a client.
    const render = vi.fn(async () => { throw new ApiError(502, 'report_font_missing: Inter Variable, Outfit Variable'); });
    const { handler } = setup({ render });
    const res = response();
    await handler(request(), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toMatch(/report_font_missing/);
    expect(res.headers['Content-Type']).toBeUndefined();
  });
});

describe('where the function believes the deployment lives', () => {
  it('uses this deployment\'s own url, so the asset hashes match the code', () => {
    // Not the production alias: a preview deployment asking production for
    // /assets/index-<hash>.css asks for a hash that is not there.
    expect(resolveReportBaseUrl({ VERCEL: '1', VERCEL_URL: 'abc-123.vercel.app' }))
      .toBe('https://abc-123.vercel.app');
  });

  it('never trusts the Host header on Vercel', () => {
    // THE HOLE THIS CLOSES. Host is caller-controlled. Trusting it would let a
    // request carrying `Host: evil.example` make the function fetch a stylesheet
    // from evil.example and load it into a browser rendering the CAM's report.
    expect(() => resolveReportBaseUrl({ VERCEL: '1' }, { headers: { host: 'evil.example' } }))
      .toThrow(/report_base_url_unset/);
  });

  it('lets an explicit override win, for a deployment behind Vercel Authentication', () => {
    // With Deployment Protection on, VERCEL_URL needs an SSO round trip and
    // index.html comes back as a login page.
    expect(resolveReportBaseUrl({
      VERCEL: '1',
      VERCEL_URL: 'abc-123.vercel.app',
      REPORT_PDF_BASE_URL: 'https://crm.vincere.test',
    })).toBe('https://crm.vincere.test');
  });

  it('falls back to the request host only off Vercel, which is `vercel dev`', () => {
    expect(resolveReportBaseUrl({}, { headers: { host: 'localhost:3000' } })).toBe('http://localhost:3000');
    expect(resolveReportBaseUrl({}, { headers: { host: '127.0.0.1:3000' } })).toBe('http://127.0.0.1:3000');
    expect(resolveReportBaseUrl({}, { headers: { host: 'staging.internal' } })).toBe('https://staging.internal');
    expect(() => resolveReportBaseUrl({}, { headers: {} })).toThrow(/report_base_url_unset/);
  });
});
