// Sends one message with a green button and a plain button to a test chat, for the Telegram client check
// ("Button states → Colour check" in the design notes). Owner-run, with the TEST bot's token:
//   TELEGRAM_BOT_TOKEN=<test bot token> pnpm tsx scripts/colour-check.ts <chat id>
// Open the message on every supported client (iOS, Android, Desktop on macOS, Windows and Linux, and Web),
// on the current and the oldest supported version. If any client shows both buttons the same, set
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
