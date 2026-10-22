-- Run as a superuser after both schemas exist. The bot reads only these two indexer tables.
grant usage on schema indexer to mako;
grant select on indexer.events, indexer.cursors to mako;
-- The NFT card's OpenSea item read and the trending list spend the indexer's shared request budget.
-- EXECUTE only: the functions are security definer, and the budget table stays out of reach.
grant execute on function indexer.opensea_take(int), indexer.opensea_block(int) to mako;
