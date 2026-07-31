-- Step 32: manual client ordering in the sidebar.
--
-- The CAM can drag their clients into whatever order they want. The order is a
-- list of client ids (legacy_key or uuid, matching the app-level client id)
-- stored per CAM. When empty, the sidebar falls back to its pinned + urgency
-- sort. Free-form JSON so it needs no follow-up migration.

alter table public.cam_profiles
  add column if not exists client_order jsonb not null default '[]'::jsonb;
