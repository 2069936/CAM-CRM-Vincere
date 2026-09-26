#!/usr/bin/env python3
"""Rebuilds public/local-snapshot.json so the CRM runs with no database.

    python3 scripts/rebuild_local_snapshot.py <carpeta-con-capturas> [mas carpetas...]

Takes the newest CRM data export as the roster and folds in every agent capture
JSON it can find, matching accounts by name. Safe to re-run: a capture that is
already in the snapshot is skipped rather than duplicated.
"""
import json, pathlib, sys, uuid

REPO = pathlib.Path(__file__).resolve().parent.parent
OUT = REPO / 'public' / 'local-snapshot.json'


def det_id(*parts):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'vincere-local/' + '/'.join(map(str, parts))))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def newest_export(folders):
    best = None
    for folder in folders:
        for f in pathlib.Path(folder).rglob('cam-crm-export-*.json'):
            if best is None or f.stat().st_mtime > best.stat().st_mtime:
                best = f
    return best


def main(argv):
    folders = [pathlib.Path(a).expanduser() for a in argv] or [pathlib.Path.home() / 'Downloads']

    if OUT.exists():
        base = json.loads(OUT.read_text())
    else:
        exp = newest_export(folders)
        if not exp:
            print('No CRM export found and no snapshot to extend.', file=sys.stderr)
            return 1
        base = json.loads(exp.read_text())
        print(f'base: {exp.name}')

    T = dict(base.get('tables', base))
    accounts = {}
    for a in T.get('trading_accounts') or []:
        n = a.get('account_name')
        if n and str(n) not in accounts:
            accounts[str(n)] = a

    daily = list(T.get('daily_imports') or [])
    snaps = list(T.get('account_snapshots') or [])
    day_key = {(d.get('client_id'), d.get('trading_date')): d.get('id') for d in daily}
    seen = {(s.get('daily_import_id'), s.get('trading_account_id')) for s in snaps}

    added_days = added_snaps = unmatched = cross_client = 0
    files = [f for folder in folders for f in folder.rglob('*.json')
             if 'myfuturesbook' not in str(f) and 'local-snapshot' not in f.name]

    for f in sorted(files):
        try:
            cap = json.loads(f.read_text())
        except Exception:
            continue
        if not isinstance(cap, dict) or 'accounts' not in cap or not cap.get('tradingDate'):
            continue
        date = cap['tradingDate']

        owners = {}
        for a in cap.get('accounts') or []:
            acct = accounts.get(str(a.get('accountName') or a.get('displayName') or ''))
            if acct:
                owners[acct.get('client_id')] = owners.get(acct.get('client_id'), 0) + 1
            else:
                unmatched += 1
        if not owners:
            continue
        client_id = max(owners, key=owners.get)

        key = (client_id, date)
        di_id = day_key.get(key)
        if di_id is None:
            di_id = det_id('day', client_id, date)
            daily.append({
                'id': di_id, 'client_id': client_id, 'trading_date': date,
                'status': 'closed', 'source_type': 'auto',
                'imported_at': cap.get('capturedAt'), 'created_at': cap.get('capturedAt'),
                'updated_at': cap.get('capturedAt'), 'imported_by_user_id': None,
                'legacy_key': None, 'raw_file_batch_id': None,
                'source_batch_id': cap.get('captureId'),
                'source_summary': f'local rebuild from {f.name}',
            })
            day_key[key] = di_id
            added_days += 1

        for a in cap.get('accounts') or []:
            acct = accounts.get(str(a.get('accountName') or a.get('displayName') or ''))
            if not acct or (di_id, acct['id']) in seen:
                continue
            # THE ACCOUNT MUST BELONG TO THE CLIENT WHOSE DAY THIS IS.
            #
            # Matching on the account name alone is not safe: NinjaTrader ships a
            # default simulation account called Sim101 and it exists on every
            # machine. The roster has exactly one Sim101 row, owned by one client,
            # so a name match attaches that client's account to all ten clients'
            # days. Measured before this check: 37 stray snapshots across 10
            # clients. Every other account name in the sample appears on exactly
            # one machine, which is the shape this desk actually runs.
            if acct.get('client_id') != client_id:
                cross_client += 1
                continue
            seen.add((di_id, acct['id']))
            balance = num(a.get('netLiquidation'))
            snaps.append({
                'id': det_id('snap', di_id, acct['id']),
                'daily_import_id': di_id, 'trading_account_id': acct['id'],
                'account_name': acct.get('account_name'),
                'account_balance': balance if balance is not None else num(a.get('cashValue')),
                'gross_realized_pnl': num(a.get('grossRealizedPnl')),
                'unrealized_pnl': num(a.get('unrealizedPnl')),
                'weekly_pnl': num(a.get('weeklyPnl')),
                'trailing_max_drawdown': num(a.get('trailingMaxDrawdown')),
                'connection': a.get('connectionName'),
                'derivation': 'local-rebuild', 'created_at': cap.get('capturedAt'),
            })
            added_snaps += 1

    T['daily_imports'] = daily
    T['account_snapshots'] = snaps
    out = {**{k: v for k, v in base.items() if k != 'tables'}, 'tables': T}
    out['source'] = 'local rebuild, read only, not production'
    OUT.write_text(json.dumps(out))

    days = sorted({d.get('trading_date') for d in daily if d.get('trading_date')})
    print(f'dias nuevos {added_days}, snapshots nuevos {added_snaps}, cuentas sin match {unmatched}, de otro cliente {cross_client}')
    print(f'cobertura: {len(days)} dias, {days[0]} a {days[-1]}' if days else 'sin dias')
    print(f'ultimo dia: {days[-1] if days else "—"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
