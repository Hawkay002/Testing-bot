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

// === REQUEST MANAGEMENT CONSTANTS ===
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

// === Global State Tracking ===
// user_id -> { state: "awaiting_contact" | "awaiting_upi" | "spinning" | "awaiting_request_..." | "awaiting_decline_reason" | null, data: { ... } }
const userStates = {}; 
const pendingGifts = {}; 
const redirectLinkStore = {}; 
const finalConfirmationMap = {};

// Store pending custom requests for admin processing
// refId -> { userId, name, phone, trigger, date, refundUpi, cardImageId, cardImageMime, cardImageCaption, paymentScreenshotId, paymentScreenshotMime, notificationMessageId }
const pendingRequests = {};


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
                    // If can_claim_gift is explicitly set to false in the file, use it. 
                    // Otherwise, default to true.
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
    
    // 1. Clean up the content for the GitHub file before saving.
    // We only explicitly save 'can_claim_gift: false'. If it's true or undefined, we omit the key.
    const contentToCommit = {};
    for (const [phone, userData] of Object.entries(newContent)) {
        const cleanedUserData = { ...userData };
        
        // Remove runtime-only properties
        if (cleanedUserData.matchedPhone) {
            delete cleanedUserData.matchedPhone;
        }

        // If the user is allowed (true), remove the key from the saved file (since 'true' is the default)
        if (cleanedUserData.can_claim_gift === true) {
            delete cleanedUserData.can_claim_gift;
        } 
        // If the user is revoked (false), the key/value pair remains in the object.

        contentToCommit[phone] = cleanedUserData;
    }
    
    // Base64 encode the new JSON content
    const contentEncoded = Buffer.from(JSON.stringify(contentToCommit, null, 2)).toString('base64');
    
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;

    const payload = {
        message: commitMessage, // Use the provided dynamic commit message
        content: contentEncoded,
        sha: GITHUB_FILE_SHA, // Must provide the current SHA for the update to work
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
        // Update the SHA immediately for subsequent commits
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
        // Render Deploy Hooks accept POST requests to trigger a new deployment
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
    // A short delay to make the typing indicator feel more natural
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
  await ctx.reply("Hi! Send your unique secret word you just copied to get your personalized card! ❤️❤️❤️");
});

// === NEW COMMAND: /master’s_social ===
// This command replicates the functionality of the "Master's Socials" button
bot.command('master’s_social', async (ctx) => {
    await sendTypingAction(ctx);

    await ctx.replyWithMarkdown(
        "*🌐 Master’s Socials*\n\nChoose a platform to connect with the owner:",
        Markup.inlineKeyboard([
            [Markup.button.url("WhatsApp", "https://wa.me/918777845713")],
            [Markup.button.url("Telegram", "https://t.me/X_o_x_o_002")],
            [Markup.button.url("Website", "https://hawkay002.github.io/Connect/")],
            [Markup.button.callback("⬅️ Back", "back_to_menu")]
        ])
    );
});


// === Handle Deletion Action ===
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
        
        await ctx.editMessageText(`✅ User **${userName}** (\`${phoneToDelete}\`) successfully removed from the authorized list and committed to GitHub!`, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error("GitHub Deletion Error:", error);
        await ctx.editMessageText(`❌ Failed to remove user **${userName}**: ${error.message}. Please check logs and GitHub status.`, { parse_mode: 'Markdown' });
    }
});


// === Handle Gift Eligibility Management Actions (Revoke/Allow) ===
bot.action(/^admin_gift_manage:/, async (ctx) => {
    const userId = ctx.from.id;
    if (userId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }
    
    const [actionType, phone] = ctx.match.input.split(':')[1]; // 'revoke' or 'allow', then phone number
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
        
        await ctx.editMessageText(`✅ Gift eligibility for **${userName}** (\`${phone}\`) has been **${statusText.toUpperCase()}** and committed to GitHub!`, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error("GitHub Gift Management Error:", error);
        await ctx.editMessageText(`❌ Failed to update gift status for **${userName}**: ${error.message}. Please check logs and GitHub status.`, { parse_mode: 'Markdown' });
    }
});

