-- BUG FIX: keyvalue_store stores each collection (transactions.json,
-- users.json, etc.) as ONE JSON blob per row, and the old writeDB()
-- always did an unconditional full upsert -- there was no protection
-- against two concurrent requests both reading the same blob, mutating
-- their own in-memory copy, and whichever writes back LAST silently
-- discarding the other's change entirely (not merging -- overwriting).
--
-- Concretely: if the GensPay webhook reads transactions.json, finds
-- order X, marks it 'done' + credits balance, and writes the updated
-- array back -- but at the same moment a DIFFERENT customer's checkout
-- (or the /cron/reconcile-genspay sweep, or an admin action) also reads
-- transactions.json (before the webhook's write lands), mutates ITS OWN
-- copy, and writes AFTER the webhook does -- that second write reverts
-- order X back to whatever state it was in before the webhook ever ran,
-- with zero errors anywhere. This looks exactly like "sudah dibayar
-- tapi kadang ga kekonfirm" -- intermittent, not reproducible on
-- demand, worse under real concurrent traffic.
--
-- Fix: add a version counter. server.js's updateCollectionAtomic()
-- (supabase.js) now reads {value, version}, and only writes if the
-- version is UNCHANGED since it was read (UPDATE ... WHERE version =
-- $expected) -- if another writer got there first, it re-reads the
-- now-current data and retries its mutation against that, instead of
-- blindly overwriting.
--
-- Run this in Supabase SQL Editor.
alter table keyvalue_store
  add column if not exists version bigint not null default 0;

-- Keep version monotonically increasing on every update as a backstop,
-- even for any write path that doesn't go through writeDBIfVersion
-- (e.g. a manual edit in the Supabase table editor, or the older
-- unconditional writeDB() still used by lower-risk collections) -- so
-- version never accidentally goes backwards or gets left stale.
create or replace function _bump_version()
returns trigger language plpgsql as $$
begin
  if new.version = old.version then
    new.version = old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_version on keyvalue_store;
create trigger trg_bump_version
  before update on keyvalue_store
  for each row execute function _bump_version();

select key, version, updated_at from keyvalue_store order by key;
