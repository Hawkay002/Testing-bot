import { Telegraf, Markup } from "telegraf";
import express from "express";
import fs from "fs";
// Assuming 'fetch' is available globally in the environment (e.g., modern Node.js environments)

// === Bot Configuration ===
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN not found! Set it in your environment variables.");
  process.exit(1);
}

// ⚠️ IMPORTANT: Update these based on your GitHub setup ⚠️
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Required for file updates
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Hawkay002'; // Your GitHub username
const GITHUB_REPO = process.env.GITHUB_REPO || 'Testing-bot'; // Your repository name
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH || 'authorized_users.json'; // The file to update
const GITHUB_USERS_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/${GITHUB_FILE_PATH}`;
// ⚠️ 
const BOT_PUBLIC_BASE_URL = "https://testing-bot-v328.onrender.com"; 
// ⚠️ NEW: RENDER DEPLOY HOOK URL (Set this in Render environment variables) ⚠️
const RENDER_DEPLOY_HOOK = process.env.RENDER_DEPLOY_HOOK;
// ⚠️ 

const IMAGE_PATH = "Wishing Birthday.png"; 

// === NEW REQUEST MANAGEMENT CONSTANTS ===
const UPI_QR_CODE_PATH = "upi_qr_code.png"; // Placeholder path for QR code image
const REQUEST_FEE = 50;

// === Authorized Users Map (Will be populated dynamically on startup) ===
// Structure: { "phoneNumber": { name: "User Name", trigger_word: "unique_word", can_claim_gift: boolean } }
let AUTHORIZED_USERS_MAP = {};
let GITHUB_FILE_SHA = null; // Store the current file SHA, required for updates
// ===============================================

const ADMIN_CHAT_ID = 1299129410; // Your Telegram User ID
const START_TIME = Date.now();
const BOT_ADMIN_VPA = "8777845713@upi"; 

// === Create bot instance ===
const bot = new Telegraf(TOKEN);

// Global state tracking for multi-step interactions
// user_id -> { state: "awaiting_...", data: { ... } }
const userStates = {}; 
const pendingGifts = {}; 
const redirectLinkStore = {}; 
const finalConfirmationMap = {};
const pendingCardRequests = {}; // NEW: Store full request data for admin action

// Global state for the multi-step deletion command
const deletionStates = {}; 
// Global state for the multi-step gift management command
const giftManagementStates = {};


// === Function to load user data from GitHub (and get SHA for future updates) ===
async function loadAuthorizedUsers() {
    console.log(`📡 Fetching authorized users from: ${GITHUB_USERS_URL}`);
    try {
        // Fetch the raw content
        const contentResponse = await fetch(GITHUB_USERS_URL);
        
        if (!contentResponse.ok) {
            throw new Error(`Failed to fetch raw content. HTTP status: ${contentResponse.status}`);
        }
        const data = await contentResponse.json();
        
        // Fetch metadata to get the current SHA
        const metadataUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
        const metadataResponse = await fetch(metadataUrl, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}` }
        });
        
        if (!metadataResponse.ok) {
             throw new Error(`Failed to fetch file metadata (SHA). HTTP status: ${metadataResponse.status}`);
        }
        const metadata = await metadataResponse.json();
        
        // Update global state and normalize user data (add default can_claim_gift)
        if (typeof data === 'object' && data !== null && metadata.sha) {
            // Apply default setting to existing users if the field is missing
            const normalizedData = Object.fromEntries(
                Object.entries(data).map(([phone, userData]) => [
                    phone,
                    { ...userData, can_claim_gift: userData.can_claim_gift === false ? false : true }
                ])
            );

            AUTHORIZED_USERS_MAP = normalizedData;
            GITHUB_FILE_SHA = metadata.sha;
            const userCount = Object.keys(AUTHORIZED_USERS_MAP).length;
            console.log(`✅ Loaded ${userCount} users. Current SHA: ${GITHUB_FILE_SHA}`);
        } else {
            throw new Error("Fetched data is invalid or SHA is missing.");
        }
    } catch (error) {
        console.error(`❌ FATAL ERROR: Could not load authorized users from GitHub.`);
        console.error("Please ensure GITHUB_TOKEN, OWNER, REPO, and FILE_PATH are correct.");
        console.error(error.message || error);
    }
}

