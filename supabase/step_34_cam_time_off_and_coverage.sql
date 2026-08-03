-- Step 34: CAM time off, temporary client coverage, and CAM record fields.
--
-- When a CAM is away their clients still need watching. A CAM requests time off,
-- a manager approves it and hands those clients to other CAMs for exactly that
-- window. Coverage ADDS access and never removes it: the CAM who is away keeps
-- their own book, and the covering CAM sees the borrowed clients marked as such.
-- Both ends of a window are inclusive, and coverage expires on its own date, so
-- nobody has to remember to undo it.

create table if not exists public.cam_time_off (
  id uuid primary key default gen_random_uuid(),
  cam_profile_id uuid not null references public.cam_profiles(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  kind text not null default 'Vacation',
  note text default '',
  status text not null default 'Pending',
  requested_at timestamptz default now(),
  decided_at timestamptz,
  decided_by uuid references public.cam_profiles(id) on delete set null,
  decision_note text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint cam_time_off_range check (end_date >= start_date)
);

create index if not exists cam_time_off_cam_idx on public.cam_time_off(cam_profile_id);
create index if not exists cam_time_off_window_idx on public.cam_time_off(start_date, end_date);
create index if not exists cam_time_off_status_idx on public.cam_time_off(status);

create table if not exists public.client_coverage (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  covering_cam_profile_id uuid not null references public.cam_profiles(id) on delete cascade,
  absent_cam_profile_id uuid references public.cam_profiles(id) on delete set null,
  -- Null when a manager arranges cover without a formal request behind it.
  time_off_id uuid references public.cam_time_off(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  note text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint client_coverage_range check (end_date >= start_date),
  -- One cover per client per window per CAM; re-assigning the same span updates.
  unique (client_id, covering_cam_profile_id, start_date, end_date)
);

create index if not exists client_coverage_covering_idx on public.client_coverage(covering_cam_profile_id);
create index if not exists client_coverage_client_idx on public.client_coverage(client_id);
create index if not exists client_coverage_window_idx on public.client_coverage(start_date, end_date);

-- Standing facts about a CAM, for the record shown next to their book.
alter table public.cam_profiles add column if not exists start_date date;
alter table public.cam_profiles add column if not exists email text;
alter table public.cam_profiles add column if not exists phone text;
alter table public.cam_profiles add column if not exists timezone text;
alter table public.cam_profiles add column if not exists notes text;
