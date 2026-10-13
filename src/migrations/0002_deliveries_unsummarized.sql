-- The overflow summary scan looks for skipped rows that have not been counted yet.
create index deliveries_unsummarized on bot.deliveries (chat_id) where status = 'skipped' and not summarized;
