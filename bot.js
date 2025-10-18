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

const IMAGE_PATH = "Wishing Birthday.jpg"; 

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
// user_id -> { state: "awaiting_..." | null, data: { ... } }
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
            const normalizedData = Object.fromEntries(
                Object.entries(data).map(([phone, userData]) => [
                    phone,
                    { ...userData, can_claim_gift: userData.can_claim_gift !== false }
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
    if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN environment variable is not set.");
    if (!GITHUB_FILE_SHA) throw new Error("Current file SHA is unknown. Cannot perform update.");
    
    const contentToCommit = {};
    for (const [phone, userData] of Object.entries(newContent)) {
        const cleanedUserData = { ...userData };
        delete cleanedUserData.matchedPhone;
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

// === ADMIN FUNCTION: Trigger Render Redeploy ===
async function adminRedeployService(ctx) {
    if (!RENDER_DEPLOY_HOOK) return ctx.reply("❌ RENDER_DEPLOY_HOOK is not set.");
    await ctx.reply("🚀 Attempting to trigger a service re-deploy on Render...");
    try {
        const response = await fetch(RENDER_DEPLOY_HOOK, { method: 'POST' });
        if (response.ok) {
            await ctx.editMessageText("✅ Deploy hook successfully triggered! Render should now be restarting the service (1-3 mins).");
        } else {
            const errorText = await response.text();
            await ctx.reply(`❌ Failed to trigger deploy hook. Status: ${response.status}. Error: ${errorText}`);
        }
    } catch (error) {
        await ctx.reply(`❌ An error occurred while contacting Render: ${error.message}`);
    }
}

// === Helper to send typing indicator ===
async function sendTypingAction(ctx) {
    await ctx.replyWithChatAction('typing');
    await new Promise(r => setTimeout(r, 600));
}

function isValidUpiId(upiId) {
    return /^[a-zA-Z0-9\.\-_]+@[a-zA-Z0-9\-]+$/.test(upiId.trim());
}

function searchUsers(query) {
    const lowerQuery = query.toLowerCase();
    return Object.entries(AUTHORIZED_USERS_MAP)
        .filter(([phone, data]) => 
            phone.includes(query) || data.name.toLowerCase().includes(lowerQuery)
        );
}

// === Keep-Alive Server ===
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

// === /masters_social Command ===
bot.command('masters_social', async (ctx) => {
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

// ===============================================
// === NEW: ADMIN CONTROL PANEL (START) ===
// ===============================================

// --- Keyboards ---
const adminMainMenu = Markup.inlineKeyboard([
    [Markup.button.callback("👤 User Management", "admin_usermgmt")],
    [Markup.button.callback("⚙️ System & Bot", "admin_system")],
    [Markup.button.callback("❌ Close Panel", "admin_close")]
]);

const userManagementMenu = Markup.inlineKeyboard([
    [
        Markup.button.callback("➕ Add New User", "admin_adduser_start"),
        Markup.button.callback("✏️ Edit User Info", "admin_edituser_start")
    ],
    [
        Markup.button.callback("🗑️ Remove User", "admin_removeuser_start"),
        Markup.button.callback("✨ Manage Gift Access", "admin_giftaccess_start")
    ],
    [Markup.button.callback("📋 List All Users", "admin_list_users")],
    [Markup.button.callback("⬅️ Back to Main Menu", "admin_main")]
]);

const systemMenu = Markup.inlineKeyboard([
    [Markup.button.callback("📊 Bot Status", "admin_status")],
    [Markup.button.callback("🚀 Redeploy Service", "admin_redeploy")],
    [Markup.button.callback("⬅️ Back to Main Menu", "admin_main")]
]);

// --- /admin Command: Entry Point ---
bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return;
    await sendTypingAction(ctx);
    await ctx.replyWithMarkdown("Welcome to the *Admin Control Panel*. Please choose an option:", adminMainMenu);
});

// --- Main Navigation ---
bot.action('admin_main', async (ctx) => ctx.editMessageText("Welcome to the *Admin Control Panel*. Please choose an option:", { parse_mode: 'Markdown', ...adminMainMenu }));
bot.action('admin_usermgmt', async (ctx) => ctx.editMessageText("*👤 User Management*\n\nSelect an action to perform.", { parse_mode: 'Markdown', ...userManagementMenu }));
bot.action('admin_system', async (ctx) => ctx.editMessageText("*⚙️ System & Bot*\n\nSelect an action.", { parse_mode: 'Markdown', ...systemMenu }));
bot.action('admin_close', async (ctx) => ctx.editMessageText("Admin panel closed."));

// --- System Menu Actions ---
bot.action('admin_status', async (ctx) => {
    const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = uptimeSeconds % 60;
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;
    const userCount = Object.keys(AUTHORIZED_USERS_MAP).length;

    await ctx.editMessageText(
        `*📊 Bot Status*\n\nUptime: \`${uptimeStr}\`\nAuthorized Users: \`${userCount}\``,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback("⬅️ Back", "admin_system")]) }
    );
});
bot.action('admin_redeploy', async (ctx) => {
    await ctx.editMessageText("Triggering redeploy...", { parse_mode: 'Markdown' });
    await adminRedeployService(ctx);
});

// --- User Management Actions ---
bot.action('admin_list_users', async (ctx) => {
    await ctx.editMessageText("Fetching user list...", { parse_mode: 'Markdown' });
    if (Object.keys(AUTHORIZED_USERS_MAP).length === 0) {
        return ctx.reply("The authorized user list is currently empty.");
    }
    const userList = Object.entries(AUTHORIZED_USERS_MAP)
        .map(([phone, data], index) => {
            const giftStatus = data.can_claim_gift ? '✅' : '🚫';
            return `${index + 1}. ${giftStatus} *${data.name}* (\`${phone}\`) -> \`${data.trigger_word}\``;
        }).join('\n');
    const header = `👤 *Authorized Users List* (${Object.keys(AUTHORIZED_USERS_MAP).length} total):\n\n`;
    await ctx.replyWithMarkdown(header + userList);
    await ctx.answerCbQuery("List sent as a new message.");
});

// --- User Management Guided Flows (using userStates) ---
bot.action(['admin_adduser_start', 'admin_edituser_start', 'admin_removeuser_start', 'admin_giftaccess_start'], async (ctx) => {
    const action = ctx.match[0];
    let state = '';
    let prompt = '';

    switch (action) {
        case 'admin_adduser_start':
            state = 'awaiting_admin_add_phone';
            prompt = "Okay, let's add a new user.\n\nFirst, please reply with their **10-digit phone number**.";
            userStates[ADMIN_CHAT_ID] = { state, data: {} };
            break;
        case 'admin_edituser_start':
            state = 'awaiting_admin_search_for_edit';
            prompt = "✏️ Who do you want to edit?\n\nPlease reply with their **name or phone number** to search.";
            userStates[ADMIN_CHAT_ID] = { state, data: {} };
            break;
        case 'admin_removeuser_start':
            state = 'awaiting_admin_search_for_remove';
            prompt = "🗑️ Who do you want to remove?\n\nPlease reply with their **name or phone number** to search.";
            userStates[ADMIN_CHAT_ID] = { state, data: {} };
            break;
        case 'admin_giftaccess_start':
            state = 'awaiting_admin_search_for_gift';
            prompt = "✨ Who do you want to manage gift access for?\n\nPlease reply with their **name or phone number** to search.";
            userStates[ADMIN_CHAT_ID] = { state, data: {} };
            break;
    }
    
    await ctx.editMessageText(prompt, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([Markup.button.callback("❌ Cancel", "admin_cancel_state")])
    });
});

