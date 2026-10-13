-- The parts of ink-indexer's schema that MAKO reads, copied at tag events-v1
-- (packages/db/migrations/0001_init.sql and 0002_events_bot_indexes.sql). Update with the tag.
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
  confirmed boolean not null,
  created_at timestamptz not null default now(),
  unique (tx_hash, log_index)
);
create index events_entity_id on indexer.events (entity, id);
create index events_block on indexer.events (block);
create index events_unconfirmed on indexer.events (id) where not confirmed;
create index events_launch_creator on indexer.events ((payload->>'creator'), id)
  where type = 'launchpad.launch';
create index events_type_id on indexer.events (type, id);

create table indexer.cursors (
  source text primary key,
  block bigint not null,
  block_hash text not null
);
