import { Telegraf, Markup } from "telegraf";
import express from "express";
import fs from "fs";

// === Bot Configuration ===
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN not found! Set it in Render environment variables.");
  process.exit(1);
}

const IMAGE_PATH = "Wishing Birthday.png";
const TRIGGER_MESSAGE = "10/10/2002";
const AUTHORIZED_NUMBERS = ["+918777072747", "+918777845713"];
const ADMIN_CHAT_ID = 1299129410;
const START_TIME = Date.now();

// === Create bot instance ===
const bot = new Telegraf(TOKEN);
const userStates = {}; // user_id -> "awaiting_contact" | "awaiting_name" | null

// === Keep-Alive Server ===
const app = express();
app.get("/", (req, res) => res.send("✅ Bot server is alive and running!"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Keep-alive server running on port ${PORT}`));

// === Helper: Main Menu Buttons ===
function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📜 Bot Info", "info"), Markup.button.callback("💬 Description", "description")],
    [Markup.button.callback("👤 Master", "master"), Markup.button.callback("⏱ Uptime", "uptime")],
    [Markup.button.callback("🌐 Master’s Socials", "socials")]
  ]);
}

// === /start Command ===
bot.start((ctx) => ctx.reply("Hi! Send the secret word you just copied to get your card! ❤️❤️❤️", getMainMenu()));

// === Handle Text Messages ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim().toLowerCase();

  if (userStates[userId] === "awaiting_name") {
    if (text === "y") {
      await ctx.reply("✅ Identity confirmed! Preparing your card... 💫");
      delete userStates[userId];
      await new Promise((r) => setTimeout(r, 2500));
      await ctx.replyWithPhoto({ source: IMAGE_PATH }, { caption: "🎁 Your card is ready — Tap to reveal!", has_spoiler: true });

      const ratingKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("1 ⭐", "rating_1"),
          Markup.button.callback("2 ⭐", "rating_2"),
          Markup.button.callback("3 ⭐", "rating_3"),
          Markup.button.callback("4 ⭐", "rating_4"),
          Markup.button.callback("5 ⭐", "rating_5"),
        ],
      ]);

      await ctx.reply("Please rate your experience:", ratingKeyboard);
    } else if (text === "n") {
      await ctx.reply("🚫 Sorry! You're not authorized to perform this action.");
      delete userStates[userId];
    } else {
      await ctx.reply('Please reply with "Y" for yes or "N" for no.');
    }
    return;
  }

  if (userStates[userId] === "awaiting_contact") {
    await ctx.reply('Please use the "Share Contact" button to send your number.');
    return;
  }

  if (text === TRIGGER_MESSAGE.toLowerCase()) {
    await ctx.reply("🔍 Checking database to find matches...");
    await new Promise((r) => setTimeout(r, 1500));
    await ctx.reply("⌛ Waiting to receive response...");
    await new Promise((r) => setTimeout(r, 1500));

    const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize();
    await ctx.reply("Please share your phone number to continue:", contactButton);
    userStates[userId] = "awaiting_contact";
    return;
  }

  await ctx.reply("I only respond to the specific trigger message.");
  await ctx.reply("You can check out more details below 👇", getMainMenu());
});

// === Handle Contact Messages ===
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id;
  const contact = ctx.message.contact;

  if (contact) {
    const userNumber = contact.phone_number.replace("+", "");
    const authorizedNormalized = AUTHORIZED_NUMBERS.map((n) => n.replace("+", ""));

    if (authorizedNormalized.includes(userNumber)) {
      await ctx.reply("📞 Checking back with your number...");
      await new Promise((r) => setTimeout(r, 1500));
      await ctx.reply("🔐 Authenticating...");
      await new Promise((r) => setTimeout(r, 1500));

      await ctx.replyWithMarkdown(
        'As per matches found in database, are you *Pratik Roy*?\nReply "Y" for yes and "N" for no.'
      );

      userStates[userId] = "awaiting_name";
    } else {
      await ctx.reply("🚫 Sorry! You're not authorized to perform this action.");
      delete userStates[userId];
    }
  }
});

// === Handle Ratings ===
bot.action(/^rating_/, async (ctx) => {
  const rating = ctx.match.input.split("_")[1];
  const username = ctx.from.username || ctx.from.first_name;

  await ctx.editMessageText(`Thank you for your rating of ${rating} ⭐!`);

  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `User @${username} (ID: ${ctx.chat.id}) rated ${rating} ⭐`
  );
});

// === Info & Socials Buttons ===
bot.action(["info","description","master","uptime","socials","back_to_menu"], async (ctx) => {
  const data = ctx.match.input;
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;
  const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

  const backButton = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back","back_to_menu")]]);

  switch(data){
    case "info":
      await ctx.editMessageText(
        "🤖 *Bot Info*\n\nThis bot was specially made for sending personalized *birthday wish cards* to that person who deserves a surprise 🎉🎂.",
        { parse_mode:"Markdown", ...backButton }
      );
      break;

    case "description":
      await ctx.editMessageText(
        "💬 *Description*\n\nA fun, interactive bot built to deliver surprise birthday wishes with love 💫",
        { parse_mode:"Markdown", ...backButton }
      );
      break;

    case "master":
      await ctx.editMessageText(
        "👤 *Master*\n\nMade by **Shovith (Sid)** ✨",
        { parse_mode:"Markdown", ...backButton }
      );
      break;

    case "uptime":
      await ctx.editMessageText(
        `⏱ *Uptime*\n\nYou've been using this bot for past \`${uptimeStr}\`.`,
        { parse_mode:"Markdown", ...backButton }
      );
      break;

    case "socials":
      await ctx.editMessageText(
        "*🌐 Master’s Socials*\n\nChoose a platform to connect:",
        {
          parse_mode:"Markdown",
          reply_markup: Markup.inlineKeyboard([
            [Markup.button.url("WhatsApp", "https://wa.me/918777845713"), Markup.button.url("Telegram", "https://t.me/X_o_x_o_002")],
            [Markup.button.url("Website", "https://hawkay002.github.io/Connect/")],
            [Markup.button.callback("⬅️ Back", "back_to_menu")]
          ])
        }
      );
      break;

    case "back_to_menu":
      await ctx.editMessageText("You can check out more details below 👇", getMainMenu());
      break;
  }
});

// === Start Bot ===
bot.launch();
console.log("🤖 Bot is running...");

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