// Action to cancel any state-based admin operation
bot.action('admin_cancel_state', async (ctx) => {
    delete userStates[ADMIN_CHAT_ID];
    await ctx.editMessageText("*Operation cancelled.* Returning to User Management.", {
        parse_mode: 'Markdown', ...userManagementMenu
    });
});

// ===============================================
// === NEW: ADMIN CONTROL PANEL (END) ===
// ===============================================


// === Handle Deletion Action ===
bot.action(/^admin_delete:/, async (ctx) => {
    const phoneToDelete = ctx.match.input.split(':')[1];
    await ctx.editMessageText(`⏳ Deleting user \`${phoneToDelete}\`...`, { parse_mode: 'Markdown' });
    if (!AUTHORIZED_USERS_MAP[phoneToDelete]) {
        return ctx.editMessageText(`❌ Error: User \`${phoneToDelete}\` not found.`, { parse_mode: 'Markdown' });
    }
    const userName = AUTHORIZED_USERS_MAP[phoneToDelete].name;
    try {
        const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
        delete newAuthorizedUsers[phoneToDelete];
        const commitMessage = `feat(bot): Remove user ${userName} (${phoneToDelete}) via Admin Panel`;
        await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, null, commitMessage);
        AUTHORIZED_USERS_MAP = newAuthorizedUsers;
        await ctx.editMessageText(`✅ User **${userName}** (\`${phoneToDelete}\`) removed.`, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.editMessageText(`❌ Failed to remove **${userName}**: ${error.message}.`, { parse_mode: 'Markdown' });
    }
});


// === Handle Gift Eligibility Management Actions (Revoke/Allow) ===
bot.action(/^admin_gift_manage:(revoke|allow):(.+)$/, async (ctx) => {
    const actionType = ctx.match[1];
    const phone = ctx.match[2];
    const isRevoke = actionType === 'revoke';
    await ctx.editMessageText(`⏳ Attempting to **${actionType.toUpperCase()}** gift eligibility for \`${phone}\`...`, { parse_mode: 'Markdown' });
    if (!AUTHORIZED_USERS_MAP[phone]) {
        return ctx.editMessageText(`❌ Error: User \`${phone}\` not found.`, { parse_mode: 'Markdown' });
    }
    const userName = AUTHORIZED_USERS_MAP[phone].name;
    const newStatus = !isRevoke;
    try {
        const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
        newAuthorizedUsers[phone] = { ...newAuthorizedUsers[phone], can_claim_gift: newStatus };
        const statusText = newStatus ? 'allowed' : 'revoked';
        const commitMessage = `feat(bot): Gift eligibility ${statusText} for ${userName} (${phone}) via Admin Panel`;
        await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, null, commitMessage);
        AUTHORIZED_USERS_MAP = newAuthorizedUsers;
        await ctx.editMessageText(`✅ Gift eligibility for **${userName}** (\`${phone}\`) has been **${statusText.toUpperCase()}**.`, { parse_mode: 'Markdown' });
    } catch (error) {
        await ctx.editMessageText(`❌ Failed to update gift status for **${userName}**: ${error.message}.`, { parse_mode: 'Markdown' });
    }
});

