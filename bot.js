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

// NOTE: Since the image file is likely environment-specific, this path remains as you provided.
const IMAGE_PATH = "Wishing Birthday.png"; 

const TRIGGER_MESSAGE = "10/10/2002";
const AUTHORIZED_NUMBERS = ["+918777072747", "+918777845713", "+919903403883"];
const ADMIN_CHAT_ID = 1299129410; // Your Telegram User ID
const START_TIME = Date.now();
// IMPORTANT: Replace this with your actual UPI Virtual Payment Address (VPA)
const BOT_ADMIN_VPA = "9903403883@upi"; 

// === Create bot instance ===
const bot = new Telegraf(TOKEN);

// Global state tracking for multi-step interactions
// user_id -> { state: "awaiting_contact" | "awaiting_upi" | null, data: { amount, upiId } }
const userStates = {}; 

// Global state to track gifts that need admin payment confirmation
// ref_id -> { userId, userUpi, amount }
const pendingGifts = {}; 

// === Helper to send typing indicator ===
async function sendTypingAction(ctx) {
    await ctx.replyWithChatAction('typing');
    // A short delay to make the typing indicator feel more natural
    await new Promise(r => setTimeout(r, 600));
}

// Helper for basic UPI ID validation (VPA format: name.handle@bank)
function isValidUpiId(upiId) {
    // This is a simplified regex; a real system might need a more complex one
    return /^[a-zA-Z0-9\.\-_]+@[a-zA-Z0-9\-]+$/.test(upiId.trim());
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

// === Handle Text Messages (Updated for UPI ID collection) ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // 1. Handle Awaiting UPI State
  if (userStates[userId]?.state === "awaiting_upi") {
    const upiId = text.toLowerCase();
    
    if (isValidUpiId(upiId)) {
        await sendTypingAction(ctx);
        await ctx.reply(`✅ Received UPI ID: \`${upiId}\`. Thank you!`, { parse_mode: 'Markdown' });
        
        // Update state with UPI ID
        userStates[userId].data.upiId = upiId;
        
        // --- Random Number Picking Sequence ---
        await sendTypingAction(ctx);
        await ctx.reply("Calculating your surprise gift amount... this takes a moment! 🧐");
        
        // Simulate "choosing" the number
        const giftAmount = Math.floor(Math.random() * 500) + 1; // 1 to 500
        
        // Update state with the final amount
        userStates[userId].data.amount = giftAmount;

        const numbers = [25, 100, 350, 50, giftAmount, 400];
        
        await new Promise((r) => setTimeout(r, 1000));
        await sendTypingAction(ctx);
        await ctx.reply(`Picking from potential gifts: ${numbers.join('... ')}`);
        await new Promise((r) => setTimeout(r, 2000));
        
        await sendTypingAction(ctx);
        await ctx.replyWithMarkdown(`🎉 You've been selected to receive a gift of *₹${giftAmount}*!`);
        
        // Present the final gift button
        await ctx.reply("Click below to claim your gift immediately:", 
            Markup.inlineKeyboard([
                Markup.button.callback("🎁 Ask for Gift (₹" + giftAmount + ")", "ask_for_gift")
            ])
        );

        // Clear UPI state since the next step is a button click
        userStates[userId].state = null;

    } else {
        await sendTypingAction(ctx);
        await ctx.reply("❌ Invalid UPI ID format. Please make sure it looks like `name@bank` (e.g., `user.123@ybl`) and try again.");
    }
    return;
  }
  
  // 2. Handle Awaiting Contact State
  if (userStates[userId]?.state === "awaiting_contact") {
    await sendTypingAction(ctx);
    await ctx.reply('Please use the "Share Contact" button to send your number.');
    return;
  }

  // 3. Handle Trigger Message flow
  if (text.toLowerCase() === TRIGGER_MESSAGE.toLowerCase()) {
    await sendTypingAction(ctx);
    await ctx.reply("🔍 Checking database to find matches...");
    await new Promise((r) => setTimeout(r, 1000));

    await sendTypingAction(ctx);
    await ctx.reply("⌛ Waiting to receive response...");
    await new Promise((r) => setTimeout(r, 1000));

    const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize();
    await sendTypingAction(ctx);
    await ctx.reply("Please share your phone number to continue:", contactButton);
    userStates[userId] = { state: "awaiting_contact", data: {} };
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

  if (contact && userStates[userId]?.state === "awaiting_contact") {
    // Once contact is shared, they are no longer awaiting it.
    userStates[userId].state = null;
    const userNumber = contact.phone_number.replace("+", "");
    const authorizedNormalized = AUTHORIZED_NUMBERS.map((n) => n.replace("+", ""));

    if (authorizedNormalized.includes(userNumber)) {
      await sendTypingAction(ctx);
      await ctx.reply("📞 Checking back with your number...");
      await new Promise((r) => setTimeout(r, 1000));
      
      await sendTypingAction(ctx);
      await ctx.reply("🔐 Authenticating...");
      await new Promise((r) => setTimeout(r, 1000));
      
      // --- NEW: Confirmation with Buttons ---
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
  } else if (contact) {
      await sendTypingAction(ctx);
      await ctx.reply("I already have your contact, please continue with the flow or send the trigger message again.");
  }
});


// === Handle "Yes" Confirmation Button (Original Flow) ===
bot.action('confirm_yes', async (ctx) => {
    // Edit the original message to show confirmation and remove buttons
    await ctx.editMessageText("✅ Identity confirmed! Preparing your card... 💫");

    // --- START: Sticker Sequence ---
    await sendTypingAction(ctx);
    await ctx.replyWithSticker('CAACAgEAAxkBAAEPieBo5pIfbsOvjPZ6aGZJzuszgj_RMwACMAQAAhyYKEevQOWk5-70BjYE');

    await new Promise((r) => setTimeout(r, 2000));

    await sendTypingAction(ctx);
    await ctx.replyWithSticker('CAACAgEAAxkBAAEPf8Zo4QXOaaTjfwVq2EdaYp2t0By4UAAC-gEAAoyxIER4c3iI53gcxDYE');
    
    await new Promise((r) => setTimeout(r, 1500));
    // --- END: Sticker Sequence ---

    await sendTypingAction(ctx);
    if (fs.existsSync(IMAGE_PATH)) {
      // Assuming IMAGE_PATH is accessible by the bot's environment
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

// === Handle "No" Confirmation Button (Original Flow) ===
bot.action('confirm_no', async (ctx) => {
    await ctx.editMessageText("🚫 Sorry! You're not authorized to perform this action.");
});


// === Handle Ratings (Updated to ask about the second gift) ===
bot.action(/^rating_/, async (ctx) => {
  const rating = ctx.match.input.split("_")[1];
  const username = ctx.from.username || ctx.from.first_name;

  // 1. Edit the rating message
  await ctx.editMessageText(`Thank you for your rating of ${rating} ⭐!`);

  // 2. Notify Admin
  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `User @${username} (ID: ${ctx.chat.id}) rated ${rating} ⭐`
  );

  // 3. Ask about the surprise gift
  await sendTypingAction(ctx);
  const giftKeyboard = Markup.inlineKeyboard([
    Markup.button.callback("Yes, I want a gift! 🥳", "gift_yes"),
    Markup.button.callback("No, thank you.", "gift_no"),
  ]);

  await ctx.replyWithMarkdown(
    "That's wonderful! We have one more surprise. Would you like a *bonus mystery gift* from us?",
    giftKeyboard
  );
});

// === Handle "Yes, I want a gift!" ===
bot.action('gift_yes', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.editMessageText("Great choice! To send you a surprise cash gift, we need your UPI ID (e.g., `user.123@ybl`).");
    
    await sendTypingAction(ctx);
    await ctx.replyWithMarkdown("Please reply to this chat with your valid *UPI ID*:");

    // Set user state to awaiting UPI
    userStates[userId] = { 
        state: "awaiting_upi", 
        data: { amount: null, upiId: null } 
    };
});

// === Handle "No, thank you." ===
bot.action('gift_no', async (ctx) => {
    await ctx.editMessageText("No worries! Thanks again for celebrating with us. Enjoy your card! 😊");
});

// === Handle "Ask for Gift" (User Action) ===
bot.action('ask_for_gift', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];

    if (!state?.data.upiId || !state.data.amount) {
        return ctx.reply("Sorry, I lost track of your details. Please restart the flow from the trigger message.");
    }
    
    const { upiId, amount } = state.data;
    
    // Generate a unique reference ID for the payment (Admin-side tracking)
    const refId = `BDAYGIFT${Date.now()}`; 
    const adminRef = `ADMIN_${refId}`; // Ref ID for the admin message

    // Store the transaction details globally before sending to Admin
    pendingGifts[adminRef] = { userId, userUpi: upiId, amount };

    // 1. Tell the user we're waiting
    await ctx.editMessageText("⏳ Waiting for payment confirmation from the system...");
    
    // 2. Alert the Admin with the request
    const adminNotificationText = `
🚨 *NEW GIFT PAYMENT REQUIRED* 🚨

**To User (ID: \`${userId}\`):**
**Amount:** ₹${amount}
**UPI ID:** \`${upiId}\`
**Ref ID:** \`${refId}\`

Please click the button below to generate and send the payment link.
    `;

    // The Admin clicks this button to generate the deep link
    const adminKeyboard = Markup.inlineKeyboard([
        Markup.button.callback(`✅ Send Payment Link (₹${amount})`, `admin_init_pay:${adminRef}`),
    ]);

    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        adminNotificationText,
        { parse_mode: 'Markdown', ...adminKeyboard }
    );
});


