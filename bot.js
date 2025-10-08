import { Telegraf, Markup } from "telegraf";
import express from "express";
import fs from "fs";

// === Bot Configuration ===
// IMPORTANT: Set BOT_TOKEN in your hosting environment's variables.
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN not found! Set it in your environment variables.");
  process.exit(1);
}


const IMAGE_PATH = "Wishing Birthday.png";
const TRIGGER_MESSAGE = "10/10/2002";
const AUTHORIZED_NUMBERS = ["+918777072747", "+918777845713"];
const ADMIN_CHAT_ID = 1299129410; // Your Telegram User ID
const START_TIME = Date.now();

// === Create bot instance ===
const bot = new Telegraf(TOKEN);
const userStates = {}; // user_id -> "awaiting_contact" | "awaiting_name" | null

// === Helper to send typing indicator ===
async function sendTypingAction(ctx) {
    await ctx.replyWithChatAction('typing');
    // A short delay to make the typing indicator feel more natural
    await new Promise(r => setTimeout(r, 800));
}


// === Keep-Alive Server (for hosting platforms like Render) ===
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
bot.start(async (ctx) => {
  await sendTypingAction(ctx);
  await ctx.reply("Hi! Send the secret word you just copied to get your card! ❤️❤️❤️");
});

// === Handle Text Messages ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim().toLowerCase();

  // Awaiting name confirmation
  if (userStates[userId] === "awaiting_name") {
    if (text === "y") {
      await sendTypingAction(ctx);
      await ctx.reply("✅ Identity confirmed! Preparing your card... 💫");
      delete userStates[userId];
      
      // --- START: Sticker Sequence ---
      await sendTypingAction(ctx);
      await ctx.replyWithSticker('CAACAgEAAxkBAAEPieBo5pIfbsOvjPZ6aGZJzuszgj_RMwACMAQAAhyYKEevQOWk5-70BjYE');

      await new Promise((r) => setTimeout(r, 3000));

      await sendTypingAction(ctx);
      await ctx.replyWithSticker('CAACAgEAAxkBAAEPf8Zo4QXOaaTjfwVq2EdaYp2t0By4UAAC-gEAAoyxIER4c3iI53gcxDYE');
      
      await new Promise((r) => setTimeout(r, 1500));
      // --- END: Sticker Sequence ---

      await sendTypingAction(ctx);
      if (fs.existsSync(IMAGE_PATH)) {
        await ctx.replyWithPhoto({ source: IMAGE_PATH }, { caption: "🎁 Your card is ready — Tap to reveal!", has_spoiler: true });
      } else {
        await ctx.reply("😔 Sorry, the birthday card image is missing on the server.");
        console.error(`Error: Image not found at ${IMAGE_PATH}`);
      }

      const ratingKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("1 ⭐", "rating_1"),
          Markup.button.callback("2 ⭐", "rating_2"),
          Markup.button.callback("3 ⭐", "rating_3"),
          Markup.button.callback("4 ⭐", "rating_4"),
          Markup.button.callback("5 ⭐", "rating_5"),
        ],
      ]);
      
      await sendTypingAction(ctx);
      await ctx.reply("Please rate your experience:", ratingKeyboard);
    } else if (text === "n") {
      await sendTypingAction(ctx);
      await ctx.reply("🚫 Sorry! You're not authorized to perform this action.");
      delete userStates[userId];
    } else {
      await sendTypingAction(ctx);
      await ctx.reply('Please reply with "Y" for yes or "N" for no.');
    }
    return;
  }

  // Awaiting contact
  if (userStates[userId] === "awaiting_contact") {
    await sendTypingAction(ctx);
    await ctx.reply('Please use the "Share Contact" button to send your number.');
    return;
  }

  // Trigger message flow
  if (text === TRIGGER_MESSAGE.toLowerCase()) {
    await sendTypingAction(ctx);
    await ctx.reply("🔍 Checking database to find matches...");
    await new Promise((r) => setTimeout(r, 1500));

    await sendTypingAction(ctx);
    await ctx.reply("⌛ Waiting to receive response...");
    await new Promise((r) => setTimeout(r, 1500));

    const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize();
    await sendTypingAction(ctx);
    await ctx.reply("Please share your phone number to continue:", contactButton);
    userStates[userId] = "awaiting_contact";
    return;
  }

  // Non-trigger message: show warning + main menu buttons
  await sendTypingAction(ctx);
  await ctx.reply("I only respond to the specific trigger message.");
  
  await sendTypingAction(ctx);
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
      await sendTypingAction(ctx);
      await ctx.reply("📞 Checking back with your number...");
      await new Promise((r) => setTimeout(r, 1500));
      
      await sendTypingAction(ctx);
      await ctx.reply("🔐 Authenticating...");
      await new Promise((r) => setTimeout(r, 1500));
      
      await sendTypingAction(ctx);
      await ctx.replyWithMarkdown(
        'As per matches found in database, are you *Pratik Roy*?\nReply "Y" for yes and "N" for no.'
      );

      userStates[userId] = "awaiting_name";
    } else {
      await sendTypingAction(ctx);
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

  // No typing indicator needed for sending a message to the admin
  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `User @${username} (ID: ${ctx.chat.id}) rated ${rating} ⭐`
  );
});

// === Info & Socials Buttons ===
// Typing indicators are not needed for editMessageText as it modifies an existing message
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
          ...Markup.inlineKeyboard([
            [Markup.button.url("WhatsApp", "https://wa.me/918777845713")],
            [Markup.button.url("Telegram", "https://t.me/X_o_x_o_002")],
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
