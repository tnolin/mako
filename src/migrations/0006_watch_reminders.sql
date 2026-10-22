-- A user who taps Reminder set on a watched collection stops its reminders without stopping the watch.
alter table bot.nft_watches add column reminders_off boolean not null default false;