// === Handle User Edit Selection ===
bot.action(/^admin_edit_select:(.*)$/, async (ctx) => {
    const phoneToEdit = ctx.match[1];
    const userData = AUTHORIZED_USERS_MAP[phoneToEdit];
    if (!userData) {
        return ctx.editMessageText(`❌ Error: User \`${phoneToEdit}\` not found.`, { parse_mode: 'Markdown' });
    }
    const userDetailsText = `✏️ *Editing User:*\nName: \`${userData.name}\`\nPhone: \`${phoneToEdit}\`\nTrigger: \`${userData.trigger_word}\`\n\nSelect which field to change:`;
    const editKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback("✏️ Name", `admin_edit_field:name:${phoneToEdit}`),
            Markup.button.callback("📞 Number", `admin_edit_field:phone:${phoneToEdit}`),
            Markup.button.callback("🔑 Trigger", `admin_edit_field:trigger:${phoneToEdit}`)
        ],
        [Markup.button.callback("⬅️ Back to Search", "admin_edituser_start")]
    ]);
    await ctx.editMessageText(userDetailsText, { parse_mode: 'Markdown', ...editKeyboard });
});

// === Handle User Edit Field Selection (to set state) ===
bot.action(/^admin_edit_field:(\w+):(.+)$/, async (ctx) => {
    const fieldToEdit = ctx.match[1];
    const userPhone = ctx.match[2];
    const userData = AUTHORIZED_USERS_MAP[userPhone];
    if (!userData) return ctx.editMessageText(`❌ Error: User with phone \`${userPhone}\` no longer exists.`, { parse_mode: 'Markdown' });
    let promptText = "";
    let stateName = "";
    switch(fieldToEdit) {
        case 'name':
            promptText = `Please send the new **Name** (current: \`${userData.name}\`).`;
            stateName = "awaiting_edit_name";
            break;
        case 'phone':
            promptText = `Please send the new 10-digit **Phone Number** (current: \`${userPhone}\`).`;
            stateName = "awaiting_edit_phone";
            break;
        case 'trigger':
            promptText = `Please send the new **Trigger Word** (current: \`${userData.trigger_word}\`).`;
            stateName = "awaiting_edit_trigger";
            break;
        default: return ctx.editMessageText("❌ Invalid edit field.");
    }
    userStates[ADMIN_CHAT_ID] = { state: stateName, data: { originalPhone: userPhone } };
    await ctx.editMessageText(
        ctx.callbackQuery.message.text + `\n\n*ACTION:*\n${promptText}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel Edit", "admin_cancel_state")]]) }
    );
});


// === NEW ADMIN ACTION: Grant Request ===
bot.action(/^admin_grant_request:/, async (ctx) => {
    const refId = ctx.match.input.split(':')[1];
    const requestData = pendingRequests[refId];
    if (!requestData) return ctx.reply(`❌ Error: Request ID \`${refId}\` not found.`);
    try {
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback(`✅ GRANTED (${requestData.name})`, 'ignore')]]).reply_markup);
        await ctx.reply(`✅ Request ${refId} granted. Notifying user.`, { reply_to_message_id: ctx.callbackQuery.message.message_id });
    } catch (e) {
        await ctx.reply(`✅ Request ${refId} granted. Notifying user.`);
    }
    try {
        await ctx.telegram.sendMessage(requestData.userId, `🎉 **SUCCESS!** Your custom card request has been approved.\n\nYour chosen **unique secret word** is:\n\`${requestData.trigger}\`\n\nShare this link with them along with the trigger word.\nhttps://t.me/Wish\\_ind\\_bot`, { parse_mode: 'Markdown' });
    } catch (error) {
         await ctx.reply(`❌ Failed to send confirmation to user ${requestData.userId}.`);
    }
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `🚨 **ACTION REQUIRED** 🚨\n\nUser for Ref ID **\`${refId}\`** has been notified.\n\nYou must now manually add this user to \`authorized_users.json\`.\nE.g., \`/add ${requestData.phone}, ${requestData.name}, ${requestData.trigger}\``, { parse_mode: 'Markdown' });
    delete pendingRequests[refId];
});

// === NEW ADMIN ACTION: Decline Request - Initialization ===
bot.action(/^admin_decline_init:/, async (ctx) => {
    const refId = ctx.match.input.split(':')[1];
    const requestData = pendingRequests[refId];
    if (!requestData) return ctx.reply(`❌ Error: Request ID \`${refId}\` not found.`);
    userStates[ADMIN_CHAT_ID] = { state: "awaiting_decline_reason", data: { refId, originalMessageId: ctx.callbackQuery.message.message_id } };
    try {
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback(`❌ DECLINING (${requestData.name})...`, 'ignore')]]).reply_markup);
    } catch (e) { console.error(e) }
    await ctx.reply(
        `Please reply with the **reason** for declining request \`${refId}\`, or click below to decline without a comment. Refund UPI: \`${requestData.refundUpi}\`.`,
        { parse_mode: 'Markdown', reply_to_message_id: ctx.callbackQuery.message.message_id, ...Markup.inlineKeyboard([Markup.button.callback("Skip Comment & Decline", `admin_decline_final:${refId}:no_comment`)]) }
    );
});

