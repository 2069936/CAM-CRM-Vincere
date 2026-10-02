#!/usr/bin/env bash
#
# Proves that claim_deep_export_request and finalize_deep_export_request take
# their locks in the same order, by racing them.
#
# WHY A SHELL SCRIPT AND NOT A VITEST FILE. The behavioural assertions for step
# 54 run inside the suite against PGlite, which is PostgreSQL compiled to
# WebAssembly and has exactly one connection. One connection cannot deadlock, so
# the one property that needed two processes could not live there. This needs a
# real cluster and is run by hand.
#
# THE RACE. A request that was offered to a machine, whose 72 hour TTL has just
# run out while its lease is still live - which is every export that spans the
# TTL instant. Two sessions are released from one wall-clock barrier: the
# machine's next heartbeat, and the machine's ack of the upload it has just
# finished. Before the fix the heartbeat's expiry sweep sat above the advisory
# lock, so it took a tuple lock on the request row and then waited for the
# advisory lock the ack already held, while the ack waited for the row. Measured
# on PostgreSQL 18.3: 33 of 40 rounds aborted with 40P01, and 15 of them ended
# with a finished, uploaded export not recorded as uploaded.
#
# WHAT A PASS LOOKS LIKE. Zero deadlocks, and every round ending `uploaded`:
# the ack wins the row because the heartbeat no longer touches it before taking
# the same lock, and the beat that follows reads a request that is already
# terminal and answers 'none'.
#
# USAGE
#   PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... ./scripts/race-deep-export-lock-order.sh [rounds]
#
# Against a THROWAWAY cluster only. It deletes from ingest_deep_export_requests
# on every round, and it expects step_54 applied plus one active ingest_device
# whose client exists. Never point it at production.

set -u
ROUNDS="${1:-40}"
DEVICE="${DEEP_EXPORT_DEVICE:-}"
if [ -z "$DEVICE" ]; then
  DEVICE=$(psql -Atc "select id from public.ingest_devices where status = 'active' and revoked_at is null order by id limit 1;")
fi
if [ -z "$DEVICE" ]; then
  echo "no active ingest_device to race against; seed one first" >&2
  exit 2
fi
CLIENT=$(psql -Atc "select client_id from public.ingest_devices where id = '$DEVICE';")
EMAIL=$(psql -Atc "select coalesce(min(email), 'manager@desk') from public.app_users;")
REQUEST="cccccccc-0000-0000-0000-00000000dead"
TOKEN="bbbb0002-0000-0000-0000-000000000002"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

deadlocks=0
lost=0
echo "racing the beat against the ack, $ROUNDS rounds, device $DEVICE"
for round in $(seq 1 "$ROUNDS"); do
  psql -q -c "delete from public.ingest_deep_export_requests where device_id = '$DEVICE';"
  psql -q -c "insert into public.ingest_deep_export_requests
      (id, device_id, client_id, created_by_email, reason, run_mode, status,
       created_at, expires_at, offered_at, offer_count,
       lease_token, lease_expires_at, storage_path)
    values ('$REQUEST', '$DEVICE', '$CLIENT', '$EMAIL',
            'the lock order, raced', 'now', 'offered',
            clock_timestamp() - interval '72 hours',
            clock_timestamp() - interval '1 second',
            clock_timestamp() - interval '20 minutes', 1,
            '$TOKEN', clock_timestamp() + interval '70 minutes',
            '$CLIENT/$REQUEST.zip');"

  # One barrier, so neither session is merely slower than the other.
  target=$(psql -Atc "select (clock_timestamp() + interval '900 milliseconds')::text;")
  wait_for="select pg_sleep(greatest(0, extract(epoch from (timestamptz '$target' - clock_timestamp()))));"

  psql -Atc "begin isolation level read committed; $wait_for
    select public.claim_deep_export_request('$DEVICE'::uuid,
      'aaaa9999-0000-0000-0000-000000000009'::uuid, 5400, clock_timestamp()); commit;" \
    > "$WORK/beat" 2>&1 &
  psql -Atc "begin isolation level read committed; $wait_for
    select public.finalize_deep_export_request('$DEVICE'::uuid, '$REQUEST'::uuid,
      '$TOKEN'::uuid, 'uploaded', repeat('0', 64), 7200000, 20000, 0, null,
      clock_timestamp()); commit;" \
    > "$WORK/ack" 2>&1 &
  wait

  beat=$(grep -oE 'deadlock detected|"outcome": "[a-z]+"|deep_export_[a-z_]+' "$WORK/beat" | head -1)
  ack=$(grep -oE 'deadlock detected|"outcome": "[a-z]+"|deep_export_[a-z_]+' "$WORK/ack" | head -1)
  status=$(psql -Atc "select status from public.ingest_deep_export_requests where id = '$REQUEST';")
  case "$beat$ack" in *"deadlock detected"*) deadlocks=$((deadlocks + 1));; esac
  [ "$status" = "uploaded" ] || lost=$((lost + 1))
  printf "  round %-4s beat=%-24s ack=%-24s row=%s\n" "$round" "$beat" "$ack" "$status"
done

echo "  ----"
echo "  deadlocks:           $deadlocks / $ROUNDS"
echo "  exports not recorded: $lost / $ROUNDS"
if [ "$deadlocks" -ne 0 ] || [ "$lost" -ne 0 ]; then
  echo "FAIL: the lock order regressed" >&2
  exit 1
fi
echo "PASS: no deadlock, and every finished export was recorded"