// === Function to update the file content on GitHub (FIXED for gift status) ===
async function updateAuthorizedUsersOnGithub(newContent, committerName, committerEmail, commitMessage) {
    if (!GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN environment variable is not set.");
    }
    if (!GITHUB_FILE_SHA) {
        throw new Error("Current file SHA is unknown. Cannot perform update.");
    }
    
    const contentToCommit = {};
    for (const [phone, userData] of Object.entries(newContent)) {
        const cleanedUserData = { ...userData };
        if (cleanedUserData.matchedPhone) delete cleanedUserData.matchedPhone;
        if (cleanedUserData.can_claim_gift === true) delete cleanedUserData.can_claim_gift; 
        contentToCommit[phone] = cleanedUserData;
    }
    
    const contentEncoded = Buffer.from(JSON.stringify(contentToCommit, null, 2)).toString('base64');
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    const payload = {
        message: commitMessage,
        content: contentEncoded,
        sha: GITHUB_FILE_SHA,
        committer: { name: committerName, email: committerEmail || 'telegram-bot@hawkay.com' }
    };
    
    console.log(`Attempting to update file at: ${apiUrl}`);

    const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Telegraf-Admin-Bot'
        },
        body: JSON.stringify(payload)
    });

    if (response.ok) {
        const result = await response.json();
        GITHUB_FILE_SHA = result.content.sha;
        console.log(`✅ GitHub update successful. New SHA: ${GITHUB_FILE_SHA}`);
        return true;
    } else {
        const errorText = await response.text();
        console.error(`❌ GitHub update failed. Status: ${response.status}. Response: ${errorText}`);
        throw new Error(`GitHub API Error: ${response.statusText}. Check console for details.`);
    }
}

// === NEW ADMIN FUNCTION: Trigger Render Redeploy ===
async function adminRedeployService(ctx) {
    if (!RENDER_DEPLOY_HOOK) {
        return ctx.reply("❌ RENDER_DEPLOY_HOOK is not set in environment variables. Cannot redeploy.");
    }
    
    await ctx.reply("🚀 Attempting to trigger a service re-deploy on Render...");
    
    try {
        const response = await fetch(RENDER_DEPLOY_HOOK, { method: 'POST' });
        if (response.ok) {
            await ctx.reply("✅ Deploy hook successfully triggered! Render should now be building and restarting the service. This may take 1-3 minutes.");
        } else {
            const errorText = await response.text();
            await ctx.reply(`❌ Failed to trigger deploy hook. Status: ${response.status}. Error: ${errorText}`);
        }
    } catch (error) {
        await ctx.reply(`❌ An error occurred while contacting the Render service: ${error.message}`);
    }
}

// === Helper to send typing indicator ===
async function sendTypingAction(ctx) {
    await ctx.replyWithChatAction('typing');
    await new Promise(r => setTimeout(r, 600));
}

// Helper for basic UPI ID validation (VPA format: name.handle@bank)
function isValidUpiId(upiId) {
    return /^[a-zA-Z0-9\.\-_]+@[a-zA-Z0-9\-]+$/.test(upiId.trim());
}

// === Admin Search Helper Function (used by /remove, /revoke, /allow) ===
function searchUsers(query) {
    return Object.entries(AUTHORIZED_USERS_MAP)
        .filter(([phone, data]) => 
            phone.includes(query) || data.name.toLowerCase().includes(query.toLowerCase())
        );
}

