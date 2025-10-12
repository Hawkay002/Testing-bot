import { Telegraf, Markup } from "telegraf";
import express from "express";
import fs from "fs";
// Assuming 'fetch' is available globally in the environment (e.g., modern Node.js environments)

// === Bot Configuration ===
// IMPORTANT: Set BOT_TOKEN in your hosting environment's variables.
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN not found! Set it in your environment variables.");
  process.exit(1);
}

// ⚠️ IMPORTANT: REPLACE THIS URL WITH THE RAW LINK TO YOUR GITHUB JSON FILE ⚠️
const GITHUB_USERS_URL = "https://raw.githubusercontent.com/Hawkay002/Testing-bot/refs/heads/main/authorized_users.json";
// ⚠️
// ⚠️ IMPORTANT: REPLACE THIS PLACEHOLDER WITH YOUR BOT'S PUBLIC HTTPS URL
// ⚠️ E.g., if your bot is hosted at https://my-awesome-bot.onrender.com
const BOT_PUBLIC_BASE_URL = "https://testing-bot-v328.onrender.com"; 
// ⚠️

// NOTE: Since the image file is likely environment-specific, this path remains as you provided.
const IMAGE_PATH = "Wishing Birthday.png"; 

const TRIGGER_MESSAGE = "10/10/2002";

// === Authorized Users Map (Will be populated dynamically on startup) ===
let AUTHORIZED_USERS_MAP = {};
// ===============================================

const ADMIN_CHAT_ID = 1299129410; // Your Telegram User ID
const START_TIME = Date.now();
// IMPORTANT: Replace this with your actual UPI Virtual Payment Address (VPA)
const BOT_ADMIN_VPA = "8777845713@upi"; 

// === Create bot instance ===
const bot = new Telegraf(TOKEN);

// Global state tracking for multi-step interactions
// user_id -> { state: "awaiting_contact" | "awaiting_upi" | "spinning" | null, data: { amount, upiId, matchedName } }
const userStates = {}; 

// Global state to track gifts that need admin payment confirmation
// ref_id -> { userId, userUpi, amount }
const pendingGifts = {}; 

// --- Temporary store for UPI redirects and final confirmation context ---
const redirectLinkStore = {}; 
const finalConfirmationMap = {}; // refId -> userId (to send final message)


// === Function to load user data from GitHub ===
async function loadAuthorizedUsers() {
    console.log(`📡 Fetching authorized users from: ${GITHUB_USERS_URL}`);
    try {
        const response = await fetch(GITHUB_USERS_URL);
        
        if (!response.ok) {
            throw new Error(`Failed to fetch user list. HTTP status: ${response.status}`);
        }

        const data = await response.json();
        
        // Ensure the fetched data is a valid object
        if (typeof data === 'object' && data !== null) {
            AUTHORIZED_USERS_MAP = data;
            const userCount = Object.keys(AUTHORIZED_USERS_MAP).length;
            console.log(`✅ Successfully loaded ${userCount} authorized users.`);
        } else {
            throw new Error("Fetched data is not a valid JSON object map.");
        }
    } catch (error) {
        console.error(`❌ FATAL ERROR: Could not load authorized users from GitHub.`);
        console.error("Please check the GITHUB_USERS_URL and ensure the file is public and valid JSON.");
        console.error(error);
        process.exit(1); // Exit if critical data cannot be loaded
    }
}


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

// 1. Redirect Endpoint to launch UPI App
app.get('/pay-redirect', (req, res) => {
    const { id } = req.query;
    const upiLink = redirectLinkStore[id];

    if (upiLink) {
        console.log(`[Redirect] Launching UPI link: ${upiLink}. Link will remain active for re-use.`);
        // Use a 302 Redirect to the upi:// scheme. This is the most reliable way.
        res.redirect(302, upiLink);
    } else {
        res.status(404).send('Link expired or not found. Please re-run the gift flow in the bot.');
    }
});


// 2. Main Keep-Alive endpoint
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

