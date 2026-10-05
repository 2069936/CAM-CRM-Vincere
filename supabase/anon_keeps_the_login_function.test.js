// The one grant `anon` must never lose, guarded across every migration rather
// than inside the one that happens to be newest.
//
// WHY THIS FILE IS NOT PART OF step_56's TEST. A test that lives in step 56
// protects step 56. The migration that deletes this grant will be step 57, or
// 59, and it will be written by somebody doing exactly what step 51 did:
// enumerating what `anon` holds and removing whatever no route obviously needs.
// Grep for `login_email_for_username` returns two hits - one migration and one
// line of src/domain/supabaseAuth.js - so it looks like dead weight from every
// angle except this one.
//
// WHAT IT COSTS TO GET WRONG. `anon` is the key in the browser bundle, and
// username sign-in happens before any session exists. Revoke this and every CAM
// who types a username is locked out of the CRM, which is a worse outcome than
// the privilege hole step 56 was written to close.
//
// AND IT DOES NOT DEGRADE. A permission denial is code 42501, status 403,
// message "permission denied for function login_email_for_username".
// isMissingFunction (src/domain/supabaseAuth.js:61-67) matches only PGRST202,
// status 404, and /could not find the function|does not exist/. It matches none
// of the three, so resolveLoginEmail RETHROWS at :49 and the fallback at :51 is
// never reached. There is no safety net under this one.

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const stepFiles = readdirSync(dir)
  .filter((name) => /^step_\d+_.*\.sql$/.test(name))
  .sort((a, b) => Number(/^step_(\d+)/.exec(a)[1]) - Number(/^step_(\d+)/.exec(b)[1]));

/** Statements only. A promise in a comment is not a grant. */
const executable = (name) => readFileSync(new URL(name, dir), 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const everyStep = stepFiles.map(executable).join('\n');
const flatAll = everyStep.toLowerCase().replace(/\s+/g, ' ');

describe('anon keeps the username sign-in function, in every migration there is', () => {
  it('there are migrations to check at all', () => {
    // Guards the whole file against a glob that silently matches nothing - which
    // is how a suite like this passes while checking zero bytes.
    expect(stepFiles.length).toBeGreaterThan(30);
    expect(everyStep).toContain('login_email_for_username');
  });

  it('is granted to anon somewhere', () => {
    expect(flatAll).toMatch(
      /grant execute on function public\.login_email_for_username\(text\) to[^;]*\banon\b/,
    );
  });

  it('is revoked from anon or PUBLIC nowhere', () => {
    const offenders = [];
    for (const name of stepFiles) {
      const flat = executable(name).toLowerCase().replace(/\s+/g, ' ');
      for (const stmt of flat.match(/\brevoke\b[^;]*;/g) || []) {
        if (!stmt.includes('login_email_for_username')) continue;
        // step 43 writes `revoke all ... from public` and grants to anon on the
        // very next line. That is the intended shape: it strips the PUBLIC
        // pseudo-role's implicit EXECUTE and then names anon explicitly.
        if (/from public;?$/.test(stmt.trim()) && flat.includes('to anon')) continue;
        offenders.push(`${name}: ${stmt.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is not taken by a blanket function revoke, which is the way it would actually happen', () => {
    /* `revoke all on all functions in schema public from anon` is the tempting
     * one-liner. It matches the philosophy of a lockdown migration and it takes
     * the sign-in with it. */
    const offenders = [];
    for (const name of stepFiles) {
      const flat = executable(name).toLowerCase().replace(/\s+/g, ' ');
      for (const stmt of flat.match(/\brevoke\b[^;]*;/g) || []) {
        if (!/on all (functions|routines)/.test(stmt)) continue;
        if (!/\b(anon|public)\b/.test(stmt)) continue;
        // Permitted only if the same file grants the two anon doors back.
        const regrants = flat.includes('login_email_for_username(text) to anon')
          || flat.includes('login_email_for_username(text) to anon, authenticated');
        if (!regrants) offenders.push(`${name}: ${stmt.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('and the function is never dropped', () => {
    expect(flatAll).not.toMatch(/drop function[^;]*login_email_for_username/);
  });
});

describe('every function revoke names anon explicitly, because `from public` does not reach it', () => {
  it('no migration repeats the mistake steps 52 and 53 made', () => {
    /* `revoke all on function f from public` removes the PUBLIC pseudo-role's
     * implicit EXECUTE. It does NOT remove a DIRECT grant to anon - and a direct
     * grant to anon is what `alter default privileges ... on functions` hands
     * out at creation time, which is the same mechanism as the table defect step
     * 56 closes.
     *
     * 32 revoke statements across 8 files in this directory write `from public,
     * anon, authenticated`. Steps 52 and 53 were the only two that wrote `from
     * public` alone, and step 56 closes them by name. Nothing new may reproduce
     * the pattern. */
    const offenders = [];
    for (const name of stepFiles) {
      const flat = executable(name).replace(/\s+/g, ' ').toLowerCase();
      for (const stmt of flat.match(/\brevoke all on (?:function|procedure) [^;]*;/g) || []) {
        // Granted straight back to anon on the next line, deliberately.
        if (stmt.includes('login_email_for_username')) continue;
        if (stmt.includes('current_app_user')) continue;
        if (!/\banon\b/.test(stmt)) offenders.push(`${name}: ${stmt.trim()}`);
      }
    }
    expect(offenders).toEqual([
      // The two historical exceptions, named rather than tolerated silently.
      // Step 56 revokes all four of these functions from anon separately; these
      // statements stay as they were written so the files are not rewritten
      // retroactively. A THIRD entry appearing here is a new mistake.
      'step_52_rls_by_cam.sql: revoke all on function public.is_manager() from public;',
      'step_52_rls_by_cam.sql: revoke all on function public.assigned_client_ids() from public;',
      'step_53_client_creation_under_rls.sql: revoke all on function public.client_is_assigned(uuid) from public;',
      'step_53_client_creation_under_rls.sql: revoke all on function public.clients_i_created() from public;',
    ]);
  });

  it('and step 56 closes all four of them', () => {
    const step56 = executable('step_56_table_privilege_lockdown.sql').toLowerCase().replace(/\s+/g, ' ');
    for (const fn of [
      'public.is_manager()', 'public.assigned_client_ids()',
      'public.client_is_assigned(uuid)', 'public.clients_i_created()',
    ]) {
      expect(step56).toContain(`revoke all on function ${fn} from anon`);
    }
  });
});

describe('no migration grants a table privilege to anon', () => {
  it('because anon is the key that ships in the browser bundle', () => {
    /* Not one permissive policy in this schema names anon, so a table grant to
     * anon is dead today - and a dead grant is one a policy added later turns
     * live by accident. That is the hazard step 51 warned about and step 56
     * closed. */
    const offenders = [];
    for (const name of stepFiles) {
      const flat = executable(name).replace(/\s+/g, ' ').toLowerCase();
      for (const stmt of flat.match(/\bgrant\b[^;]*;/g) || []) {
        if (/on (function|procedure|routine|schema|sequence)/.test(stmt)) continue;
        if (/execute/.test(stmt)) continue;
        if (/\banon\b/.test(stmt)) offenders.push(`${name}: ${stmt.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