// === Keep-Alive Server (for hosting platforms like Render) ===
const app = express();
app.get('/pay-redirect', (req, res) => {
    const { id } = req.query;
    const upiLink = redirectLinkStore[id];
    if (upiLink) res.redirect(302, upiLink);
    else res.status(404).send('Link expired or not found.');
});
app.get("/", (req, res) => res.send("✅ Bot server is alive and running!"));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Keep-alive server running on port ${PORT}`));

// === /start Command ===
bot.start(async (ctx) => {
  await sendTypingAction(ctx);
  await ctx.reply("Hi! Send your unique secret word you just copied to get your personalized card! ❤️❤️❤️\n\nOr use /request to ask for a new custom card.");
});

// === Handle Deletion Action ===
bot.action(/^admin_delete:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return ctx.reply("🚫 Unauthorized.");
    
    const phoneToDelete = ctx.match.input.split(':')[1];
    await ctx.editMessageText(`⏳ Deleting user \`${phoneToDelete}\`...`, { parse_mode: 'Markdown' });
    
    if (!AUTHORIZED_USERS_MAP[phoneToDelete]) {
        return ctx.editMessageText(`❌ User \`${phoneToDelete}\` not found.`, { parse_mode: 'Markdown' });
    }

    const userName = AUTHORIZED_USERS_MAP[phoneToDelete].name;
    try {
        const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
        delete newAuthorizedUsers[phoneToDelete];
        
        const commitMessage = `feat(bot): Remove user ${userName} (${phoneToDelete}) via Telegram`;
        await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, null, commitMessage);
        
        AUTHORIZED_USERS_MAP = newAuthorizedUsers;
        if (deletionStates[ctx.from.id]) delete deletionStates[ctx.from.id];
        await ctx.editMessageText(`✅ User **${userName}** (\`${phoneToDelete}\`) removed.`, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.editMessageText(`❌ Failed to remove **${userName}**: ${error.message}.`, { parse_mode: 'Markdown' });
    }
});

// === Handle Gift Eligibility Management Actions (Revoke/Allow) ===
bot.action(/^admin_gift_manage:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return ctx.reply("🚫 Unauthorized.");
    
    const [actionType, phone] = ctx.match.input.split(':').slice(1);
    const isRevoke = actionType === 'revoke';
    await ctx.editMessageText(`⏳ Updating gift status for \`${phone}\`...`, { parse_mode: 'Markdown' });
    
    if (!AUTHORIZED_USERS_MAP[phone]) {
        return ctx.editMessageText(`❌ User \`${phone}\` not found.`, { parse_mode: 'Markdown' });
    }

    const userName = AUTHORIZED_USERS_MAP[phone].name;
    const newStatus = !isRevoke;
    try {
        const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
        newAuthorizedUsers[phone] = { ...newAuthorizedUsers[phone], can_claim_gift: newStatus };
        
        const statusText = newStatus ? 'allowed' : 'revoked';
        const commitMessage = `feat(bot): Gift eligibility ${statusText} for ${userName} (${phone}) via Telegram`;
        await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, null, commitMessage);
        
        AUTHORIZED_USERS_MAP = newAuthorizedUsers;
        if (giftManagementStates[ctx.from.id]) delete giftManagementStates[ctx.from.id];
        await ctx.editMessageText(`✅ Gift status for **${userName}** is now **${statusText.toUpperCase()}**.`, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.editMessageText(`❌ Failed to update status for **${userName}**: ${error.message}.`, { parse_mode: 'Markdown' });
    }
});

// === NEW: Handle Admin Grant Request Action ===
bot.action(/^admin_grant:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return ctx.reply("🚫 Unauthorized.");

    const [targetUserIdStr, refId] = ctx.match.input.split(':').slice(1);
    const targetUserId = parseInt(targetUserIdStr);
    
    const requestDetails = pendingCardRequests[refId];
    if (!requestDetails) {
        return ctx.editMessageText(`⚠️ Request \`${refId}\` not found or expired.`, { parse_mode: 'Markdown' });
    }
    
    const triggerWord = Math.random().toString(36).substring(2, 9).toUpperCase();
    await ctx.editMessageText(`✅ Request \`${refId}\` **GRANTED**. Notifying user with trigger word: \`${triggerWord}\`.`, { parse_mode: 'Markdown' });

    try {
        await ctx.telegram.sendMessage(
            targetUserId,
            `🎉 **SUCCESS!** Your custom card request has been approved!\n\nYour **unique secret word** is: \`${triggerWord}\`\n\nSend this word to me to begin the verification process.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
         await ctx.reply(`❌ Failed to notify user ${targetUserId}. They may have blocked the bot.`);
    }

    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🚨 **ACTION REQUIRED for \`${refId}\`** 🚨\nUser \`${requestDetails.userName}\` notified. Add them to the database:\n\`/add ${requestDetails.userPhone}, ${requestDetails.userName}, ${triggerWord}\``,
        { parse_mode: 'Markdown' }
    );
    delete pendingCardRequests[refId];
});

