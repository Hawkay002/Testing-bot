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
const GITHUB_TOKEN = process.env.BOT_TOKEN; // Required for file updates
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

// === REQUEST MANAGEMENT CONSTANTS ===
const ADMIN_NOTIFICATION_TOKEN = process.env.ADMIN_NOTIFICATION_TOKEN; // Token for the bot receiving request logs
const UPI_QR_CODE_PATH = "upi_qr_code.png"; // Placeholder path for QR code image
const REQUEST_FEE = 50; // Standard fee for custom card requests

// === Global State Storage ===
// Structure: { "phoneNumber": { name: "User Name", trigger_word: "unique_word", can_claim_gift: boolean } }
let AUTHORIZED_USERS_MAP = {};
let GITHUB_FILE_SHA = null; 

// user_id -> { state: "awaiting_...", data: { ... } }
const userStates = {}; 
const pendingGifts = {}; 
const redirectLinkStore = {}; 
const finalConfirmationMap = {};

// NEW: Global state tracking for pending custom card requests waiting for admin decision
// refId -> { userId: number, name: string, phone: string, trigger: string, delivery: string, upi: string, imageId: string, screenshotId: string, timestamp: number, userTgName: string }
const PENDING_REQUESTS = {}; 

// NEW: Global state tracking for admin workflow (for decline comment)
// adminId -> { state: "awaiting_decline_comment", refId: string }
const ADMIN_FLOW_STATES = {};


const ADMIN_CHAT_ID = 1299129410; // Your Telegram User ID
const START_TIME = Date.now();
const BOT_ADMIN_VPA = "8777845713@upi"; 

// === Create bot instance ===
const bot = new Telegraf(TOKEN);

// === Initialize secondary bot (if token is set) ===
let adminNotificationBot = null;
if (ADMIN_NOTIFICATION_TOKEN) {
    adminNotificationBot = new Telegraf(ADMIN_NOTIFICATION_TOKEN);
    console.log("Secondary notification bot initialized.");
} else {
    console.warn("⚠️ WARNING: ADMIN_NOTIFICATION_TOKEN is not set. Request logging will be handled by the main bot.");
}


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

// === Function to update the file content on GitHub ===
async function updateAuthorizedUsersOnGithub(newContent, committerName, committerEmail, commitMessage) {
    if (!GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN environment variable is not set.");
    }
    if (!GITHUB_FILE_SHA) {
        throw new Error("Current file SHA is unknown. Cannot perform update.");
    }
    
    // 1. Clean up the content for the GitHub file before saving.
    const contentToCommit = {};
    for (const [phone, userData] of Object.entries(newContent)) {
        const cleanedUserData = { ...userData };
        if (cleanedUserData.matchedPhone) { delete cleanedUserData.matchedPhone; }

        if (cleanedUserData.can_claim_gift === true) {
            delete cleanedUserData.can_claim_gift; // Only save 'false' explicitly
        } 
        contentToCommit[phone] = cleanedUserData;
    }
    
    // Base64 encode the new JSON content
    const contentEncoded = Buffer.from(JSON.stringify(contentToCommit, null, 2)).toString('base64');
    
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;

    const payload = {
        message: commitMessage, 
        content: contentEncoded,
        sha: GITHUB_FILE_SHA, 
        committer: {
            name: committerName,
            email: committerEmail || 'telegram-bot@hawkay.com'
        }
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
        const response = await fetch(RENDER_DEPLOY_HOOK, {
            method: 'POST',
        });

        if (response.ok) {
            await ctx.reply("✅ Deploy hook successfully triggered! Render should now be building and restarting the service. This may take 1-3 minutes.");
            console.log("Render redeploy triggered successfully.");
        } else {
            const errorText = await response.text();
            await ctx.reply(`❌ Failed to trigger deploy hook. Status: ${response.status}. Error: ${errorText}`);
            console.error(`Render redeploy failed: ${response.status} - ${errorText}`);
        }
    } catch (error) {
        console.error("Error during redeploy fetch:", error);
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

// === Admin Search Helper Function ===
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
    if (upiLink) {
        res.redirect(302, upiLink);
    } else {
        res.status(404).send('Link expired or not found.');
    }
});
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
  // Do not respond to /start if the user is in the middle of a request flow
  if (userStates[ctx.from.id]?.state?.startsWith("awaiting_request_")) {
      return ctx.reply("You are currently filling out a custom request form. Send `/reset` if you wish to exit the form.");
  }
  await ctx.reply("Hi! Send your unique secret word you just copied to get your personalized card! ❤️❤️❤️");
});

