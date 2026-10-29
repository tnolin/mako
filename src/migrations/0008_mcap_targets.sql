-- A market cap target on a token watch, set by /watch <token> <amount>. One target per watch row: setting a new one
-- replaces it, and the MCAP TARGET alert clears it when it fires. `target_up` is true when the target was above the
-- market cap at the time it was set. `target_set_usd` and `target_set_at` are that market cap and time: the card
-- shows the first, and an event from before the second never fires the target.
alter table bot.subscriptions
  add column target_usd numeric,
  add column target_up boolean,
  add column target_set_usd numeric,
  add column target_set_at timestamptz,
  add constraint subscriptions_target_watch check (target_usd is null or kind = 'watch');
alter table bot.chat_token_watches
  add column target_usd numeric,
  add column target_up boolean,
  add column target_set_usd numeric,
  add column target_set_at timestamptz;