// === Handle Text Messages (Updated for UPI ID collection and Dynamic Spinner) ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // 1. Handle Awaiting UPI State
  if (userStates[userId]?.state === "awaiting_upi") {
    const upiId = text.toLowerCase();
    
    if (isValidUpiId(upiId)) {
        await sendTypingAction(ctx);
        await ctx.reply(`✅ Received UPI ID: \`${upiId}\`. Thank you!`, { parse_mode: 'Markdown' });
        
        // Set state to "spinning" to block further text messages
        userStates[userId].state = "spinning";
        userStates[userId].data.upiId = upiId; // Store UPI ID

        // --- Dynamic Number Spinning Simulation ---
        
        const giftAmount = Math.floor(Math.random() * 500) + 1; // 1 to 500
        userStates[userId].data.amount = giftAmount;

        await sendTypingAction(ctx);
        // Send the initial message to get the message ID for editing
        const message = await ctx.reply("🎁 Spinning the wheel to select your shagun amount...");
        const messageId = message.message_id;

        const spinDuration = 3000; // 3 seconds total spin time
        const startTime = Date.now();
        const spinIcon = '🎰';

        // Start the rapid number changes using setInterval
        const updateInterval = setInterval(async () => {
            if (Date.now() - startTime < spinDuration) {
                const tempNumber = Math.floor(Math.random() * 500) + 1;
                try {
                    // Edit the message rapidly to simulate spinning
                    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `${spinIcon} Current Selection: *₹${tempNumber}*...`, { parse_mode: 'Markdown' });
                } catch (error) {
                    // Ignore common Telegraf errors like "message is not modified" or rate limits during rapid editing
                }
            } else {
                clearInterval(updateInterval);
                
                // Final slow down and stop sequence
                await new Promise(r => setTimeout(r, 500));
                
                // Stop message
                await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `🛑 Stopping at... *₹${giftAmount}*!`, { parse_mode: 'Markdown' });
                await new Promise(r => setTimeout(r, 1000));

                await ctx.replyWithMarkdown(`🎉 You've been selected to receive a shagun of *₹${giftAmount}*!`);
                
                // Present the final gift button
                await ctx.reply("Click below to claim your gift immediately:", 
                    Markup.inlineKeyboard([
                        Markup.button.callback("🎁 Ask for Shagun (₹" + giftAmount + ")", "ask_for_gift")
                    ])
                );
                
                // Set state back to null once the sequence is complete
                userStates[userId].state = null;
                // Retain data until final button click
                // userStates[userId].data.upiId and .amount are already set
            }
        }, 100); // Update every 100ms
        
        // Must return here to allow setInterval to run asynchronously
        return; 

    } else {
        await sendTypingAction(ctx);
        await ctx.reply("❌ Invalid UPI ID format. Please make sure it looks like `name@bank` (e.g., `user.123@ybl`) and try again.");
        return;
    }
  }
  
  // 2. Handle Awaiting Contact State
  if (userStates[userId]?.state === "awaiting_contact") {
    await sendTypingAction(ctx);
    await ctx.reply('Please use the "Share Contact" button to send your number.');
    return;
  }
  
  // 3. Handle Spinning State (Ignore text messages while spinning)
  if (userStates[userId]?.state === "spinning") {
    await sendTypingAction(ctx);
    await ctx.reply('Please wait, the gift amount selection is in progress... 🧐');
    return;
  }


  // 4. Handle Trigger Message flow
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

  // 5. Non-trigger message: show warning + main menu buttons
  await sendTypingAction(ctx);
  await ctx.reply("I only respond to the specific trigger message.");
  
  await sendTypingAction(ctx);
  await ctx.reply("You can check out more details below 👇", getMainMenu());
});

// === Handle Contact Messages (Updated for dynamic user name lookup) ===
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id;
  const contact = ctx.message.contact;

  if (contact && userStates[userId]?.state === "awaiting_contact") {
    // Once contact is shared, they are no longer awaiting it.
    userStates[userId].state = null;
    
    // Normalize the user's phone number: remove all non-digits and take the last 10 digits
    const userNumberRaw = contact.phone_number.replace(/\D/g, "");
    const normalizedNumber = userNumberRaw.slice(-10);
    
    const matchedName = AUTHORIZED_USERS_MAP[normalizedNumber];

    if (matchedName) {
      // Store the name for confirmation later
      userStates[userId].data.matchedName = matchedName;
      
      await sendTypingAction(ctx);
      await ctx.reply("📞 Checking back with your number...");
      await new Promise((r) => setTimeout(r, 1000));
      
      await sendTypingAction(ctx);
      await ctx.reply("🔐 Authenticating...");
      await new Promise((r) => setTimeout(r, 1000));
      
      // --- Confirmation with Dynamic Name ---
      const confirmationKeyboard = Markup.inlineKeyboard([
          Markup.button.callback("Yes, that's me!", "confirm_yes"),
          Markup.button.callback("No, that's not me", "confirm_no")
      ]);

      await sendTypingAction(ctx);
      await ctx.replyWithMarkdown(
        `As per matches found in database, are you *${matchedName}*?`,
        confirmationKeyboard
      );
    } else {
      await sendTypingAction(ctx);
      await ctx.reply("🚫 Sorry! Your number is not authorized to perform this action.");
    }
  } else if (contact) {
      await sendTypingAction(ctx);
      await ctx.reply("I already have your contact, please continue with the flow or send the trigger message again.");
  }
});