// === NEW ADMIN ACTION: Grant Request ===
bot.action(/^admin_grant_request:/, async (ctx) => {
    const adminId = ctx.from.id;
    const messageId = ctx.callbackQuery.message.message_id; // The ID of the message with details/buttons
    
    if (adminId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }

    const refId = ctx.match.input.split(':')[1];
    const requestData = pendingRequests[refId];

    if (!requestData) {
        return ctx.reply(`❌ Error: Request ID \`${refId}\` not found or expired.`, { reply_to_message_id: messageId, parse_mode: 'Markdown' });
    }
    
    // 1. Acknowledge and mark the original message as processed (by removing buttons)
    try {
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
            [Markup.button.callback(`✅ GRANTED (${requestData.name})`, 'ignore')]
        ]).reply_markup);
        
        // 2. Reply to the original details message with the confirmation
        await ctx.reply(`✅ Request ${refId} granted. Notifying user.`, { reply_to_message_id: messageId, parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Error editing/replying to admin message for Grant:", e.message);
        // Fallback reply if edit fails
        await ctx.reply(`✅ Request ${refId} granted. Notifying user. (Original message edit failed)`);
    }

    try {
        await ctx.telegram.sendMessage(
            requestData.userId,
            `🎉 **SUCCESS!** Your custom card request has been approved and payment verified.
            
Your chosen **unique secret word** is:
\`${requestData.trigger}\`
Use this when the bot sends "Hi! Send your unique secret word you just copied to get your personalized card! ❤️❤️❤️ message.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
         console.error(`Error notifying user ${requestData.userId}:`, error.message);
         await ctx.reply(`❌ Failed to send confirmation to user ${requestData.userId}. They may have blocked the bot.`);
    }

    // 3. Inform the admin about the next crucial step
    await ctx.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🚨 **ACTION REQUIRED** 🚨
        
User \`${requestData.userId}\` for Ref ID **\`${refId}\`** has been notified.
        
You must now manually add this user to \`authorized_users.json\` using the \`/add\` command:
E.g., \`/add ${requestData.phone}, ${requestData.name}, ${requestData.trigger}\`

The system requires this manual GitHub commit step.`,
        { parse_mode: 'Markdown' }
    );
    
    delete pendingRequests[refId]; // Remove request from pending list
});

// === NEW ADMIN ACTION: Decline Request - Initialization ===
bot.action(/^admin_decline_init:/, async (ctx) => {
    const adminId = ctx.from.id;
    const messageId = ctx.callbackQuery.message.message_id; // The ID of the message with details/buttons

    if (adminId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }

    const refId = ctx.match.input.split(':')[1];
    const requestData = pendingRequests[refId];

    if (!requestData) {
        return ctx.reply(`❌ Error: Request ID \`${refId}\` not found or expired.`, { reply_to_message_id: messageId, parse_mode: 'Markdown' });
    }
    
    // Set admin state to awaiting decline reason
    userStates[adminId] = { 
        state: "awaiting_decline_reason", 
        data: { 
            refId: refId,
            originalMessageId: messageId // Store the ID of the details message for later reference
        } 
    };

    const skipButton = Markup.inlineKeyboard([
        Markup.button.callback("Skip Comment & Decline", `admin_decline_final:${refId}:no_comment`)
    ]);
    
    // Acknowledge the decline button press by removing the buttons
    try {
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([
            [Markup.button.callback(`❌ DECLINING (${requestData.name})...`, 'ignore')]
        ]).reply_markup);
    } catch (e) {
        console.error("Error editing message markup on Decline Init:", e.message);
    }

    // Reply to the original message to keep the context
    await ctx.reply(
        `Please reply with the **reason** for declining request \`${refId}\` to this message, or click the button below to decline without a comment. The user's payment will be refunded to UPI ID: \`${requestData.refundUpi}\`.`,
        { parse_mode: 'Markdown', reply_to_message_id: messageId, ...skipButton }
    );
});

