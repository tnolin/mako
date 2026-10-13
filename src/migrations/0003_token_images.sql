-- The Telegram file_id of each token's padded image, so it is fetched and uploaded once per token.
create table bot.token_images (
  token text primary key,
  file_id text not null,
  created_at timestamptz not null default now()
);
