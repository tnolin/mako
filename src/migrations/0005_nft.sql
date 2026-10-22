-- NFT watches, collection mutes and mint reminders. A watch or mute belongs to one user or to one chat.
-- `chat_id` has no foreign key, like bot.deliveries: chat rows are soft-removed.
create table bot.nft_watches (
  id bigserial primary key,
  user_id bigint references bot.users (id) on delete cascade,
  chat_id bigint,
  contract text not null,
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (chat_id is null))
);
create unique index nft_watches_user on bot.nft_watches (user_id, contract) where user_id is not null;
create unique index nft_watches_chat on bot.nft_watches (chat_id, contract) where chat_id is not null;
create index nft_watches_contract on bot.nft_watches (contract);

create table bot.collection_mutes (
  id bigserial primary key,
  user_id bigint references bot.users (id) on delete cascade,
  chat_id bigint,
  contract text not null,
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (chat_id is null))
);
create unique index collection_mutes_user on bot.collection_mutes (user_id, contract) where user_id is not null;
create unique index collection_mutes_chat on bot.collection_mutes (chat_id, contract) where chat_id is not null;
create index collection_mutes_contract on bot.collection_mutes (contract);

-- Only the user and the collection are kept.
create table bot.reminders (
  user_id bigint not null references bot.users (id) on delete cascade,
  contract text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, contract)
);
create index reminders_contract on bot.reminders (contract);
