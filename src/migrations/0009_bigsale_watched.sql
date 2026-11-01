-- BIG SALE now reaches only chats that watch the collection, and its switch applies to them. Until now a watch
-- ignored the switch, so every watcher got BIG SALE whatever the switch said. Switching it on keeps that.
update bot.users set settings = jsonb_set(settings, '{alerts,bigsale,on}', 'true')
  where settings #> '{alerts,bigsale}' is not null;
update bot.chats set settings = jsonb_set(settings, '{alerts,bigsale,on}', 'true')
  where settings #> '{alerts,bigsale}' is not null;