// === Handle "Initialize Payment" (Admin Action) ===
bot.action(/^admin_init_pay:/, async (ctx) => {
    const adminRef = ctx.match.input.split(':')[1];
    const giftData = pendingGifts[adminRef];
    
    // Security check: Only the Admin should proceed with this.
    if (ctx.from.id !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }

    if (!giftData) {
        return ctx.editMessageText("❌ Error: Payment reference expired or not found.", { parse_mode: 'Markdown' });
    }

    const { userId, userUpi, amount } = giftData;
    const refId = adminRef.replace('ADMIN_', '');
    
    // Construct the UPI Deep Link (Admin is the Payer, User is the Payee)
    const upiLink = `upi://pay?pa=${userUpi}&pn=${encodeURIComponent("Gift Recipient")}&am=${amount}&cu=INR&tn=${encodeURIComponent(`Birthday Gift: ${refId}`)}&mc=5499&tr=${refId}&url=https://bot.link`;

    // 1. Edit the Admin message to show the actual payment link
    await ctx.editMessageText(
        `🔗 *Payment Initiated for ₹${amount}* to \`${userUpi}\`. \n\nClick the button to open your UPI app and complete the transfer.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.url("🚀 Open UPI App & Pay", upiLink)
            ])
        }
    );

    // 2. Notify the original user
    await bot.telegram.sendMessage(
        userId,
        "✨ Payment initialization started! The process is underway. Please wait a few minutes, you'll soon receive your gift from the system. Thank you for your patience! 😊"
    );
    
    // Clean up the in-memory state after initiation (optional, can be kept until payment success)
    delete pendingGifts[adminRef];
});


// === Info & Socials Buttons (Original Flow) ===
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
        `⏱ *Uptime*\n\nThis bot has been running for \`${uptimeStr}\`.`,
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