// === NEW ADMIN ACTION: Decline Request - Finalization (from button or text) ===
bot.action(/^admin_decline_final:/, async (ctx) => {
    const adminId = ctx.from.id;
    if (adminId !== ADMIN_CHAT_ID) {
        return ctx.reply("🚫 You are not authorized to perform this admin action.");
    }

    // Input format: admin_decline_final:<refId>:<reasonText/no_comment>
    const parts = ctx.match.input.split(':')[1];
    const refId = parts[0];
    const reason = parts[1] === 'no_comment' ? null : parts.slice(1).join(':').replace(/%20/g, ' '); // Handle multi-word reason
    
    const requestData = pendingRequests[refId];

    // Determine the message ID to reply to (either the original details message or the reason prompt)
    let replyToId = ctx.callbackQuery?.message?.message_id; // Default to button message
    if (userStates[adminId]?.data?.originalMessageId) {
        // If coming from a text reply (handled below), use the original notification ID
        replyToId = userStates[adminId].data.originalMessageId;
    }
    
    if (!requestData) {
        return ctx.reply(`❌ Error: Request ID \`${refId}\` not found or expired.`, { reply_to_message_id: replyToId, parse_mode: 'Markdown' });
    }
    
    let userMessage;
    if (reason) {
        userMessage = `❌ **Your request has been declined.**
Reason: *${reason}* Your payment of ₹${REQUEST_FEE} will be refunded to your provided UPI ID (\`${requestData.refundUpi}\`) within 24 hours or less.`;
    } else {
        userMessage = `❌ **Your request has been declined.**
        
Your payment of ₹${REQUEST_FEE} will be refunded to your provided UPI ID (\`${requestData.refundUpi}\`) within 24 hours or less.`;
    }

    try {
        await ctx.telegram.sendMessage(
            requestData.userId,
            userMessage,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
         console.error(`Error notifying user ${requestData.userId} of decline:`, error.message);
         await ctx.reply(`❌ Failed to send decline message to user ${requestData.userId}. They may have blocked the bot.`, { reply_to_message_id: replyToId });
    }
    
    const adminReplyText = `✅ Request ${refId} successfully declined. User notified and refund process initiated for \`${requestData.refundUpi}\`.`;

    await ctx.reply(adminReplyText, { reply_to_message_id: replyToId, parse_mode: 'Markdown' });

    delete userStates[adminId]; // Clear admin state
    delete pendingRequests[refId]; // Remove request from pending list
});


// === Handle Photo/Document Messages (Image Collection & Payment Screenshot) ===
bot.on(['photo', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    const isPhoto = ctx.message.photo;
    const isDocument = ctx.message.document;
    
    // Determine the file ID and type
    let fileId = null;
    let mimeType = null;
    let caption = ctx.message.caption;

    if (isPhoto) {
        // Get the largest photo size
        const photoArray = isPhoto;
        fileId = photoArray[photoArray.length - 1].file_id;
        mimeType = 'image/jpeg';
    } else if (isDocument && isDocument.mime_type?.startsWith('image')) {
        fileId = isDocument.file_id;
        mimeType = isDocument.mime_type;
    } else if (isDocument) {
        // Ignore non-image documents for this flow
        return;
    } else {
        return;
    }

    const state = userStates[userId];
    
    // --- Step 6: Collect Card Image (awaiting_request_image) ---
    if (state?.state === "awaiting_request_image") {
        await sendTypingAction(ctx);
        state.data.cardImageId = fileId;
        state.data.cardImageCaption = caption || 'No caption provided';
        state.data.cardImageMime = mimeType;
        state.state = "awaiting_payment_screenshot";
        
        await ctx.reply("✅ Card Image received. Proceeding to payment step...");

        // Send UPI QR Code
        await sendTypingAction(ctx);
        if (fs.existsSync(UPI_QR_CODE_PATH)) {
            await ctx.replyWithPhoto({ source: UPI_QR_CODE_PATH }, {
                caption: `💰 **Payment Required**\n\nPlease pay a standard fee of *₹${REQUEST_FEE}* for custom card design requests. Pay via the QR code above or VPA: \`${BOT_ADMIN_VPA}\`.\n\nAnd if you’d like to include the Shagun feature with your request, please send an extra ₹500, in total ₹550.
\n\nℹ️ What’s the Shagun feature?
\n- After a user gives a rating between 1–5 stars, they’ll get a message asking if they’d like a surprise gift. If they tap “Yes,” the bot will ask for their UPI ID. Then it’ll randomly pick a number between 1 and 500 — that number becomes their Shagun amount, which is sent to them by the admin.
\nThe rest of the ₹500 (after the Shagun amount is decided) will be refunded to the same UPI ID the user provided while making the request.\nIf no Shagun amount is claimed, you’ll receive a full refund of your ₹500 within 24 hours or less.\n\nFor any unresolved issues or questions, use /master’s_social to contact the owner directly.`,
                parse_mode: 'Markdown'
            });
        } else {
             // Fallback if QR code is missing
             await ctx.replyWithMarkdown(
                `💰 **Payment Required**\n\nTo proceed with your custom card, please pay the standard fee of *₹${REQUEST_FEE}* to VPA: \`${BOT_ADMIN_VPA}\`.\n\nAnd if you’d like to include the Shagun feature with your request, please send an extra ₹500.
\n\nℹ️ What’s the Shagun feature?
\n- After a user gives a rating between 1–5 stars, they’ll get a message asking if they’d like a surprise gift. If they tap “Yes,” the bot will ask for their UPI ID. Then it’ll randomly pick a number between 1 and 500 — that number becomes their Shagun amount, which is sent to them by the admin.
\nThe rest of the ₹500 (after the Shagun amount is decided) will be refunded to the same UPI ID the user provided while making the request.`
             );
             console.error(`Error: UPI QR Code not found at ${UPI_QR_CODE_PATH}`);
        }
        
        await sendTypingAction(ctx);
        return ctx.replyWithMarkdown(
            "💳 Once payment is successful, please reply to this chat with the **screenshot of your payment**.\n\n⚠️ **Payment has to be done within 7 days before 11:59pm IST or the fee will be increased later.**"
        );
    }
    
    // --- Step 7: Collect Payment Screenshot and Notify Admin Bot (awaiting_payment_screenshot) ---
    if (state?.state === "awaiting_payment_screenshot") {
        await sendTypingAction(ctx);
        state.data.paymentScreenshotId = fileId;
        state.data.paymentScreenshotMime = mimeType;
        
        await ctx.reply("✅ Screenshot received. Your request is now being reviewed! Please wait for admin confirmation.");
        
        const requestData = state.data;
        const committerEmail = ctx.from.username ? `${ctx.from.username}@telegram.org` : 'admin@telegram.org';
        const refId = `REQ${Date.now()}`;
        
        // 1. Store request globally for admin actions (MANDATORY)
        pendingRequests[refId] = {
            userId: userId,
            name: requestData.name,
            phone: requestData.phone,
            trigger: requestData.trigger.toLowerCase(),
            date: requestData.date,
            refundUpi: requestData.refundUpi,
            cardImageId: requestData.cardImageId,
            cardImageMime: requestData.cardImageMime,
            cardImageCaption: requestData.cardImageCaption,
            paymentScreenshotId: requestData.paymentScreenshotId,
            paymentScreenshotMime: requestData.paymentScreenshotMime,
        };

        const notificationText = `
🔔 *NEW CUSTOM CARD REQUEST PENDING* 🔔
Ref ID: \`${refId}\`
User ID: \`${userId}\`
Name: **${requestData.name}**
Phone: \`${requestData.phone}\`
Date Needed: \`${requestData.date}\`
Trigger Word: \`${requestData.trigger}\`
Refund UPI: \`${requestData.refundUpi}\`
        `;
        
        const adminKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Grant Request", `admin_grant_request:${refId}`)],
            [Markup.button.callback("❌ Decline Request", `admin_decline_init:${refId}`)],
        ]);
        
        // 2. Send text notification and action buttons to main admin chat
        const sentMessage = await ctx.telegram.sendMessage(ADMIN_CHAT_ID, notificationText, { parse_mode: 'Markdown', ...adminKeyboard });
        
        // Save the notification message ID for reference/editing (buttons removal)
        pendingRequests[refId].notificationMessageId = sentMessage.message_id;
        
        // 3. Send files to the admin chat 
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `**[REQ ${refId}] FILES FOR REVIEW:**\n\n1. **Card Image** (Attached below)\n2. **Payment Proof** (Attached below)`, { 
            parse_mode: 'Markdown', 
            reply_to_message_id: sentMessage.message_id // Reply to the details message
        });
        
        // Send Card Image
        try {
            await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, requestData.cardImageId, { 
                caption: `Card Image for ${requestData.name} (Ref ID: ${refId})`,
                reply_to_message_id: sentMessage.message_id
            });
        } catch (e) {
             console.error(`Error sending Card Image to Admin: ${e.message}`);
             await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Failed to send Card Image for ${refId}. File ID: \`${requestData.cardImageId}\``);
        }

        // Send Payment Screenshot
        try {
            await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, requestData.paymentScreenshotId, { 
                caption: `Payment Proof for ${requestData.name} (Ref ID: ${refId})`,
                reply_to_message_id: sentMessage.message_id
            });
        } catch (e) {
             console.error(`Error sending Payment Screenshot to Admin: ${e.message}`);
             await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Failed to send Payment Screenshot for ${refId}. File ID: \`${requestData.paymentScreenshotId}\``);
        }
        
        delete userStates[userId]; // Clear state after submission
        return;
    }
});


