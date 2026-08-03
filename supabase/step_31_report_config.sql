-- Step 31: configurable daily reports.
--
-- The base report layout is stored per CAM (so a CAM's reports look consistent),
-- and any client can override it to add or, more often, simplify. Both columns
-- are free-form JSON so new toggles can be added without another migration; the
-- app resolves defaults <- cam_profiles.report_config <- clients.report_config.

alter table public.cam_profiles
  add column if not exists report_config jsonb not null default '{}'::jsonb;

alter table public.clients
  add column if not exists report_config jsonb not null default '{}'::jsonb;
