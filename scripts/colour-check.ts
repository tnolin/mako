// Sends one message with a green button and a plain button to a test chat, to check how a Telegram client
// shows button colours. Run it with a test bot's token:
//   TELEGRAM_BOT_TOKEN=<test bot token> pnpm tsx scripts/colour-check.ts <chat id>
// Open the message on each client you support. If a client shows both buttons the same, set
// BUTTON_COLOURS=0 in the deploy env.
import { Bot } from "grammy"
import { btn, btnOn } from "../src/platforms/telegram/ui"

const token = process.env.TELEGRAM_BOT_TOKEN
const chat = Number(process.argv[2])
if (!token || !Number.isInteger(chat)) {
  console.error("usage: TELEGRAM_BOT_TOKEN=<test bot token> colour-check.ts <chat id>")
  process.exit(2)
}
const bot = new Bot(token)
await bot.api.sendMessage(chat, "Colour check: the first button is sent green, the second plain.", {
  reply_markup: { inline_keyboard: [[btnOn("Green", "cc:on"), btn("Plain", "cc:off")]] },
})
console.log("sent")