// === NEW ADMIN ACTION: Decline Request - Finalization ===
bot.action(/^admin_decline_final:/, async (ctx) => {
    const parts = ctx.match.input.split(':');
    const refId = parts[1];
    const reason = parts.length > 2 && parts[2] !== 'no_comment' ? parts.slice(2).join(':').replace(/%20/g, ' ') : null;
    const requestData = pendingRequests[refId];
    let replyToId = ctx.callbackQuery?.message?.message_id;
    if (userStates[ADMIN_CHAT_ID]?.data?.originalMessageId) replyToId = userStates[ADMIN_CHAT_ID].data.originalMessageId;
    if (!requestData) return ctx.reply(`❌ Error: Request ID \`${refId}\` not found.`, { reply_to_message_id: replyToId });
    let userMessage = reason
        ? `❌ **Your request has been declined.**\nReason: *${reason}* Your payment of ₹${REQUEST_FEE} will be refunded to \`${requestData.refundUpi}\` within 24 hours.`
        : `❌ **Your request has been declined.** Your payment of ₹${REQUEST_FEE} will be refunded to \`${requestData.refundUpi}\` within 24 hours.`;
    try {
        await ctx.telegram.sendMessage(requestData.userId, userMessage, { parse_mode: 'Markdown' });
    } catch (error) {
         await ctx.reply(`❌ Failed to send decline message to user ${requestData.userId}.`, { reply_to_message_id: replyToId });
    }
    await ctx.reply(`✅ Request ${refId} declined. User notified. Refund for \`${requestData.refundUpi}\` initiated.`, { reply_to_message_id: replyToId });
    delete userStates[ADMIN_CHAT_ID];
    delete pendingRequests[refId];
});

// === Handle Photo/Document Messages (Image Collection & Payment Screenshot) ===
bot.on(['photo', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    if (!userStates[userId] || !userStates[userId].state.startsWith('awaiting_request_')) return;
    
    let fileId, mimeType;
    if (ctx.message.photo) {
        const photoArray = ctx.message.photo;
        fileId = photoArray[photoArray.length - 1].file_id;
        mimeType = 'image/jpeg';
    } else if (ctx.message.document?.mime_type?.startsWith('image')) {
        fileId = ctx.message.document.file_id;
        mimeType = ctx.message.document.mime_type;
    } else return;

    const state = userStates[userId];
    
    // --- Collect Card Image ---
    if (state.state === "awaiting_request_image") {
        await sendTypingAction(ctx);
        state.data.cardImageId = fileId;
        state.data.cardImageCaption = ctx.message.caption || 'No caption';
        state.data.cardImageMime = mimeType;
        state.state = "awaiting_payment_screenshot";
        
        await ctx.reply("✅ Card Image received. Proceeding to payment...");
        await sendTypingAction(ctx);

        const captionHtml = `<b>💰 Payment Required</b>\n\nPlease pay <i>₹${REQUEST_FEE}</i> for custom card requests via QR code or VPA: <code>${BOT_ADMIN_VPA}</code>.\n\nOptionally add ₹500 for the Shagun feature (total ₹550).\n\nℹ️ The Shagun amount (₹1-₹500) will be gifted to the user, and the remainder refunded to you.`;
        
        if (fs.existsSync(UPI_QR_CODE_PATH)) {
            await ctx.replyWithPhoto({ source: UPI_QR_CODE_PATH }, { caption: captionHtml, parse_mode: 'HTML' });
        } else {
            await ctx.replyWithHTML(captionHtml);
        }
        return ctx.replyWithMarkdown("💳 Once paid, please send the **payment screenshot**.");
    }
    
    // --- Collect Payment Screenshot ---
    if (state.state === "awaiting_payment_screenshot") {
        await sendTypingAction(ctx);
        state.data.paymentScreenshotId = fileId;
        state.data.paymentScreenshotMime = mimeType;
        
        await ctx.reply("✅ Screenshot received. Your request is now being reviewed!");
        
        const { name, phone, trigger, date, refundUpi, cardImageId, cardImageCaption, paymentScreenshotId } = state.data;
        const refId = `REQ${Date.now()}`;
        
        pendingRequests[refId] = { userId, name, phone, trigger: trigger.toLowerCase(), date, refundUpi, cardImageId, cardImageCaption, paymentScreenshotId };

        const notificationText = `🔔 *NEW CUSTOM CARD REQUEST*\nRef ID: \`${refId}\`\nUser ID: \`${userId}\`\nName: **${name}**\nPhone: \`${phone}\`\nDate: \`${date}\`\nTrigger: \`${trigger}\`\nRefund UPI: \`${refundUpi}\``;
        
        const adminKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Grant Request", `admin_grant_request:${refId}`)],
            [Markup.button.callback("❌ Decline Request", `admin_decline_init:${refId}`)],
        ]);
        
        const sentMessage = await ctx.telegram.sendMessage(ADMIN_CHAT_ID, notificationText, { parse_mode: 'Markdown', ...adminKeyboard });
        pendingRequests[refId].notificationMessageId = sentMessage.message_id;
        
        await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, cardImageId, { caption: `Card Image for ${name} (Ref: ${refId})` });
        await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, paymentScreenshotId, { caption: `Payment Proof for ${name} (Ref: ${refId})` });
        
        delete userStates[userId];
    }
});


