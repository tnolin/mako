create table bot.users (
  id bigserial primary key,
  platform text not null default 'telegram',
  platform_user_id bigint not null,
  settings jsonb not null,
  created_at timestamptz not null default now(),
  blocked_at timestamptz,
  unique (platform, platform_user_id)
);

-- kind holds Telegram's chat type, so deliveries can copy it.
create table bot.chats (
  id bigserial primary key,
  platform text not null default 'telegram',
  chat_id bigint not null,
  kind text not null check (kind in ('group', 'supergroup', 'channel')),
  owner bigint references bot.users (id) on delete set null,
  setup_by bigint references bot.users (id) on delete set null,
  settings jsonb not null,
  active boolean not null default false,
  paused_reason text,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (platform, chat_id)
);

create table bot.subscriptions (
  user_id bigint not null references bot.users (id) on delete cascade,
  kind text not null check (kind in ('watch', 'mute')),
  target text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind, target)
);
create index subscriptions_target on bot.subscriptions (target, kind);

create table bot.deliveries (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  chat_type text not null check (chat_type in ('private', 'group', 'supergroup', 'channel')),
  thread_id int,
  alert text not null,
  token text,
  dedupe_key text not null,
  priority smallint not null,
  event_ts timestamptz not null,
  card jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'superseded', 'skipped', 'failed')),
  attempts int not null default 0,
  -- true once a skipped row has been counted in an overflow summary
  summarized boolean not null default false,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  unique (chat_id, dedupe_key)
);
create index deliveries_pending on bot.deliveries (chat_id, priority, created_at) where status = 'pending';
create index deliveries_created on bot.deliveries (created_at);
create index deliveries_token_alert on bot.deliveries (token, alert, event_ts);

create table bot.delivery_daily (
  day date not null,
  alert text not null,
  chat_type text not null,
  status text not null,
  count bigint not null,
  primary key (day, alert, chat_type, status)
);

create table bot.commands_daily (
  day date not null,
  command text not null,
  count bigint not null,
  primary key (day, command)
);

-- No user column: analytics hold no personal data. chat_id is null for private chats.
create table bot.user_actions (
  id bigserial primary key,
  chat_type text not null check (chat_type in ('private', 'group', 'supergroup', 'channel')),
  chat_id bigint,
  action text not null,
  token text,
  params jsonb not null default '{}',
  created_at timestamptz not null default now(),
  check (chat_type <> 'private' or chat_id is null)
);

create table bot.notices (
  chat_id bigint not null,
  reason text not null,
  sent_at timestamptz not null,
  primary key (chat_id, reason)
);

create table bot.state (
  key text primary key,
  value text not null
);
