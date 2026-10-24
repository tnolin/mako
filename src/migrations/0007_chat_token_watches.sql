-- Tokens a group or channel watches, set by an admin's /watch. User watches stay in bot.subscriptions.
-- `chat_id` has no foreign key, like bot.nft_watches: chat rows are soft-removed.
create table bot.chat_token_watches (
  chat_id bigint not null,
  target text not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, target)
);
create index chat_token_watches_target on bot.chat_token_watches (target);
