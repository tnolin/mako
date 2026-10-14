-- A NEW TOKENS flood card is queued when its minute starts and sent when the minute is over.
alter table bot.deliveries add column send_after timestamptz;
