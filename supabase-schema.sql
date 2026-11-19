-- Supabase SQL Editor에 그대로 붙여넣고 Run 하세요.
create table if not exists public.trip_dashboards (
  sync_id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.trip_dashboards enable row level security;

-- 공유 코드(sync_id)를 아는 기기끼리 읽기/쓰기 동기화 허용
drop policy if exists "Allow public read by sync_id" on public.trip_dashboards;
create policy "Allow public read by sync_id"
  on public.trip_dashboards for select
  using (true);

drop policy if exists "Allow public upsert by sync_id" on public.trip_dashboards;
create policy "Allow public upsert by sync_id"
  on public.trip_dashboards for insert
  with check (true);

drop policy if exists "Allow public update by sync_id" on public.trip_dashboards;
create policy "Allow public update by sync_id"
  on public.trip_dashboards for update
  using (true);

-- Realtime 자동 동기화 활성화
alter publication supabase_realtime add table public.trip_dashboards;
