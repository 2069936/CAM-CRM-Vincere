-- Step 25: manual strategy classifications.
--
-- The team-maintained reference of strategy versions, keyed by parameter
-- signature. Two accounts running the same family + version export the same
-- `parameters`, so a (family + signature) pair identifies a version. A row maps
-- that pair to the version label the team selects, plus a manual risk level.
-- Global/shared (these are the algorithm definitions), not per-client.

create table if not exists public.strategy_classifications (
  id uuid primary key default gen_random_uuid(),
  match_key text unique not null,   -- family|signatureKey (matches the domain key)
  family text not null,
  signature jsonb,                  -- direction/posSizes/profitTargets/stopLoss/tradeWindow
  version text,                     -- the version the team assigns
  risk_level text,                  -- manual per-version risk
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists strategy_classifications_family_idx
  on public.strategy_classifications (family);