// === Handle Contact Messages (Updated for flow steps) ===
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id;
  const contact = ctx.message.contact;

  // --- NEW: Handle Request Phone Collection via Contact Share ---
  if (contact && userStates[userId]?.state === "awaiting_request_phone") {
      await sendTypingAction(ctx);
      // Store last 10 digits as normalized phone number
      const fullPhone = contact.phone_number.replace(/\D/g, "");
      userStates[userId].data.phone = fullPhone.slice(-10); // Use 'phone' key for the request data
      userStates[userId].state = "awaiting_request_trigger";
      
      return ctx.replyWithMarkdown(
          `✅ Phone received: \`${userStates[userId].data.phone}\`\n\n**Step 3 of 6**\n\nPlease reply with the **unique trigger word** (letters, numbers, or symbols) you want for your bot:`,
          Markup.removeKeyboard() // Remove the contact keyboard
      );
  }
  
  // --- (existing verification logic continues) ---
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
      await sendTypingAction(ctx);
      await ctx.reply("I already have your contact, please continue with the flow or send your unique trigger word again.");
  }
});


// === Handle Text Messages (Core Logic) ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();

  // --- 0. Command/Flow Check ---
  const currentState = userStates[userId]?.state;
  const isCommand = lowerText.startsWith('/');
  
  // --- ADMIN DECLINE REASON FLOW ---
  if (userId === ADMIN_CHAT_ID && currentState === "awaiting_decline_reason") {
      const refId = userStates[userId].data.refId;
      const originalMessageId = userStates[userId].data.originalMessageId; // Get ID of the details message
      
      // Admin provided a reason, finalize decline
      await ctx.reply(`Reason received. Declining request ${refId} with comment...`, { reply_to_message_id: originalMessageId });
      
      // Trigger the final decline action with the provided reason
      return bot.handleUpdate({
          update_id: ctx.update.update_id,
          callback_query: {
              id: `decline_reason_${Date.now()}`,
              from: ctx.from,
              message: { // Mock a callback message containing the original details message ID
                  chat: { id: ADMIN_CHAT_ID },
                  message_id: originalMessageId
              },
              chat_instance: 'some_instance',
              data: `admin_decline_final:${refId}:${encodeURIComponent(text)}`
          }
      });
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
  
  // --- USER COMMAND: /request ---
  if (lowerText === '/request') {
      await sendTypingAction(ctx);
      
      // Start the multi-step request form
      userStates[userId] = { 
          state: "awaiting_request_name", 
          data: {} 
      };

      return ctx.replyWithMarkdown(
          "📝 **Custom Card Request Form: Step 1 of 6**\n\nPlease reply with your **Full Name** for the card.",
          Markup.removeKeyboard()
      );
  }


  // --- 1. Handle Request Form Collection (Text steps) ---
  
  // A. Awaiting Name
  if (currentState === "awaiting_request_name") {
      await sendTypingAction(ctx);
      userStates[userId].data.name = text; // Use 'name' key for the request data
      userStates[userId].state = "awaiting_request_phone";

      const contactButton = Markup.keyboard([[Markup.button.contactRequest("Share Contact")]])
          .oneTime()
          .resize();

      return ctx.replyWithMarkdown(
          `✅ Name received: *${text}*\n\n**Step 2 of 6**\n\nPlease share your **Contact Number** (use the button or type it below).`,
          contactButton
      );
  }
  
  // B. Awaiting Phone (Manual Entry Fallback)
  if (currentState === "awaiting_request_phone") {
      await sendTypingAction(ctx);
      const phoneRegex = /^\+?\d{10,15}$/; // Allow 10-15 digits, optional +
      const normalizedPhone = text.replace(/\s/g, '');

      if (!phoneRegex.test(normalizedPhone)) {
          return ctx.reply("❌ Invalid phone number format. Please enter a valid number (e.g., `+919876543210`) or use the 'Share Contact' button.");
      }
      
      // If manually typed, store it and move to next step
      userStates[userId].data.phone = normalizedPhone.slice(-10); // Store last 10 digits
      userStates[userId].state = "awaiting_request_trigger";

      return ctx.replyWithMarkdown(
          `✅ Phone received: \`${userStates[userId].data.phone}\`\n\n**Step 3 of 6**\n\nPlease reply with the **unique trigger word** (letters, numbers, or symbols) you want for your bot:`,
          Markup.removeKeyboard()
      );
  }
  
  // C. Awaiting Trigger Word
  if (currentState === "awaiting_request_trigger") {
      await sendTypingAction(ctx);
      const chosenTrigger = text.toLowerCase();
      
      // Check for existing trigger word (case-insensitive)
      if (Object.values(AUTHORIZED_USERS_MAP).some(user => user.trigger_word.toLowerCase() === chosenTrigger)) {
          return ctx.reply(`❌ Trigger word **\`${text}\`** is already in use by another user. Please choose a different word.`);
      }

      userStates[userId].data.trigger = text; // Store case-sensitive version, save lower-case later
      userStates[userId].state = "awaiting_request_date";

      return ctx.replyWithMarkdown(
          `✅ Trigger word accepted: \`${text}\`\n\n**Step 4 of 6**\n\nPlease reply with the **date and time** (e.g., '12th July 2026, 10:00 AM') when you need the bot to run:`,
          Markup.removeKeyboard()
      );
  }
  
  // D. Awaiting Date/Time
  if (currentState === "awaiting_request_date") {
      await sendTypingAction(ctx);
      userStates[userId].data.date = text;
      userStates[userId].state = "awaiting_request_upi";

      return ctx.replyWithMarkdown(
          `✅ Date/Time received: *${text}*\n\n**Step 5 of 6**\n\nPlease provide your **UPI ID** (e.g., \`user@bank\`). This is crucial for **refunding** the fee if your request is declined:`,
          Markup.removeKeyboard()
      );
  }
  
  // E. Awaiting Refund UPI ID
  if (currentState === "awaiting_request_upi") {
      await sendTypingAction(ctx);
      const refundUpi = text.trim();

      if (!isValidUpiId(refundUpi)) {
          return ctx.reply("❌ Invalid UPI ID format. Please make sure it looks like `name@bank` (e.g., `user.123@ybl`) and try again.");
      }
      
      userStates[userId].data.refundUpi = refundUpi;
      userStates[userId].state = "awaiting_request_image";

      return ctx.replyWithMarkdown(
          `✅ Refund UPI ID received: \`${refundUpi}\`\n\n**Step 6 of 6**\n\nPlease send the **Image** you want on the card (select HD quality feature while sending the image for best output quality.)`,
          Markup.removeKeyboard()
      );
  }


  // --- 2. Handle Admin Commands ---
  if (userId === ADMIN_CHAT_ID) {
      
      // --- ADMIN COMMAND: /redeploy ---
      if (lowerText === '/redeploy') {
          return adminRedeployService(ctx);
      }

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


  // --- 3. Handle Ongoing User Flows (excluding request form text steps handled above) ---
  if (currentState && currentState.startsWith('awaiting_request_')) {
      // If the user is in an active request step but sends an irrelevant message, prompt them again
      // The current request step handlers above will handle the correct inputs. 
      // This is the fallback for incorrect data in the middle of the flow.
      await sendTypingAction(ctx);
      return ctx.reply("Please follow the current step of the request form. If you want to start over, type `/reset`.");
  }

  if (currentState === "awaiting_upi") {
    const upiId = lowerText;
    // ... (existing UPI validation and spinner logic) ...
    
    if (isValidUpiId(upiId)) {
        await sendTypingAction(ctx);
        await ctx.reply(`✅ Received UPI ID: \`${upiId}\`. Thank you!`, { parse_mode: 'Markdown' });
        
        userStates[userId].state = "spinning";
        userStates[userId].data.upiId = upiId; 

        const giftAmount = Math.floor(Math.random() * 500) + 1; 
        userStates[userId].data.amount = giftAmount;

        await sendTypingAction(ctx);
        const message = await ctx.reply("🎁 Spinning the wheel to select your shagun amount...");
        const messageId = message.message_id;

        const spinDuration = 3000;
        const startTime = Date.now();
        const spinIcon = '🎰';

        const updateInterval = setInterval(async () => {
            if (Date.now() - startTime < spinDuration) {
                const tempNumber = Math.floor(Math.random() * 500) + 1;
                try {
                    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `${spinIcon} Current Selection: *₹${tempNumber}*...`, { parse_mode: 'Markdown' });
                } catch (error) {}
            } else {
                clearInterval(updateInterval);
                await new Promise(r => setTimeout(r, 500));
                
                await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `🛑 Stopping at... *₹${giftAmount}*!`, { parse_mode: 'Markdown' });
                await new Promise(r => setTimeout(r, 1000));

                await ctx.replyWithMarkdown(`🎉 You've been selected to receive a shagun of *₹${giftAmount}*!`);
                
                await ctx.reply("Click below to claim your gift immediately:", 
                    Markup.inlineKeyboard([
                        Markup.button.callback("🎁 Ask for Shagun (₹" + giftAmount + ")", "ask_for_gift")
                    ])
                );
                
                userStates[userId].state = null;
            }
        }, 100); 
        return; 

    } else {
        await sendTypingAction(ctx);
        await ctx.reply("❌ Invalid UPI ID format. Please make sure it looks like `name@bank` (e.g., `user.123@ybl`) and try again.");
        return;
    }
  }
  
  if (currentState === "awaiting_contact") {
    await sendTypingAction(ctx);
    await ctx.reply('Please use the "Share Contact" button to send your number.');
    return;
  }
  
  if (currentState === "spinning") {
    await sendTypingAction(ctx);
    await ctx.reply('Please wait, the gift amount selection is in progress... 🧐');
    return;
  }

  // --- 4. Handle Dynamic Trigger Message flow (User flow) ---
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

  // 5. Generic Fallback: Only run if the message was not a command or part of an active flow
  if (!isCommand && !currentState) {
      await sendTypingAction(ctx);
      await ctx.reply("I only respond to a specific messages.");
      
      await sendTypingAction(ctx);
      await ctx.reply("You can check out more details below 👇", getMainMenu());
  }
});


// === Handle "Yes" Confirmation Button (Original Flow) ===
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

// === Handle "No" Confirmation Button (Original Flow) ===
bot.action('confirm_no', async (ctx) => {
    await ctx.editMessageText("🚫 Sorry! Authorization failed. Please try again or contact the administrator.");
});


// === Handle Ratings (Updated to check for gift eligibility) ===
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

// === Gift Flow Actions (Original Flow) ===
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
    
    // Edit the message to show processing/link, but keep the core details intact in the reply chain
    await ctx.editMessageText(
        ctx.callbackQuery.message.text + `\n\n🔗 *Payment Link for ₹${amount}* to \`${userUpi}\`\n\n**If the button fails, copy the VPA (\`${userUpi}\`) and pay manually.**`,
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