// === Handle Deletion Action (Unchanged) ===
bot.action(/^admin_delete:/, async (ctx) => {
    const userId = ctx.from.id;
    if (userId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }
    
    const phoneToDelete = ctx.match.input.split(':')[1];
    
    // Clear the message to show processing
    await ctx.editMessageText(`⏳ Attempting to delete user with phone number: \`${phoneToDelete}\`...`);
    
    if (!AUTHORIZED_USERS_MAP[phoneToDelete]) {
        return ctx.editMessageText(`❌ Error: User with phone number \`${phoneToDelete}\` not found in the current list.`, { parse_mode: 'Markdown' });
    }

    const userName = AUTHORIZED_USERS_MAP[phoneToDelete].name;
    
    try {
        // 1. Prepare new data structure (delete the property)
        const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
        delete newAuthorizedUsers[phoneToDelete];
        
        // 2. Update the file on GitHub
        const committerEmail = ctx.from.username ? `${ctx.from.username}@telegram.org` : 'admin@telegram.org';
        const commitMessage = `feat(bot): Remove user ${userName} (${phoneToDelete}) via Telegram`;

        await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, committerEmail, commitMessage);
        
        // 3. Update the local map immediately
        AUTHORIZED_USERS_MAP = newAuthorizedUsers;
        
        // 4. Clean up state
        // Deletion state logic is minimal/obsolete but kept to avoid breaking original flow if any
        
        await ctx.editMessageText(`✅ User **${userName}** (\`${phoneToDelete}\`) successfully removed from the authorized list and committed to GitHub!`, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error("GitHub Deletion Error:", error);
        await ctx.editMessageText(`❌ Failed to remove user **${userName}**: ${error.message}. Please check logs and GitHub status.`, { parse_mode: 'Markdown' });
    }
});

// === Handle Gift Eligibility Management Actions (Unchanged) ===
bot.action(/^admin_gift_manage:/, async (ctx) => {
    const userId = ctx.from.id;
    if (userId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }
    
    const [actionType, phone] = ctx.match.input.split(':').slice(1); // 'revoke' or 'allow', then phone number
    const isRevoke = actionType === 'revoke';

    await ctx.editMessageText(`⏳ Attempting to ${isRevoke ? 'REVOKE' : 'ALLOW'} gift eligibility for \`${phone}\`...`);
    
    if (!AUTHORIZED_USERS_MAP[phone]) {
        return ctx.editMessageText(`❌ Error: User with phone number \`${phone}\` not found in the current list.`, { parse_mode: 'Markdown' });
    }

    const userName = AUTHORIZED_USERS_MAP[phone].name;
    const newStatus = !isRevoke; // false for revoke, true for allow
    
    try {
        // 1. Prepare new data structure (update the property)
        const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
        newAuthorizedUsers[phone] = {
            ...newAuthorizedUsers[phone],
            can_claim_gift: newStatus // Set to true for allow, false for revoke
        };
        
        // 2. Update the file on GitHub
        const committerEmail = ctx.from.username ? `${ctx.from.username}@telegram.org` : 'admin@telegram.org';
        const statusText = newStatus ? 'allowed' : 'revoked';
        const commitMessage = `feat(bot): Gift eligibility ${statusText} for ${userName} (${phone}) via Telegram`;

        await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, committerEmail, commitMessage);
        
        // 3. Update the local map immediately
        AUTHORIZED_USERS_MAP = newAuthorizedUsers;
        
        // 4. Clean up state
        // Gift management state logic is minimal/obsolete but kept to avoid breaking original flow if any
        
        await ctx.editMessageText(`✅ Gift eligibility for **${userName}** (\`${phone}\`) has been **${statusText.toUpperCase()}** and committed to GitHub!`, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error("GitHub Gift Management Error:", error);
        await ctx.editMessageText(`❌ Failed to update gift status for **${userName}**: ${error.message}. Please check logs and GitHub status.`, { parse_mode: 'Markdown' });
    }
});