// === Handle Contact Messages ===
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id;
  const state = userStates[userId];
  const contact = ctx.message.contact;
  const fullPhone = contact.phone_number.replace(/\D/g, "");
  const normalizedNumber = fullPhone.slice(-10);

  // --- Request Phone Collection ---
  if (state?.state === "awaiting_request_phone") {
      await sendTypingAction(ctx);
      state.data.phone = normalizedNumber;
      state.state = "awaiting_request_trigger";
      return ctx.replyWithMarkdown(`✅ Phone: \`${state.data.phone}\`\n\n**Step 3/6**\nPlease reply with the **unique trigger word** for your bot:`, Markup.removeKeyboard());
  }
  
  // --- Verification logic ---
  if (state?.state === "awaiting_contact") {
    const { potentialPhoneNumber, potentialName } = state.data;
    state.state = null;
    
    if (normalizedNumber === potentialPhoneNumber && AUTHORIZED_USERS_MAP[normalizedNumber]) {
      state.data.matchedName = potentialName;
      state.data.matchedPhone = normalizedNumber;
      
      await sendTypingAction(ctx);
      await ctx.reply("🔐 Authenticating...");
      
      const confirmationKeyboard = Markup.inlineKeyboard([
          Markup.button.callback("Yes, that's me!", "confirm_yes"),
          Markup.button.callback("No, that's not me", "confirm_no")
      ]);
      return ctx.replyWithMarkdown(`As per matches found, are you *${potentialName}*?`, confirmationKeyboard);
    } else {
      return ctx.reply("🚫 The shared contact number does not match. Authorization failed.");
    }
  }
});


