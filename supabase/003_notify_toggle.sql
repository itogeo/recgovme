-- Add notify toggle column (default true = emails on)
alter table watches add column notify boolean not null default true;