// === NEW ADMIN ACTION: Grant Request (Autofill /add) ===
bot.action(/^admin_grant_request:/, async (ctx) => {
    const adminId = ctx.from.id;
    if (adminId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }

    const [, targetUserIdStr, refId] = ctx.match.input.split(':');
    const targetUserId = parseInt(targetUserIdStr);
    const requestData = PENDING_REQUESTS[refId];

    if (!requestData) {
        return ctx.editMessageText(`❌ Error: Request ${refId} not found or already processed.`, { parse_mode: 'Markdown' });
    }
    
    // Generate a random trigger word
    const triggerWord = Math.random().toString(36).substring(2, 8).toUpperCase(); 
    
    // Construct the autofilled /add command
    // Format: /add <10-digit phone>, <Full Name>, <unique_trigger>
    const addCommand = `/add ${requestData.phone}, ${requestData.name}, ${triggerWord}`;

    // 1. Acknowledge and notify user
    await ctx.editMessageText(`✅ Request ${refId} granted. Notifying user with trigger word: \`${triggerWord}\`.`);

    try {
        await ctx.telegram.sendMessage(
            targetUserId,
            `🎉 **SUCCESS!** Your custom card request for **${requestData.name}** to be ready on *${requestData.delivery}* has been approved and the payment verified.
            
Your **unique secret word** to start the bot flow is:
\`${triggerWord}\`

_Please use the /start command or enter your word to begin the card verification process!_`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
         console.error(`Error notifying user ${targetUserId}:`, error.message);
         await ctx.reply(`❌ Failed to send trigger word to user ${targetUserId}. They may have blocked the bot.`);
    }

    // 2. Inform the admin about the next crucial step with autofilled command
    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🚨 **ACTION REQUIRED** 🚨
        
User **${requestData.name}** (\`${targetUserId}\`) has been notified their secret word is **\`${triggerWord}\`**.
        
You must now add this user to \`authorized_users.json\` using the command below:
\`${addCommand}\`
        
_Please copy and paste the command above to complete the process._`,
        { parse_mode: 'Markdown' }
    );
    
    // 3. Clean up request state
    delete PENDING_REQUESTS[refId];
});

// === NEW ADMIN ACTION: Initialize Decline Comment Flow ===
bot.action(/^admin_init_decline:/, async (ctx) => {
    const adminId = ctx.from.id;
    if (adminId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }

    const [, targetUserIdStr, refId] = ctx.match.input.split(':');
    const requestData = PENDING_REQUESTS[refId];

    if (!requestData) {
        return ctx.editMessageText(`❌ Error: Request ${refId} not found or already processed.`, { parse_mode: 'Markdown' });
    }
    
    await ctx.editMessageText(`❌ Declining request ${refId} from **${requestData.name}**. Please reply to this chat with your rejection reason (optional).`);
    
    await ctx.replyWithMarkdown("To skip the comment and send the refund notice immediately, send the command `/skip`.");

    // Set admin state to capture the next message as the comment
    ADMIN_FLOW_STATES[adminId] = { 
        state: "awaiting_decline_comment", 
        refId: refId,
        targetUserId: parseInt(targetUserIdStr),
        userUpi: requestData.upi,
        userName: requestData.name
    };
});

// === Handle Photo/Document Messages (Image Collection & Payment Screenshot) ===
bot.on(['photo', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    const isPhoto = ctx.message.photo;
    const isDocument = ctx.message.document;
    
    let fileId = null;
    let caption = ctx.message.caption;
    let mimeType = null;

    if (isPhoto) {
        fileId = isPhoto[isPhoto.length - 1].file_id;
        mimeType = 'image/jpeg';
    } else if (isDocument && isDocument.mime_type?.startsWith('image')) {
        fileId = isDocument.file_id;
        mimeType = isDocument.mime_type;
    } else {
        // Ignore non-image documents
        return;
    }

    const state = userStates[userId];
    
    // --- Step 5: Collect Card Image (awaiting_request_image) ---
    if (state?.state === "awaiting_request_image") {
        await sendTypingAction(ctx);
        state.data.requestImageFileId = fileId;
        state.data.requestImageCaption = caption || 'No caption provided';
        state.data.requestImageMime = mimeType;
        state.state = "awaiting_request_upi_refund"; // Next: Ask for UPI ID
        
        return ctx.replyWithMarkdown(
            "✅ Image received. **Step 6 of 6**\n\nFinally, for payment refund safety, please reply with your *UPI ID* (e.g., `user.123@ybl`). This is where we'll refund the fee if the request is declined."
        );
    }
    
    // --- Final Step: Collect Payment Screenshot (awaiting_payment_screenshot) ---
    if (state?.state === "awaiting_payment_screenshot") {
        await sendTypingAction(ctx);
        state.data.paymentScreenshotFileId = fileId;
        
        await ctx.reply("✅ Payment screenshot received. Your request is now being reviewed! Please wait for admin confirmation (up to 24 hours).");
        
        const requestData = state.data;
        const refId = `REQ${Date.now()}`;
        
        // 1. Save data to PENDING_REQUESTS
        PENDING_REQUESTS[refId] = {
            userId: userId,
            name: requestData.requestName,
            phone: requestData.requestPhone,
            trigger: requestData.requestTrigger,
            delivery: requestData.requestDelivery,
            upi: requestData.requestUpiId,
            imageId: requestData.requestImageFileId,
            screenshotId: fileId,
            timestamp: Date.now(),
            userTgName: ctx.from.first_name + (ctx.from.username ? ` (@${ctx.from.username})` : '')
        };

        // 2. Clear user state
        delete userStates[userId];
        
        // 3. Log all collected data in the admin chat
        const notificationText = `
🔔 *NEW CUSTOM CARD REQUEST PENDING* 🔔
Ref ID: \`${refId}\`
User: **${PENDING_REQUESTS[refId].userTgName}** (ID: \`${userId}\`)
Name: **${requestData.requestName}**
Phone: \`${requestData.requestPhone}\`
Trigger: \`${requestData.requestTrigger}\`
Delivery: *${requestData.requestDelivery}*
Refund UPI: \`${requestData.requestUpiId}\`
Fee Paid: ₹${REQUEST_FEE}
        `;
        
        // Admin buttons: Grant AND Decline
        const adminKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Grant Request", `admin_grant_request:${userId}:${refId}`)],
            [Markup.button.callback("❌ Decline Request", `admin_init_decline:${userId}:${refId}`)]
        ]);
        
        // Send text notification to main admin chat (for the button and logs)
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, notificationText, { parse_mode: 'Markdown', ...adminKeyboard });
        
        // Send the files to the admin chat ID (using the MAIN bot)
        try {
            // Send Card Image
            await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, requestData.requestImageFileId, {
                caption: `[REQ ${refId}] - User Card Image (Quality Check)`,
                parse_mode: 'Markdown'
            });
            
            // Send Payment Screenshot
            await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, fileId, {
                caption: `[REQ ${refId}] - Payment Screenshot`,
                parse_mode: 'Markdown'
            });

        } catch (error) {
             console.error("❌ Failed to forward request files to admin chat:", error.message);
             await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Warning: Failed to forward files for REQ ${refId}. Check File IDs manually. Error: ${error.message}`);
        }

        return;
    }
});


// === Handle Contact Messages (Updated for flow steps) ===
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id;
  const contact = ctx.message.contact;

  // --- Step 2: Handle Request Phone Collection via Contact Share (REQUEST FLOW) ---
  if (contact && userStates[userId]?.state === "awaiting_request_phone") {
      await sendTypingAction(ctx);
      // Store last 10 digits as normalized phone number
      userStates[userId].data.requestPhone = contact.phone_number.replace(/\D/g, "").slice(-10); 
      userStates[userId].state = "awaiting_request_trigger"; // Next state
      
      return ctx.replyWithMarkdown(
          `✅ Phone received: \`${userStates[userId].data.requestPhone}\`\n\n**Step 3 of 6**\n\nPlease reply with a short, unique **Trigger Word** (alphanumeric/simple text) for the recipient to use.`,
          Markup.removeKeyboard() // Remove the contact keyboard
      );
  }
  
  // --- EXISTING FLOW: User Verification (Unchanged) ---
  if (contact && userStates[userId]?.state === "awaiting_contact") {
    const { potentialPhoneNumber, potentialName } = userStates[userId].data || {};

    userStates[userId].state = null;
    
    // Normalize the user's phone number: remove all non-digits and take the last 10 digits
    const userNumberRaw = contact.phone_number.replace(/\D/g, "");
    const normalizedNumber = userNumberRaw.slice(-10);
    
    const isVerificationSuccessful = (
        normalizedNumber === potentialPhoneNumber && 
        AUTHORIZED_USERS_MAP[normalizedNumber]
    );

    if (isVerificationSuccessful) {
      userStates[userId].data.matchedName = potentialName;
      userStates[userId].data.matchedPhone = normalizedNumber; // Store phone for gift check later
      
      await sendTypingAction(ctx);
      await ctx.reply("📞 Checking back with your number...");
      await new Promise((r) => setTimeout(r, 1000));
      
      await sendTypingAction(ctx);
      await ctx.reply("🔐 Authenticating...");
      await new Promise((r) => setTimeout(r, 1000));
      
      const confirmationKeyboard = Markup.inlineKeyboard([
          Markup.button.callback("Yes, that's me!", "confirm_yes"),
          Markup.button.callback("No, that's not me", "confirm_no")
      ]);

      await sendTypingAction(ctx);
      await ctx.replyWithMarkdown(
        `As per matches found in database, are you *${potentialName}*?`,
        confirmationKeyboard
      );
    } else {
      await sendTypingAction(ctx);
      await ctx.reply("🚫 Sorry! The shared contact number does not match the person associated with the secret word. Authorization failed.");
    }
  } else if (contact) {
      // Generic contact share outside of a flow
      await sendTypingAction(ctx);
      await ctx.reply("I already have your contact, please continue with the flow or send your unique trigger word again.");
  }
});