// === NEW: Handle Admin Decline Request Action ===
bot.action(/^admin_decline:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return ctx.reply("🚫 Unauthorized.");

    const [targetUserIdStr, refId] = ctx.match.input.split(':').slice(1);
    const targetUserId = parseInt(targetUserIdStr);
    
    const requestDetails = pendingCardRequests[refId];
    if (!requestDetails) {
        return ctx.editMessageText(`⚠️ Request \`${refId}\` not found or expired.`, { parse_mode: 'Markdown' });
    }
    
    await ctx.editMessageText(`✅ Request \`${refId}\` **DECLINED**. Notifying user.`, { parse_mode: 'Markdown' });

    try {
        await ctx.telegram.sendMessage(
            targetUserId,
            `😔 **Request Update:** We're sorry, but your custom card request could not be processed.\n\nYour fee of ₹${REQUEST_FEE} will be refunded to your UPI ID (\`${requestDetails.refundUpi}\`) within 24 hours.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
         await ctx.reply(`❌ Failed to notify user ${targetUserId}. They may have blocked the bot.`);
    }

    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `ℹ️ **Request \`${refId}\` Declined.** User **${requestDetails.userName}** notified.\n\n**ACTION REQUIRED:** Refund ₹${REQUEST_FEE} to UPI: \`${requestDetails.refundUpi}\``,
        { parse_mode: 'Markdown' }
    );
    delete pendingCardRequests[refId];
});


// === Handle Photo/Document Messages (Image Collection & Payment Screenshot) ===
bot.on(['photo', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    const isPhoto = ctx.message.photo;
    const isDocument = ctx.message.document;
    
    let fileId = null, mimeType = null, caption = ctx.message.caption;
    if (isPhoto) {
        fileId = isPhoto[isPhoto.length - 1].file_id;
        mimeType = 'image/jpeg';
    } else if (isDocument && isDocument.mime_type?.startsWith('image')) {
        fileId = isDocument.file_id;
        mimeType = isDocument.mime_type;
    } else { return; }

    const state = userStates[userId];
    
    // --- Step 4: Collect Card Image (awaiting_request_image) ---
    if (state?.state === "awaiting_request_image") {
        await sendTypingAction(ctx);
        state.data.requestImageFileId = fileId;
        state.state = "awaiting_payment_screenshot";
        
        await ctx.reply("✅ Image received. Proceeding to the final payment step...");
        await sendTypingAction(ctx);

        if (fs.existsSync(UPI_QR_CODE_PATH)) {
            await ctx.replyWithPhoto({ source: UPI_QR_CODE_PATH }, {
                caption: `💰 **Payment Required: Step 5 of 5**\n\nPlease pay a standard fee of *₹${REQUEST_FEE}* for custom card design requests.`,
                parse_mode: 'Markdown'
            });
        } else {
             await ctx.replyWithMarkdown(`💰 **Payment Required: Step 5 of 5**\n\nPlease pay *₹${REQUEST_FEE}* to VPA: \`${BOT_ADMIN_VPA}\`.`);
             console.error(`Error: UPI QR Code not found at ${UPI_QR_CODE_PATH}`);
        }
        
        await sendTypingAction(ctx);
        await ctx.replyWithMarkdown("💳 After successful payment, please send the **payment screenshot** to this chat to complete your request.");
        await sendTypingAction(ctx);
        return ctx.replyWithMarkdown("⚠️ **Important:** Payment must be completed within 7 days before 11:59 PM IST, or the fee may be subject to change.");
    }
    
    // --- Step 5: Collect Payment Screenshot and Notify Admin (awaiting_payment_screenshot) ---
    if (state?.state === "awaiting_payment_screenshot") {
        await sendTypingAction(ctx);
        state.data.paymentScreenshotFileId = fileId;
        
        await ctx.reply("✅ Payment screenshot received. Your request has been submitted for admin review! You will be notified of the result shortly.");
        
        const requestData = state.data;
        const refId = `REQ${Date.now()}`;
        
        pendingCardRequests[refId] = {
            userId,
            userName: requestData.requestName,
            userPhone: requestData.requestPhone,
            refundUpi: requestData.requestUpiId,
        };
        
        const notificationText = `🔔 *NEW CUSTOM CARD REQUEST* 🔔\nRef ID: \`${refId}\`\nFrom: **${ctx.from.first_name}** (@${ctx.from.username || "N/A"})\nUser ID: \`${userId}\`\n\n--- *Details* ---\nName: **${requestData.requestName}**\nPhone: \`${requestData.requestPhone}\`\nRefund UPI: \`${requestData.requestUpiId}\``;
        const adminKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Grant Request", `admin_grant:${userId}:${refId}`), Markup.button.callback("❌ Decline Request", `admin_decline:${userId}:${refId}`)]
        ]);
        
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, notificationText, { parse_mode: 'Markdown' });
        try {
            await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, requestData.requestImageFileId, { caption: `[${refId}] User's desired card image.` });
            await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, fileId, { caption: `[${refId}] User's payment screenshot.` });
        } catch (e) {
            await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Failed to forward images for \`${refId}\`. Error: ${e.message}`);
        }
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `*Admin Action for Ref ID \`${refId}\`*:`, { parse_mode: 'Markdown', ...adminKeyboard });
        
        delete userStates[userId];
    }
});


