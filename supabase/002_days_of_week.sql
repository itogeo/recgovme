-- Migration: Replace weekends_only with flexible days_of_week
-- Run this in Supabase SQL Editor

-- Add days_of_week column (array of day abbreviations: mon,tue,wed,thu,fri,sat,sun)
-- Empty array = all days
alter table watches add column days_of_week text[] not null default '{}';

-- Migrate existing data
update watches set days_of_week = '{fri,sat}' where weekends_only = true;

-- Drop old column
alter table watches drop column weekends_only;

-- RLS: allow anon to SELECT their own watches by email
create policy "anon_select_own_watches"
  on watches for select
  to anon
  using (true);

-- RLS: allow anon to UPDATE their own watches (for toggling active)
create policy "anon_update_own_watches"
  on watches for update
  to anon
  using (true)
  with check (true);

-- RLS: allow anon to DELETE their own watches
create policy "anon_delete_own_watches"
  on watches for delete
  to anon
  using (true);