// === Handle Text Messages (Core Logic) ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();

  const currentState = userStates[userId]?.state;
  const isCommand = lowerText.startsWith('/');
  
  // --- ADMIN DECLINE COMMENT CAPTURE ---
  const adminFlowState = ADMIN_FLOW_STATES[userId];
  if (userId === ADMIN_CHAT_ID && adminFlowState?.state === "awaiting_decline_comment") {
    
    const { refId, targetUserId, userUpi, userName } = adminFlowState;
    const isSkip = lowerText === '/skip';
    const comment = isSkip ? "" : text;
    
    await ctx.reply(`⏳ Notifying user **${userName}** and preparing refund notice for REQ ${refId}...`);

    try {
        let declineMessage = `⚠️ **Request Declined** ⚠️
Thank you for submitting your custom card request. Unfortunately, we are unable to fulfill this request at this time.`;

        if (comment) {
            declineMessage += `\n\n**Reason:** ${comment}`;
        }

        declineMessage += `\n\nYour fee of *₹${REQUEST_FEE}* will be **refunded** to your provided UPI ID (\`${userUpi}\`) within **24 hours or less**. We apologize for the inconvenience!`;

        await ctx.telegram.sendMessage(targetUserId, declineMessage, { parse_mode: 'Markdown' });
        
        await ctx.replyWithMarkdown(
            `✅ Decline notification sent to user (\`${targetUserId}\`).
            
🚨 **ACTION REQUIRED** 🚨
You **MUST** manually initiate the refund of *₹${REQUEST_FEE}* to UPI: \`${userUpi}\`.`
        );

    } catch (error) {
         console.error(`Error notifying user ${targetUserId} of decline:`, error.message);
         await ctx.reply(`❌ Failed to send decline notification to user ${targetUserId}. You need to contact them manually.`);
    }

    // Clean up state
    // PENDING_REQUESTS[refId] should already be gone or be ignored by the grant action after this.
    // However, to be safe:
    if(PENDING_REQUESTS[refId]) delete PENDING_REQUESTS[refId]; 
    delete ADMIN_FLOW_STATES[userId];
    return;
  }
  
  // --- USER COMMAND: /reset ---
  if (lowerText === '/reset') {
      await sendTypingAction(ctx);
      delete userStates[userId];
      
      await ctx.replyWithMarkdown(
          "🧹 **Memory cleared!** Your current session has been reset. You can now start over.",
          Markup.removeKeyboard()
      );
      return bot.start(ctx);
  }
  
  // --- USER COMMAND: /request (INITIATION) ---
  if (lowerText === '/request') {
      await sendTypingAction(ctx);
      
      // Start the multi-step request form
      userStates[userId] = { 
          state: "awaiting_request_name", 
          data: {} 
      };

      return ctx.replyWithMarkdown(
          "📝 **Custom Request Form: Step 1 of 6**\n\nPlease reply with the **Full Name** you want on the card.",
          Markup.removeKeyboard()
      );
  }

  // --- 1. Awaiting Name (REQUEST FLOW STEP 1) ---
  if (currentState === "awaiting_request_name") {
      await sendTypingAction(ctx);
      userStates[userId].data.requestName = text;
      userStates[userId].state = "awaiting_request_phone"; // Next: Ask for contact

      const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]])
          .oneTime()
          .resize();

      return ctx.replyWithMarkdown(
          `✅ Name received: *${text}*\n\n**Step 2 of 6**\n\nPlease share your **Phone Number** (use the button below). This is for verification.`,
          contactButton
      );
  }

  // Awaiting Phone is handled by bot.on('contact')

  // --- 2. Awaiting Trigger Word (REQUEST FLOW STEP 3) ---
  if (currentState === "awaiting_request_trigger") {
      await sendTypingAction(ctx);
      const triggerWord = text.trim();

      if (triggerWord.length < 3) {
          return ctx.reply("❌ Trigger word must be at least 3 characters long. Please try a different word.");
      }
      
      // Check for uniqueness across the current AUTHORIZED_USERS_MAP
      if (Object.values(AUTHORIZED_USERS_MAP).some(user => user.trigger_word.toLowerCase() === triggerWord.toLowerCase())) {
          return ctx.reply(`❌ Trigger word **\`${triggerWord}\`** is already in use by an authorized user. Please choose a unique word.`);
      }

      userStates[userId].data.requestTrigger = triggerWord;
      userStates[userId].state = "awaiting_request_delivery"; // Next: Ask for delivery date/time

      return ctx.replyWithMarkdown(
          `✅ Trigger word received: \`${triggerWord}\`\n\n**Step 4 of 6**\n\nPlease reply with the **exact date and time** (with timezone, e.g., 2025-05-15 10:00 PM IST) you need the bot to be ready for activation.`,
          Markup.removeKeyboard()
      );
  }

  // --- 3. Awaiting Delivery Date/Time (REQUEST FLOW STEP 4) ---
  if (currentState === "awaiting_request_delivery") {
      await sendTypingAction(ctx);
      userStates[userId].data.requestDelivery = text;
      userStates[userId].state = "awaiting_request_image"; // Next: Ask for image (handled by photo listener)

      return ctx.replyWithMarkdown(
          `✅ Delivery time received: *${text}*\n\n**Step 5 of 6**\n\nPlease send the **Image** you want on the card (check for **HD quality** for better output).`
      );
  }
  
  // Awaiting Image is handled by bot.on(['photo', 'document'])

  // --- 4. Awaiting UPI ID (REQUEST FLOW STEP 6) ---
  if (currentState === "awaiting_request_upi_refund") {
      await sendTypingAction(ctx);
      const upiId = text.trim();

      if (!isValidUpiId(upiId)) {
          return ctx.reply("❌ Invalid UPI ID format. Please make sure it looks like `name@bank` (e.g., `user.123@ybl`) and try again.");
      }
      
      userStates[userId].data.requestUpiId = upiId;
      userStates[userId].state = "awaiting_payment_screenshot"; // Next: Wait for payment SS (handled by photo listener)
      
      // --- Final Payment Prompt ---
      await ctx.reply("✅ UPI ID received. Proceeding to final payment step...");

      // Send UPI QR Code and payment instructions
      await sendTypingAction(ctx);
      if (fs.existsSync(UPI_QR_CODE_PATH)) {
          await ctx.replyWithPhoto({ source: UPI_QR_CODE_PATH }, {
              caption: `💰 **Payment Required**\n\nPlease pay a standard fee of *₹${REQUEST_FEE}* for custom card design requests. Pay via the QR code above or VPA: \`${BOT_ADMIN_VPA}\`.`,
              parse_mode: 'Markdown'
          });
      } else {
           await ctx.replyWithMarkdown(
              `💰 **Payment Required**\n\nTo proceed with your custom card, please pay the standard fee of *₹${REQUEST_FEE}* to VPA: \`${BOT_ADMIN_VPA}\`.`
           );
           console.error(`Error: UPI QR Code not found at ${UPI_QR_CODE_PATH}`);
      }
      
      await sendTypingAction(ctx);
      return ctx.replyWithMarkdown(
          "💳 Once payment is successful, please reply to this chat with the **screenshot of your payment**.\n\n⚠️ **Payment has to be done within 7 days before 11:59pm IST or the fee will be increased later.**"
      );
  }
  
  // Awaiting Payment Screenshot is handled by bot.on(['photo', 'document'])


  // --- 5. Handle Admin Commands (Must handle all admin commands here) ---
  if (userId === ADMIN_CHAT_ID) {
      
      // --- ADMIN COMMAND: /redeploy ---
      if (lowerText === '/redeploy') { return adminRedeployService(ctx); }

      // --- ADMIN COMMAND: /show ---
      if (lowerText === '/show') {
          await sendTypingAction(ctx);
          if (Object.keys(AUTHORIZED_USERS_MAP).length === 0) {
              return ctx.reply("The authorized user list is currently empty.");
          }
          
          const userList = Object.entries(AUTHORIZED_USERS_MAP)
              .map(([phone, data], index) => {
                  const giftStatus = data.can_claim_gift ? '✅' : '🚫';
                  return `${index + 1}. ${giftStatus} *${data.name}* (\`${phone}\`) -> \`${data.trigger_word}\``;
              })
              .join('\n');
          
          const header = `👤 *Authorized Users List* (${Object.keys(AUTHORIZED_USERS_MAP).length} total):\n\n`;
          
          if (userList.length + header.length > 4096) {
              await ctx.replyWithMarkdown(header + "List is too long, displaying partial content...");
              const maxChunkSize = 3500;
              for (let i = 0; i < userList.length; i += maxChunkSize) {
                  await ctx.replyWithMarkdown(userList.substring(i, i + maxChunkSize));
              }
          } else {
              await ctx.replyWithMarkdown(header + userList);
          }

          return;
      }

      // --- ADMIN COMMAND: /add ---
      if (lowerText.startsWith('/add')) {
          await sendTypingAction(ctx);
          const parts = text.slice('/add'.length).trim().split(',').map(p => p.trim());
          
          if (parts.length === 3) {
              const [phoneNumber, name, triggerWord] = parts;
              const phoneRegex = /^\d{10}$/;

              if (!phoneRegex.test(phoneNumber)) {
                  return ctx.reply("❌ Invalid phone number format. Must be 10 digits only (e.g., `9988776655`).");
              }

              if (Object.values(AUTHORIZED_USERS_MAP).some(user => user.trigger_word.toLowerCase() === triggerWord.toLowerCase())) {
                  return ctx.reply(`❌ Trigger word **\`${triggerWord}\`** is already in use. Please choose another.`);
              }
              
              if (AUTHORIZED_USERS_MAP[phoneNumber]) {
                  return ctx.reply(`⚠️ User with phone number **\`${phoneNumber}\`** already exists. Use a different number.`);
              }

              try {
                  const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
                  newAuthorizedUsers[phoneNumber] = { 
                      name: name, 
                      trigger_word: triggerWord.toLowerCase(),
                      can_claim_gift: true // Default to allowed
                  };
                  
                  const committerEmail = ctx.from.username ? `${ctx.from.username}@telegram.org` : 'admin@telegram.org';
                  const commitMessage = `feat(bot): Add new user via Telegram for ${name}`;

                  await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, committerEmail, commitMessage);
                  
                  AUTHORIZED_USERS_MAP = newAuthorizedUsers;

                  await ctx.replyWithMarkdown(`✅ User **${name}** added successfully!
Phone: \`${phoneNumber}\`
Trigger: \`${triggerWord}\`
The new list is now live. Use \`/show\` to verify.`);
                  
              } catch (error) {
                  console.error(error);
                  await ctx.replyWithMarkdown(`❌ Failed to update GitHub file: ${error.message}. Please check logs and your GITHUB_TOKEN.`);
              }
              return;
          } else {
              return ctx.replyWithMarkdown("❌ Invalid command format. Use: `/add <10-digit phone>, <Full Name>, <unique_trigger>`");
          }
      }

      // --- ADMIN COMMAND: /remove ---
      if (lowerText.startsWith('/remove')) {
          await sendTypingAction(ctx);
          const query = text.slice('/remove'.length).trim();
          
          if (!query) {
              return ctx.replyWithMarkdown("❌ Invalid command format. Use: `/remove <10-digit phone/partial name>`");
          }

          const matches = searchUsers(query);
              
          if (matches.length === 0) {
              return ctx.replyWithMarkdown(`🔍 No users found matching: **\`${query}\`**`);
          }

          let matchText = `🔍 Found *${matches.length}* user(s) matching **\`${query}\`**:\n\n`;
          let keyboardButtons = [];

          matches.forEach(([phone, data], index) => {
              const matchId = index + 1;
              const formattedName = data.name.replace(/([_*`[\]()])/g, '\\$1'); 
              
              matchText += `${matchId}. Name: *${formattedName}*\n   Phone: \`${phone}\`\n   Trigger: \`${data.trigger_word}\`\n\n`;
              
              keyboardButtons.push(Markup.button.callback(`Remove ${matchId} (${data.name})`, `admin_delete:${phone}`));
          });
          
          const rows = keyboardButtons.map(btn => [btn]);
          
          await ctx.replyWithMarkdown(
              matchText + "⚠️ *Select a user to permanently REMOVE them from the authorized list. This action is irreversible.*", 
              Markup.inlineKeyboard(rows)
          );
          
          return;
      }

      // --- ADMIN COMMAND: /revoke or /allow ---
      if (lowerText.startsWith('/revoke') || lowerText.startsWith('/allow')) {
          await sendTypingAction(ctx);
          const command = lowerText.startsWith('/revoke') ? 'revoke' : 'allow';
          const query = text.slice(`/${command}`.length).trim();

          if (!query) {
              return ctx.replyWithMarkdown(`❌ Invalid command format. Use: \`/${command} <10-digit phone/partial name>\``);
          }

          const matches = searchUsers(query);
              
          if (matches.length === 0) {
              return ctx.replyWithMarkdown(`🔍 No users found matching: **\`${query}\`**`);
          }

          let matchText = `🔍 Found *${matches.length}* user(s) matching **\`${query}\`**:\n\n`;
          let keyboardButtons = [];

          matches.forEach(([phone, data], index) => {
              const matchId = index + 1;
              const formattedName = data.name.replace(/([_*`[\]()])/g, '\\$1'); 
              const currentStatus = data.can_claim_gift ? '✅ ALLOWED' : '🚫 REVOKED';
              
              matchText += `${matchId}. *${formattedName}* - Status: ${currentStatus}\n   Phone: \`${phone}\`\n\n`;
              
              keyboardButtons.push(Markup.button.callback(
                  `${command.toUpperCase()} ${matchId} (${data.name})`, 
                  `admin_gift_manage:${command}:${phone}`
              ));
          });
          
          const rows = keyboardButtons.map(btn => [btn]);
          
          await ctx.replyWithMarkdown(
              matchText + `🚨 *Select a user to **${command.toUpperCase()}** their gift eligibility.*`, 
              Markup.inlineKeyboard(rows)
          );
          
          return;
      }
  }


  // --- 6. Handle Trigger Word/Fallback (Unchanged) ---
  let matchedUserPhoneNumber = null;
  let matchedUserData = null;

  // Iterate through the authorized users to find a matching trigger word
  for (const [phoneNumber, userData] of Object.entries(AUTHORIZED_USERS_MAP)) {
      if (userData && userData.trigger_word && userData.trigger_word.toLowerCase() === lowerText) {
          matchedUserPhoneNumber = phoneNumber;
          matchedUserData = userData;
          break; // Found a match, stop searching
      }
  }

  if (matchedUserPhoneNumber) {
      await sendTypingAction(ctx);
      await ctx.reply("🔍 Secret word accepted. Checking database to find matches...");
      await new Promise((r) => setTimeout(r, 1000));

      userStates[userId] = { 
          state: "awaiting_contact", 
          data: { 
              potentialPhoneNumber: matchedUserPhoneNumber, 
              potentialName: matchedUserData.name
          } 
      };

      const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize();
      await sendTypingAction(ctx);
      await ctx.replyWithMarkdown(
          `Hello, mate! Please share your phone number to continue the verification process:`, 
          contactButton
      );
      return;
  }

  // Generic Fallback: Only run if the message was not a command or part of an active flow
  if (!isCommand && !currentState) {
      await sendTypingAction(ctx);
      await ctx.reply("I only respond to a specific messages.");
      
      await sendTypingAction(ctx);
      await ctx.reply("You can check out more details below 👇", getMainMenu());
  }
});


// === Handle "Yes" Confirmation Button (Original Flow - Unchanged) ===
bot.action('confirm_yes', async (ctx) => {
    const userId = ctx.from.id;
    const matchedName = userStates[userId]?.data?.matchedName || "the authorized user";
    
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
      await ctx.replyWithPhoto({ source: IMAGE_PATH }, { caption: "🎁 Your personalized card is ready — Tap to reveal!", has_spoiler: true });
    } else {
      await ctx.reply("😔 Sorry, the personalized birthday card is missing on the server.");
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

// === Handle "No" Confirmation Button (Original Flow - Unchanged) ===
bot.action('confirm_no', async (ctx) => {
    await ctx.editMessageText("🚫 Sorry! Authorization failed. Please try again or contact the administrator.");
});


// === Handle Ratings (Updated to check for gift eligibility - Unchanged) ===
bot.action(/^rating_/, async (ctx) => {
  const userId = ctx.from.id;
  const rating = ctx.match.input.split("_")[1];
  const username = ctx.from.username || ctx.from.first_name;
  const matchedPhone = userStates[userId]?.data?.matchedPhone;

  await ctx.editMessageText(`Thank you for your rating of ${rating} ⭐!`);

  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `User @${username} (ID: ${ctx.chat.id}) rated ${rating} ⭐`
  );

  await sendTypingAction(ctx);
  
  // Check if the user is eligible for the gift
  const isEligible = matchedPhone && AUTHORIZED_USERS_MAP[matchedPhone]?.can_claim_gift;
  
  if (isEligible) {
    const giftKeyboard = Markup.inlineKeyboard([
        Markup.button.callback("Yes, I want a gift! 🥳", "gift_yes"),
        Markup.button.callback("No, thank you.", "gift_no"),
    ]);

    await ctx.replyWithMarkdown(
      "That's wonderful! We have one more surprise. Would you like a *bonus mystery gift* from us 👀?",
      giftKeyboard
    );
  } else {
    // User is not eligible, skip the gift offer
    await ctx.replyWithMarkdown(
      "Thanks again for celebrating with us! We hope you enjoyed your personalized card. 😊"
    );
  }
});

// === Gift Flow Actions (Original Flow - Unchanged) ===
bot.action('gift_yes', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.editMessageText("Great choice! To send you a surprise shagun gift, we need your UPI ID (e.g., `user.123@ybl`).");
    
    await sendTypingAction(ctx);
    await ctx.replyWithMarkdown("Please reply to this chat with your valid *UPI ID*:");

    userStates[userId] = { 
        state: "awaiting_upi", 
        data: userStates[userId]?.data || { amount: null, upiId: null, matchedName: null } 
    };
});

bot.action('gift_no', async (ctx) => {
    await ctx.editMessageText("No worries! Thanks again for celebrating with us. Enjoy your personalized card! 😊");
});

bot.action('ask_for_gift', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];

    if (!state?.data.upiId || !state.data.amount) {
        return ctx.reply("Sorry, I lost track of your details. Please restart the flow from the trigger message.");
    }
    
    const { upiId, amount } = state.data;
    const refId = `BDAYGIFT${Date.now()}`; 
    const adminRef = `ADMIN_${refId}`; 

    pendingGifts[adminRef] = { userId, userUpi: upiId, amount };

    await ctx.editMessageText("⏳ Waiting for confirmation...\nThis might take a bit, so feel free to keep the chat open or close the app and carry on with your stuff.\nI’ll let you know as soon as I get the confirmation."); 
    
    const adminNotificationText = `
🚨 *NEW GIFT PAYMENT REQUIRED* 🚨

**To User (ID: \`${userId}\`):**
**Amount:** ₹${amount}
**UPI ID:** \`${upiId}\`
**Ref ID:** \`${refId}\`

Click below to initialize the payment and generate the **HTTPS Redirect Link**.
    `;

    const adminKeyboard = Markup.inlineKeyboard([
        Markup.button.callback(`🚀 Initialize Payment Link (₹${amount})`, `admin_init_pay:${adminRef}`),
    ]);

    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        adminNotificationText,
        { parse_mode: 'Markdown', ...adminKeyboard }
    );
});


