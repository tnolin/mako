-- Run as a superuser after both schemas exist. The bot reads only these two indexer tables.
grant usage on schema indexer to mako;
grant select on indexer.events, indexer.cursors to mako;