// === Handle Text Messages (Core Logic) ===
bot.on("text", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    const lowerText = text.toLowerCase();
    const currentState = userStates[userId]?.state;
    const isCommand = lowerText.startsWith('/');
  
    // --- ADMIN STATE-BASED ACTIONS ---
    if (userId === ADMIN_CHAT_ID && currentState && currentState.startsWith('awaiting_admin_')) {
        const adminState = userStates[ADMIN_CHAT_ID];
        switch (adminState.state) {
            case 'awaiting_admin_add_phone':
                const phoneRegex = /^\d{10}$/;
                if (!phoneRegex.test(text)) return ctx.reply("❌ Invalid format. Please send a 10-digit number.");
                if (AUTHORIZED_USERS_MAP[text]) return ctx.reply(`❌ Phone number \`${text}\` already exists.`);
                adminState.data.phone = text;
                adminState.state = 'awaiting_admin_add_name';
                return ctx.reply("✅ Phone number saved. Now, please send the user's **full name**.");

            case 'awaiting_admin_add_name':
                adminState.data.name = text;
                adminState.state = 'awaiting_admin_add_trigger';
                return ctx.reply("✅ Name saved. Now, please send the **unique trigger word**.");

            case 'awaiting_admin_add_trigger':
                const trigger = lowerText;
                if (Object.values(AUTHORIZED_USERS_MAP).some(u => u.trigger_word.toLowerCase() === trigger)) {
                    return ctx.reply(`❌ Trigger word \`${trigger}\` is already in use. Please choose another.`);
                }
                adminState.data.trigger = trigger;
                const { phone, name } = adminState.data;
                delete userStates[ADMIN_CHAT_ID]; // Clear state before confirmation

                try {
                    const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP, [phone]: { name, trigger_word: trigger, can_claim_gift: true } };
                    const commitMessage = `feat(bot): Add new user ${name} via Admin Panel`;
                    await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, null, commitMessage);
                    AUTHORIZED_USERS_MAP = newAuthorizedUsers;
                    await ctx.replyWithMarkdown(`✅ User **${name}** added successfully!\nPhone: \`${phone}\`\nTrigger: \`${trigger}\``);
                } catch (error) {
                    await ctx.reply(`❌ Failed to add user: ${error.message}`);
                }
                return;
            
            case 'awaiting_admin_search_for_edit':
            case 'awaiting_admin_search_for_remove':
            case 'awaiting_admin_search_for_gift':
                const matches = searchUsers(text);
                if (matches.length === 0) return ctx.reply(`🔍 No users found matching: **\`${text}\`**`, { parse_mode: 'Markdown' });
                
                let actionType, callbackPrefix, verb;
                if (adminState.state === 'awaiting_admin_search_for_edit') { verb = 'Edit'; callbackPrefix = 'admin_edit_select'; }
                if (adminState.state === 'awaiting_admin_search_for_remove') { verb = 'Remove'; callbackPrefix = 'admin_delete'; }
                if (adminState.state === 'awaiting_admin_search_for_gift') { verb = 'Manage'; callbackPrefix = 'admin_gift_select'; } // A new prefix

                const keyboardButtons = matches.map(([phone, data]) => 
                    [Markup.button.callback(`${verb} ${data.name.substring(0, 20)}`, `${callbackPrefix}:${phone}`)]
                );
                
                delete userStates[ADMIN_CHAT_ID];
                return ctx.reply(`🔍 Found *${matches.length}* user(s). Please select one to *${verb.toLowerCase()}*:`, {
                    parse_mode: 'Markdown', ...Markup.inlineKeyboard(keyboardButtons)
                });
        }
    }
    
    // --- ADMIN EDIT FLOW (CONTINUED) ---
    if (userId === ADMIN_CHAT_ID && currentState && currentState.startsWith('awaiting_edit_')) {
        const { originalPhone } = userStates[userId].data;
        const originalUserData = AUTHORIZED_USERS_MAP[originalPhone];
        if (!originalUserData) {
            delete userStates[userId];
            return ctx.reply("❌ User data not found. Edit cancelled.");
        }
        let updateField, newValue = text, successMessage;
        const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
        try {
            switch (currentState) {
                case "awaiting_edit_name":
                    updateField = 'Name';
                    newAuthorizedUsers[originalPhone].name = newValue;
                    successMessage = `✅ Name for \`${originalPhone}\` updated to **${newValue}**.`;
                    break;
                case "awaiting_edit_phone":
                    updateField = 'Phone Number';
                    if (!/^\d{10}$/.test(newValue)) return ctx.reply("❌ Invalid phone. Must be 10 digits.");
                    if (AUTHORIZED_USERS_MAP[newValue]) return ctx.reply(`❌ Phone \`${newValue}\` is already in use.`);
                    const userData = newAuthorizedUsers[originalPhone];
                    delete newAuthorizedUsers[originalPhone];
                    newAuthorizedUsers[newValue] = userData;
                    successMessage = `✅ Phone for **${originalUserData.name}** updated to \`${newValue}\`.`;
                    break;
                case "awaiting_edit_trigger":
                    updateField = 'Trigger Word';
                    newValue = lowerText;
                    if (Object.entries(AUTHORIZED_USERS_MAP).some(([p, u]) => u.trigger_word.toLowerCase() === newValue && p !== originalPhone)) {
                        return ctx.reply(`❌ Trigger \`${newValue}\` is already in use.`);
                    }
                    newAuthorizedUsers[originalPhone].trigger_word = newValue;
                    successMessage = `✅ Trigger for **${originalUserData.name}** updated to \`${newValue}\`.`;
                    break;
            }
            const commitMessage = `feat(bot): Edit ${updateField} for ${originalUserData.name} via Admin Panel`;
            await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, null, commitMessage);
            AUTHORIZED_USERS_MAP = newAuthorizedUsers;
            delete userStates[userId];
            await ctx.replyWithMarkdown(successMessage);
        } catch (error) {
            await ctx.reply(`❌ Failed to update user: ${error.message}.`);
        }
        return;
    }
  
    // --- ADMIN DECLINE REASON FLOW ---
    if (userId === ADMIN_CHAT_ID && currentState === "awaiting_decline_reason") {
        const { refId, originalMessageId } = userStates[userId].data;
        await ctx.reply(`Reason received. Declining request ${refId}...`, { reply_to_message_id: originalMessageId });
        return bot.handleUpdate({
            update_id: ctx.update.update_id,
            callback_query: {
                id: `decline_${Date.now()}`, from: ctx.from,
                message: { chat: { id: ADMIN_CHAT_ID }, message_id: originalMessageId },
                chat_instance: 'x', data: `admin_decline_final:${refId}:${encodeURIComponent(text)}`
            }
        });
    }

    // --- USER COMMANDS & FLOWS ---
    if (lowerText === '/reset') {
        delete userStates[userId];
        return ctx.replyWithMarkdown("🧹 **Session cleared!** You can start over.", Markup.removeKeyboard());
    }
    
    if (lowerText === '/request') {
        userStates[userId] = { state: "awaiting_request_name", data: {} };
        return ctx.replyWithMarkdown("📝 **Custom Card Request: Step 1/6**\n\nPlease reply with your **Full Name**.");
    }

    // --- USER REQUEST FORM ---
    if (currentState && currentState.startsWith('awaiting_request_')) {
        const state = userStates[userId];
        switch (currentState) {
            case "awaiting_request_name":
                state.data.name = text;
                state.state = "awaiting_request_phone";
                return ctx.replyWithMarkdown(`✅ Name: *${text}*\n\n**Step 2/6**\nPlease **share your contact** or type your number.`, Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize());
            case "awaiting_request_phone":
                if (!/^\+?\d{10,15}$/.test(text.replace(/\s/g, ''))) return ctx.reply("❌ Invalid phone number format.");
                state.data.phone = text.replace(/\D/g, '').slice(-10);
                state.state = "awaiting_request_trigger";
                return ctx.replyWithMarkdown(`✅ Phone: \`${state.data.phone}\`\n\n**Step 3/6**\nPlease reply with the **unique trigger word** for your bot:`, Markup.removeKeyboard());
            case "awaiting_request_trigger":
                if (Object.values(AUTHORIZED_USERS_MAP).some(u => u.trigger_word.toLowerCase() === lowerText)) return ctx.reply(`❌ Trigger word **\`${text}\`** is already in use.`);
                state.data.trigger = text;
                state.state = "awaiting_request_date";
                return ctx.replyWithMarkdown(`✅ Trigger: \`${text}\`\n\n**Step 4/6**\nPlease reply with the **date and time** needed (e.g., '12th July 2026, 10:00 AM').`);
            case "awaiting_request_date":
                state.data.date = text;
                state.state = "awaiting_request_upi";
                return ctx.replyWithMarkdown(`✅ Date: *${text}*\n\n**Step 5/6**\nPlease provide your **UPI ID** for potential refunds.`);
            case "awaiting_request_upi":
                if (!isValidUpiId(text)) return ctx.reply("❌ Invalid UPI ID format (e.g., `user@bank`).");
                state.data.refundUpi = text;
                state.state = "awaiting_request_image";
                return ctx.replyWithMarkdown(`✅ UPI ID: \`${text}\`\n\n**Step 6/6**\nPlease send the **Image** for the card.`);
        }
    }
  
    // --- USER GIFT/VERIFICATION FLOWS ---
    if (currentState === "awaiting_upi") {
        if (!isValidUpiId(lowerText)) return ctx.reply("❌ Invalid UPI ID. Please try again.");
        await ctx.reply(`✅ Received UPI ID: \`${lowerText}\`.`, { parse_mode: 'Markdown' });
        userStates[userId].state = "spinning";
        userStates[userId].data.upiId = lowerText; 
        const giftAmount = Math.floor(Math.random() * 500) + 1; 
        userStates[userId].data.amount = giftAmount;
        const message = await ctx.reply("🎁 Spinning the wheel for your shagun amount...");
        const spinIcon = '🎰';
        setTimeout(async () => {
            await ctx.telegram.editMessageText(ctx.chat.id, message.message_id, undefined, `🎉 You've been selected for a shagun of *₹${giftAmount}*!`, { parse_mode: 'Markdown' });
            await ctx.reply("Click below to claim your gift:", Markup.inlineKeyboard([Markup.button.callback(`🎁 Ask for Shagun (₹${giftAmount})`, "ask_for_gift")]));
            userStates[userId].state = null;
        }, 3500);
        return; 
    }
  
    if (currentState === "awaiting_contact") return ctx.reply('Please use the "Share Contact" button.');
    if (currentState === "spinning") return ctx.reply('Please wait, the gift selection is in progress... 🧐');

    // --- DYNAMIC TRIGGER WORD ---
    const matchedUser = Object.entries(AUTHORIZED_USERS_MAP).find(([, userData]) => userData.trigger_word?.toLowerCase() === lowerText);
    if (matchedUser) {
        const [phoneNumber, userData] = matchedUser;
        await ctx.reply("🔍 Secret word accepted. Verifying...");
        userStates[userId] = { state: "awaiting_contact", data: { potentialPhoneNumber: phoneNumber, potentialName: userData.name } };
        return ctx.replyWithMarkdown(`Please share your phone number to continue:`, Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize());
    }

    // --- FALLBACK ---
    if (!isCommand && !currentState) {
      await ctx.reply("I only respond to specific messages.", getMainMenu());
    }
});