bot.action(/^admin_init_pay:/, async (ctx) => {
    const adminRef = ctx.match.input.split(':')[1];
    const giftData = pendingGifts[adminRef];
    
    if (ctx.from.id !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }

    if (!giftData) {
        return ctx.editMessageText("❌ Error: Payment reference expired or not found.", { parse_mode: 'Markdown' });
    }

    const { userId, userUpi, amount } = giftData;
    const refId = adminRef.replace('ADMIN_', '');
    
    const upiLink = `upi://pay?pa=${userUpi}&am=${amount}&pn=${encodeURIComponent("Bday Gift Payee")}&tr=${refId}`;
    
    const redirectId = Math.random().toString(36).substring(2, 15);
    redirectLinkStore[redirectId] = upiLink;
    
    finalConfirmationMap[refId] = userId; 

    const httpsRedirectLink = `${BOT_PUBLIC_BASE_URL}/pay-redirect?id=${redirectId}`;

    await bot.telegram.sendMessage(
        userId,
        "✨ Payment initialization started, waiting for few minutes you'll soon receive your gift. 😊"
    );
    
    await ctx.editMessageText(
        `🔗 *Payment Link for ₹${amount}* to \`${userUpi}\`\n\n**If the button fails, copy the VPA (\`${userUpi}\`) and pay manually.**`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.url("🔥 Finalize Payment in UPI App (HTTPS) - Click to Pay", httpsRedirectLink) 
            ])
        }
    );
    
    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `✅ Payment link initiated for ₹${amount} to ${userUpi}.\n\n*Click "Payment Done" ONLY after you have successfully completed the transaction in your UPI app.*`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                Markup.button.callback("✅ Payment Done - Notify User", `payment_done:${refId}`)
            ])
        }
    );
    
    delete pendingGifts[adminRef];
});