// === Handle "Yes" Confirmation Button (Updated to use the matched name) ===
bot.action('confirm_yes', async (ctx) => {
    const userId = ctx.from.id;
    // Retrieve the matched name from state, defaulting if not found (shouldn't happen in flow)
    const matchedName = userStates[userId]?.data?.matchedName || "the authorized user";
    
    // Edit the original message to show confirmation and remove buttons
    await ctx.editMessageText(`✅ Identity confirmed for *${matchedName}*! Preparing your card... 💫`, { parse_mode: 'Markdown' });

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
    await ctx.editMessageText("🚫 Sorry! Authorization failed. Please try again or contact the administrator.");
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
        data: userStates[userId]?.data || { amount: null, upiId: null, matchedName: null } 
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
    await ctx.editMessageText("⏳ Waiting for confirmation...\nThis might take a bit, so feel free to keep the chat open or close the app and carry on with your stuff.\nI’ll let you know as soon as I get the confirmation."); // User sees this first
    
    // 2. Alert the Admin with the request
    const adminNotificationText = `
🚨 *NEW GIFT PAYMENT REQUIRED* 🚨

**To User (ID: \`${userId}\`):**
**Amount:** ₹${amount}
**UPI ID:** \`${upiId}\`
**Ref ID:** \`${refId}\`

Click below to initialize the payment and generate the **HTTPS Redirect Link**.
    `;

    // The Admin clicks this button to generate the deep link and notify the user
    const adminKeyboard = Markup.inlineKeyboard([
        Markup.button.callback(`🚀 Initialize Payment Link (₹${amount})`, `admin_init_pay:${adminRef}`),
    ]);

    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        adminNotificationText,
        { parse_mode: 'Markdown', ...adminKeyboard }
    );
});


// === Handle "Initialize Payment Link" (Admin Action) ===
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
    
    // 1. Construct the UPI Deep Link (Simplified to maximize compatibility)
    const upiLink = `upi://pay?pa=${userUpi}&am=${amount}&pn=${encodeURIComponent("Bday Gift Payee")}&tr=${refId}`;
    
    // 2. Store the upi:// link with a temporary ID for the self-hosted redirect
    const redirectId = Math.random().toString(36).substring(2, 15);
    redirectLinkStore[redirectId] = upiLink;
    
    // Store userId for final confirmation
    finalConfirmationMap[refId] = userId; 

    // 3. Create the public HTTPS link pointing to our Express server
    const httpsRedirectLink = `${BOT_PUBLIC_BASE_URL}/pay-redirect?id=${redirectId}`;

    // 4. Notify the original user with the requested text
    await bot.telegram.sendMessage(
        userId,
        "✨ Payment initialization started, waiting for few minutes you'll soon receive your gift. 😊"
    );
    
    // 5. Edit the Admin message to show the HTTPS button
    await ctx.editMessageText(
        `🔗 *Payment Link for ₹${amount}* to \`${userUpi}\`\n\n**If the button fails, copy the VPA (\`${userUpi}\`) and pay manually.**`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                // This is the new HTTPS link that should reliably open in Telegram
                Markup.button.url("🔥 Finalize Payment in UPI App (HTTPS) - Click to Pay", httpsRedirectLink) 
            ])
        }
    );
    
    // --- Send the follow-up "Payment Done" button to the Admin ---
    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `✅ Payment link initiated for ₹${amount} to ${userUpi}.\n\n*Click "Payment Done" ONLY after you have successfully completed the transaction in your UPI app.*`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                // Pass the refId to the new handler
                Markup.button.callback("✅ Payment Done - Notify User", `payment_done:${refId}`)
            ])
        }
    );
    
    // Clean up the in-memory state after initiation (optional)
    delete pendingGifts[adminRef];
});


// === NEW: Handle "Payment Done" (Admin Action) ===
bot.action(/^payment_done:/, async (ctx) => {
    // Security check
    if (ctx.from.id !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }
    
    const refId = ctx.match.input.split(':')[1];
    const targetUserId = finalConfirmationMap[refId];

    if (!targetUserId) {
        return ctx.editMessageText("❌ Error: Could not determine target user ID for confirmation. Reference may have expired.", { parse_mode: 'Markdown' });
    }

    // 1. Send final confirmation to the user
    await bot.telegram.sendMessage(
        targetUserId,
        "🎉 **Shagun has been sent Successfully!** Please check your bank account or UPI application. We hope you enjoyed your birthday surprise! ❤️",
        { parse_mode: 'Markdown' }
    );
    
    // 2. Edit the Admin message to show it's completed
    await ctx.editMessageText(`✅ User (ID: ${targetUserId}) has been successfully notified that payment is complete for Ref ID: ${refId}.`, { parse_mode: 'Markdown' });

    // Clean up all reference data
    delete finalConfirmationMap[refId];
    // Note: The redirectLinkStore entry will remain until bot restart for re-use of the HTTPS link, as requested.
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

// === Main startup function ===
async function main() {
    // 1. Load data from the external GitHub source
    await loadAuthorizedUsers();
    
    // 2. Start Bot
    bot.launch();
    console.log("🤖 Bot is running...");
    
    // 3. Graceful shutdown handlers
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

// Execute main function
main();