// === Handle "Yes" Confirmation Button ===
bot.action('confirm_yes', async (ctx) => {
    const userId = ctx.from.id;
    const matchedName = userStates[userId]?.data?.matchedName || "user";
    await ctx.editMessageText(`✅ Identity confirmed for *${matchedName}*! Preparing your card...`, { parse_mode: 'Markdown' });
    await ctx.replyWithSticker('CAACAgEAAxkBAAEPieBo5pIfbsOvjPZ6aGZJzuszgj_RMwACMAQAAhyYKEevQOWk5-70BjYE');
    await new Promise((r) => setTimeout(r, 2000));
    if (fs.existsSync(IMAGE_PATH)) {
      await ctx.replyWithPhoto({ source: IMAGE_PATH }, { caption: "🎁 Your personalized card is ready!", has_spoiler: true });
    } else {
      await ctx.reply("😔 Sorry, the card is missing on the server.");
    }
    const ratingKeyboard = Markup.inlineKeyboard([[1, 2, 3, 4, 5].map(n => Markup.button.callback(`${n} ⭐`, `rating_${n}`))]]);
    await ctx.reply("Please rate your experience:", ratingKeyboard);
});

// === Handle "No" Confirmation Button ===
bot.action('confirm_no', async (ctx) => {
    await ctx.editMessageText("🚫 Authorization failed. Please try again or contact the administrator.");
});


// === Handle Ratings ===
bot.action(/^rating_/, async (ctx) => {
  const userId = ctx.from.id;
  const rating = ctx.match.input.split("_")[1];
  const matchedPhone = userStates[userId]?.data?.matchedPhone;
  await ctx.editMessageText(`Thank you for your rating of ${rating} ⭐!`);
  await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `User @${ctx.from.username || ctx.from.first_name} rated ${rating} ⭐`);
  
  if (matchedPhone && AUTHORIZED_USERS_MAP[matchedPhone]?.can_claim_gift) {
    await ctx.replyWithMarkdown("Would you like a *bonus mystery gift*? 👀", Markup.inlineKeyboard([
        Markup.button.callback("Yes, please! 🥳", "gift_yes"),
        Markup.button.callback("No, thank you.", "gift_no"),
    ]));
  } else {
    await ctx.reply("Thanks again for celebrating with us! 😊");
  }
});

// === Gift Flow Actions ===
bot.action('gift_yes', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.editMessageText("Great! To send your shagun, please reply with your valid *UPI ID* (e.g., `user@bank`):", { parse_mode: 'Markdown' });
    userStates[userId] = { state: "awaiting_upi", data: userStates[userId]?.data || {} };
});
bot.action('gift_no', async (ctx) => ctx.editMessageText("No worries! Thanks again for celebrating with us. 😊"));