bot.action(/^payment_done:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }
    
    const refId = ctx.match.input.split(':')[1];
    const targetUserId = finalConfirmationMap[refId];

    if (!targetUserId) {
        return ctx.editMessageText("❌ Error: Could not determine target user ID for confirmation. Reference may have expired.", { parse_mode: 'Markdown' });
    }

    await bot.telegram.sendMessage(
        targetUserId,
        "🎉 **Shagun has been sent successfully!** Please check your bank account or UPI application. We hope you enjoyed your birthday surprise! ❤️",
        { parse_mode: 'Markdown' }
    );
    
    await ctx.editMessageText(`✅ User (ID: ${targetUserId}) has been successfully notified that payment is complete for Ref ID: ${refId}.`, { parse_mode: 'Markdown' });

    delete finalConfirmationMap[refId];
});

// === Info & Socials Buttons (Original Flow - Unchanged) ===
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
    if (!GITHUB_TOKEN) {
        console.warn("⚠️ WARNING: GITHUB_TOKEN is not set. Admin GitHub update feature will NOT work.");
    }
    if (!RENDER_DEPLOY_HOOK) {
        console.warn("⚠️ WARNING: RENDER_DEPLOY_HOOK is not set. Admin /redeploy feature will NOT work.");
    }

    // Attempt to drop pending updates from the main bot to prevent 409 Conflict
    try {
        await bot.telegram.setWebhook(''); // Clear any webhook setting
        await bot.telegram.getUpdates(0, 100, -1); // Consume any pending updates
        console.log("Cleanup complete: Webhook cleared and pending updates consumed.");
    } catch (e) {
        // Log if cleanup fails but don't stop the bot start
        console.warn("⚠️ Cleanup failed, proceeding with launch. Error:", e.message);
    }

    // 1. Load data from the external GitHub source and get the current SHA
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