// === Handle Contact Messages (Updated for flow steps) ===
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id;
  const contact = ctx.message.contact;

  if (contact && userStates[userId]?.state === "awaiting_request_phone") {
      await sendTypingAction(ctx);
      userStates[userId].data.requestPhone = contact.phone_number.replace(/\D/g, "").slice(-10); 
      userStates[userId].state = "awaiting_request_upi_refund";
      
      return ctx.replyWithMarkdown(
          `✅ Phone received: \`${userStates[userId].data.requestPhone}\`\n\n**Step 3 of 5**\n\nPlease enter your **UPI ID**. This will be used for a refund in case your request is declined.`,
          Markup.removeKeyboard()
      );
  }
  
  if (contact && userStates[userId]?.state === "awaiting_contact") {
    const { potentialPhoneNumber, potentialName } = userStates[userId].data || {};
    userStates[userId].state = null;
    const normalizedNumber = contact.phone_number.replace(/\D/g, "").slice(-10);
    
    if (normalizedNumber === potentialPhoneNumber && AUTHORIZED_USERS_MAP[normalizedNumber]) {
      userStates[userId].data.matchedName = potentialName;
      userStates[userId].data.matchedPhone = normalizedNumber;
      await sendTypingAction(ctx);
      await ctx.reply("🔐 Authenticating...");
      await new Promise((r) => setTimeout(r, 1000));
      
      await ctx.replyWithMarkdown(`As per matches found, are you *${potentialName}*?`, 
        Markup.inlineKeyboard([
          [Markup.button.callback("Yes, that's me!", "confirm_yes")],
          [Markup.button.callback("No, that's not me", "confirm_no")]
        ])
      );
    } else {
      await ctx.reply("🚫 Contact does not match the secret word. Authorization failed.");
    }
  } else if (contact) {
      await ctx.reply("Please continue with the current flow or send your unique trigger word again.");
  }
});


