-- The parts of ink-indexer's schema that MAKO reads, copied at tag events-v3
-- (packages/db/migrations/0001_init.sql, 0002_events_bot_indexes.sql, 0003_events_sub.sql,
-- 0006_opensea_budget.sql and 0012_opensea_spacing.sql). Update with the tag.
create schema indexer;

create table indexer.events (
  id bigserial primary key,
  type text not null,
  entity text not null,
  payload jsonb not null,
  block bigint not null,
  block_hash text not null,
  tx_hash text not null,
  log_index int not null,
  sub text not null default '',
  confirmed boolean not null,
  created_at timestamptz not null default now(),
  unique (tx_hash, log_index, sub)
);
create index events_entity_id on indexer.events (entity, id);
create index events_block on indexer.events (block);
create index events_unconfirmed on indexer.events (id) where not confirmed;
create index events_launch_creator on indexer.events ((payload->>'creator'), id)
  where type = 'launchpad.launch';
create index events_type_id on indexer.events (type, id);
create index events_type_entity_id on indexer.events (type, entity, id);

create table indexer.cursors (
  source text primary key,
  block bigint not null,
  block_hash text not null
);

-- Stubs of 0006_opensea_budget.sql as changed by 0012_opensea_spacing.sql. MAKO reads the budget only
-- through opensea_take and opensea_block; opensea_configure is the indexer's, so its body here is a
-- stand-in that only proves the bot can't run it. The bodies of the other two are the migrations',
-- minus the comments.
create table indexer.opensea_budget (
  id int primary key check (id = 1),
  tokens double precision not null,
  capacity double precision not null,
  refill_per_s double precision not null,
  updated_at timestamptz not null default now(),
  blocked_until timestamptz not null default 'epoch',
  min_interval_ms int not null default 300 check (min_interval_ms >= 0),
  last_take_at timestamptz not null default 'epoch'
);
insert into indexer.opensea_budget (id, tokens, capacity, refill_per_s) values (1, 500, 500, 500 / 3600.0);

create function indexer.opensea_configure(per_hour int, min_interval_ms int default 300) returns void
language plpgsql security definer set search_path = indexer, pg_temp as $$
begin
  update opensea_budget set capacity = per_hour, refill_per_s = per_hour / 3600.0 where id = 1;
end $$;

create function indexer.opensea_take(class int) returns int
language plpgsql security definer set search_path = indexer, pg_temp as $$
declare
  wait_ms int;
begin
  if class is null or class < 0 or class > 4 then
    raise exception 'class must be 0 to 4';
  end if;
  with cur as (
    select tokens, capacity, refill_per_s, blocked_until, min_interval_ms, last_take_at,
      clock_timestamp() as ts, updated_at
    from opensea_budget where id = 1 for update
  ),
  calc as (
    select ts,
      avail,
      (array[0, 0.05, 0.10, 0.25, 0.50])[class + 1] * capacity as floor_tokens,
      refill_per_s,
      blocked_until,
      greatest(0, extract(epoch from
        last_take_at + min_interval_ms * interval '1 millisecond' - ts) * 1000) as spacing_ms
    from (
      select *, least(capacity, tokens + refill_per_s * greatest(0, extract(epoch from ts - updated_at)))
        as avail
      from cur
    ) c
  ),
  decided as (
    select *,
      avail - 1 >= floor_tokens and ts >= blocked_until and spacing_ms = 0 as ok,
      greatest(
        case when avail - 1 >= floor_tokens then 0
          else coalesce((floor_tokens + 1 - avail) / nullif(refill_per_s, 0) * 1000, 3600000) end,
        case when blocked_until > ts then extract(epoch from blocked_until - ts) * 1000 else 0 end,
        spacing_ms,
        0
      ) as wait
    from calc
  )
  update opensea_budget b set
    tokens = case when d.ok then d.avail - 1 else d.avail end,
    last_take_at = case when d.ok then d.ts else b.last_take_at end,
    updated_at = d.ts
  from decided d
  where b.id = 1
  returning case when d.ok then 0 else least(greatest(50, ceil(d.wait)), 3600000)::int end
  into wait_ms;
  return wait_ms;
end $$;

create function indexer.opensea_block(ms int) returns void
language sql security definer set search_path = indexer, pg_temp as $$
  update opensea_budget set
    blocked_until = greatest(blocked_until, clock_timestamp() + least(greatest(ms, 0), 3600000) * interval '1 millisecond')
  where id = 1
$$;

revoke all on function indexer.opensea_configure(int, int), indexer.opensea_take(int), indexer.opensea_block(int) from public;