bot.action('ask_for_gift', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    if (!state?.data.upiId || !state.data.amount) return ctx.reply("Sorry, I lost your details. Please restart.");
    const { upiId, amount } = state.data;
    const refId = `GIFT${Date.now()}`;
    pendingGifts[refId] = { userId, userUpi: upiId, amount };
    await ctx.editMessageText("⏳ Waiting for confirmation..."); 
    const adminNotificationText = `🚨 *GIFT PAYMENT REQUIRED*\n\nUser ID: \`${userId}\`\nAmount: *₹${amount}*\nUPI ID: \`${upiId}\`\nRef: \`${refId}\``;
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, adminNotificationText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback(`🚀 Init Payment Link (₹${amount})`, `admin_init_pay:${refId}`)]) });
});

bot.action(/^admin_init_pay:/, async (ctx) => {
    const refId = ctx.match.input.split(':')[1];
    const giftData = pendingGifts[refId];
    if (!giftData) return ctx.editMessageText("❌ Error: Payment reference expired.", { parse_mode: 'Markdown' });
    const { userId, userUpi, amount } = giftData;
    const upiLink = `upi://pay?pa=${userUpi}&am=${amount}&pn=Bday%20Gift&tr=${refId}`;
    const redirectId = Math.random().toString(36).substring(2, 15);
    redirectLinkStore[redirectId] = upiLink;
    finalConfirmationMap[refId] = userId; 
    const httpsRedirectLink = `${BOT_PUBLIC_BASE_URL}/pay-redirect?id=${redirectId}`;
    await bot.telegram.sendMessage(userId, "✨ Your gift is being processed...");
    await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n🔗 *Payment Link for ₹${amount}* to \`${userUpi}\``, {
        parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.url("🔥 Click to Pay via UPI App", httpsRedirectLink)])
    });
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `✅ Payment link for ₹${amount} to ${userUpi} initiated.\n\n*Click "Payment Done" ONLY after completing the transaction.*`, {
        parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback("✅ Payment Done", `payment_done:${refId}`)])
    });
    delete pendingGifts[refId];
});

bot.action(/^payment_done:/, async (ctx) => {
    const refId = ctx.match.input.split(':')[1];
    const targetUserId = finalConfirmationMap[refId];
    if (!targetUserId) return ctx.editMessageText("❌ Error: Could not find target user.", { parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(targetUserId, "🎉 **Shagun sent!** Please check your account. We hope you enjoyed the surprise! ❤️", { parse_mode: 'Markdown' });
    await ctx.editMessageText(`✅ User (ID: ${targetUserId}) notified of payment for Ref: ${refId}.`, { parse_mode: 'Markdown' });
    delete finalConfirmationMap[refId];
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
    case "info": await ctx.editMessageText("🤖 *Bot Info*\n\nThis bot sends personalized *birthday wish cards* to surprise people 🎉.", { parse_mode:"Markdown", ...backButton }); break;
    case "description": await ctx.editMessageText("💬 *Description*\n\nA fun, interactive bot to deliver surprise birthday wishes with love 💫", { parse_mode:"Markdown", ...backButton }); break;
    case "master": await ctx.editMessageText("👤 *Master*\n\nMade by **Shovith (Sid)** ✨", { parse_mode:"Markdown", ...backButton }); break;
    case "uptime": await ctx.editMessageText(`⏱ *Uptime*\n\nBot has been running for \`${uptimeStr}\`.`, { parse_mode:"Markdown", ...backButton }); break;
    case "socials": await ctx.editMessageText("*🌐 Master’s Socials*\n\nChoose a platform:", { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.url("WhatsApp", "https://wa.me/918777845713"), Markup.button.url("Telegram", "https://t.me/X_o_x_o_002")],[Markup.button.url("Website", "https://hawkay002.github.io/Connect/"), Markup.button.callback("⬅️ Back", "back_to_menu")]]) }); break;
    case "back_to_menu": await ctx.editMessageText("You can check out more details below 👇", getMainMenu()); break;
  }
});

// === Main startup function ===
async function main() {
    if (!GITHUB_TOKEN) console.warn("⚠️ WARNING: GITHUB_TOKEN is not set. GitHub updates will fail.");
    if (!RENDER_DEPLOY_HOOK) console.warn("⚠️ WARNING: RENDER_DEPLOY_HOOK is not set.");
    if (!BOT_PUBLIC_BASE_URL) {
        console.error("❌ FATAL ERROR: BOT_PUBLIC_BASE_URL is not set.");
        process.exit(1);
    }
    await loadAuthorizedUsers();
    
    const WEBHOOK_PATH = '/telegraf-webhook-secret';
    const WEBHOOK_URL = `${BOT_PUBLIC_BASE_URL}${WEBHOOK_PATH}`;
    
    try {
        await bot.telegram.setWebhook(''); 
        await bot.telegram.getUpdates(0, 100, -1); 
        await bot.telegram.setWebhook(WEBHOOK_URL);
        console.log(`✅ Webhook set successfully to: ${WEBHOOK_URL}`);
    } catch (e) {
        console.error("❌ FATAL ERROR: Failed to set up webhook.", e.message);
        process.exit(1);
    }

    app.use(bot.webhookCallback(WEBHOOK_PATH));
    console.log("🤖 Bot is running in Webhook mode...");
    
    process.once("SIGINT", () => { console.log("SIGINT received, shutting down."); process.exit(0); });
    process.once("SIGTERM", () => { console.log("SIGTERM received, shutting down."); process.exit(0); });
}

main();