// === Handle Text Messages (Core Logic) ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();
  const currentState = userStates[userId]?.state;

  if (lowerText.startsWith('/')) { // Command handling is separate from flow text
      if (lowerText === '/start') return bot.start(ctx);
      if (lowerText === '/reset') {
          delete userStates[userId];
          await ctx.replyWithMarkdown("🧹 **Session reset!** You can start over.", Markup.removeKeyboard());
          return bot.start(ctx);
      }
      
      if (lowerText === '/request') {
          userStates[userId] = { state: "awaiting_request_name", data: {} };
          return ctx.replyWithMarkdown("📝 **Custom Request Form: Step 1 of 5**\n\nPlease reply with your **Full Name**.", Markup.removeKeyboard());
      }

      // --- ADMIN COMMANDS ---
      if (userId === ADMIN_CHAT_ID) {
          if (lowerText === '/redeploy') return adminRedeployService(ctx);
          if (lowerText === '/show') { /* ... /show logic ... */ }
          if (lowerText.startsWith('/add')) { /* ... /add logic ... */ }
          if (lowerText.startsWith('/remove')) { /* ... /remove logic ... */ }
          if (lowerText.startsWith('/revoke') || lowerText.startsWith('/allow')) { /* ... /revoke or /allow logic ... */ }
          // The admin command implementations are long, so they are collapsed here for brevity.
          // They are the same as in your original file.
      }
      // If we are here, it's a command that didn't match, so we can fall through.
  }

  // --- Handle Request Form Collection (Text steps) ---
  if (currentState === "awaiting_request_name") {
      userStates[userId].data.requestName = text;
      userStates[userId].state = "awaiting_request_phone";
      const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize();
      return ctx.replyWithMarkdown(`✅ Name: *${text}*\n\n**Step 2 of 5**\n\nPlease share your **Phone Number**.`, contactButton);
  }
  
  if (currentState === "awaiting_request_phone") {
      const normalizedPhone = text.replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(normalizedPhone)) {
          return ctx.reply("❌ Invalid phone number. Please enter a valid number.");
      }
      userStates[userId].data.requestPhone = normalizedPhone.slice(-10);
      userStates[userId].state = "awaiting_request_upi_refund";
      return ctx.replyWithMarkdown(`✅ Phone: \`${userStates[userId].data.requestPhone}\`\n\n**Step 3 of 5**\n\nPlease enter your **UPI ID** for potential refunds.`, Markup.removeKeyboard());
  }
  
  if (currentState === "awaiting_request_upi_refund") {
      if (!isValidUpiId(text)) {
          return ctx.reply("❌ Invalid UPI ID. Format should be `name@bank`. Try again.");
      }
      userStates[userId].data.requestUpiId = text;
      userStates[userId].state = "awaiting_request_image";
      return ctx.replyWithMarkdown(`✅ UPI ID: \`${text}\`\n\n**Step 4 of 5**\n\nPlease send the **Image** for the card.`);
  }

  // --- Handle Ongoing User Flows (excluding request form text steps handled above) ---
  if (currentState === "awaiting_upi") { /* ... existing gift UPI logic ... */ }
  if (currentState === "awaiting_contact") return ctx.reply('Please use the "Share Contact" button.');
  if (currentState === "spinning") return ctx.reply('Please wait, the gift selection is in progress... 🧐');

  // --- Handle Dynamic Trigger Message flow (User flow) ---
  let matchedUser = null;
  for (const [phone, data] of Object.entries(AUTHORIZED_USERS_MAP)) {
      if (data.trigger_word?.toLowerCase() === lowerText) {
          matchedUser = { phone, data };
          break;
      }
  }

  if (matchedUser) {
      await ctx.reply("🔍 Secret word accepted. Checking database...");
      userStates[userId] = { state: "awaiting_contact", data: { potentialPhoneNumber: matchedUser.phone, potentialName: matchedUser.data.name } };
      const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize();
      return ctx.replyWithMarkdown(`Hello! Please share your phone number to continue verification:`, contactButton);
  }

  // --- Generic Fallback: Only if not a command and not in a flow ---
  if (!lowerText.startsWith('/') && !currentState) {
    // This block is now only reached if the text is not a trigger word, not part of a flow, and not a command.
  }
});

// === Handle "Yes" Confirmation Button ===
bot.action('confirm_yes', async (ctx) => {
    const { matchedName } = userStates[ctx.from.id]?.data || {};
    await ctx.editMessageText(`✅ Identity confirmed for *${matchedName || 'user'}*! Preparing your card...`, { parse_mode: 'Markdown' });
    // ... rest of the original sticker and card sending logic ...
});

// === Other actions (confirm_no, ratings, gift flow, info buttons) remain the same ===
// ... All your other existing bot.action handlers for 'confirm_no', 'rating_*', 'gift_yes', 'gift_no', etc.
// are assumed to be here and are unchanged.

// === Main startup function ===
async function main() {
    if (!GITHUB_TOKEN) console.warn("⚠️ GITHUB_TOKEN not set. GitHub updates disabled.");
    if (!RENDER_DEPLOY_HOOK) console.warn("⚠️ RENDER_DEPLOY_HOOK not set. Redeploy disabled.");

    try {
        await bot.telegram.setWebhook(''); 
        await bot.telegram.getUpdates(0, 100, -1);
        console.log("Cleanup complete: Webhook cleared and pending updates consumed.");
    } catch (e) {
        console.warn("⚠️ Cleanup failed, proceeding. Error:", e.message);
    }

    await loadAuthorizedUsers();
    bot.launch();
    console.log("🤖 Bot is running...");
    
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main();
