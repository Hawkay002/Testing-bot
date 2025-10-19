import { Telegraf, Markup } from "telegraf";
import express from "express";
import fs from "fs";
import cors from "cors";
import path from "path";
import { fileURLToPath } from 'url';
import crypto from 'crypto';

// === Bot Configuration ===
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN not found! Set it in your environment variables.");
  process.exit(1);
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'Hawkay002'; 
const GITHUB_REPO = process.env.GITHUB_REPO || 'Testing-bot'; 
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH || 'authorized_users.json'; 
const GITHUB_USERS_URL = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/${GITHUB_FILE_PATH}`;
const BOT_PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL; 
const RENDER_DEPLOY_HOOK = process.env.RENDER_DEPLOY_HOOK;

const IMAGE_PATH = "Wishing Birthday.jpg"; 
const UPI_QR_CODE_PATH = "upi_qr_code.png"; 
const REQUEST_FEE = 50;

let AUTHORIZED_USERS_MAP = {};
let GITHUB_FILE_SHA = null; 

const ADMIN_CHAT_ID = 1299129410; 
const START_TIME = Date.now();
const BOT_ADMIN_VPA = "8777845713@upi"; 

const bot = new Telegraf(TOKEN);
const app = express();

const userStates = {}; 
const pendingGifts = {}; 
const redirectLinkStore = {}; 
const finalConfirmationMap = {};
const pendingRequests = {};

// --- Express Server Setup ---
app.use(cors()); 
app.use(express.json()); 

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));


// === GitHub Functions ===
async function loadAuthorizedUsers() {
    console.log(`📡 Fetching initial authorized users from: ${GITHUB_USERS_URL}`);
    try {
        const contentResponse = await fetch(GITHUB_USERS_URL, { cache: 'no-store' });
        if (!contentResponse.ok) throw new Error(`Failed to fetch raw content. HTTP status: ${contentResponse.status}`);
        const data = await contentResponse.json();
        
        const metadataUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
        const metadataResponse = await fetch(metadataUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
        if (!metadataResponse.ok) throw new Error(`Failed to fetch file metadata (SHA). HTTP status: ${metadataResponse.status}`);
        const metadata = await metadataResponse.json();
        
        if (typeof data === 'object' && data !== null && metadata.sha) {
            const normalizedData = Object.fromEntries(
                Object.entries(data).map(([phone, userData]) => [phone, { ...userData, can_claim_gift: userData.can_claim_gift !== false }])
            );

            AUTHORIZED_USERS_MAP = normalizedData;
            GITHUB_FILE_SHA = metadata.sha;
            console.log(`✅ Loaded ${Object.keys(AUTHORIZED_USERS_MAP).length} users. Current SHA: ${GITHUB_FILE_SHA}`);
        } else {
            throw new Error("Fetched data is invalid or SHA is missing.");
        }
    } catch (error) {
        console.error(`❌ FATAL ERROR: Could not load authorized users from GitHub. ${error.message}`);
    }
}

async function updateAuthorizedUsersOnGithub(newContent, committerName, commitMessage) {
    if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN environment variable is not set.");
    
    const metadataUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
    const metadataResponse = await fetch(metadataUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
    if (!metadataResponse.ok) throw new Error(`Failed to fetch latest SHA. Status: ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    GITHUB_FILE_SHA = metadata.sha;

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
        committer: { name: committerName, email: 'telegram-bot-dashboard@hawkay.com' }
    };
    
    const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'Telegraf-Bot-Dashboard' },
        body: JSON.stringify(payload)
    });

    if (response.ok) {
        const result = await response.json();
        GITHUB_FILE_SHA = result.content.sha;
        console.log(`✅ GitHub successfully updated. New SHA: ${GITHUB_FILE_SHA}`);
        return true;
    } else {
        const errorText = await response.text();
        throw new Error(`GitHub API Error: ${response.statusText}. Response: ${errorText}`);
    }
}

// ===============================================
// === SECURITY MIDDLEWARE ===
// ===============================================
const authMiddleware = (req, res, next) => {
    const initDataString = req.headers['x-telegram-init-data'];
    if (!initDataString) {
        return res.status(401).json({ error: 'Authentication data not provided.' });
    }

    try {
        const params = new URLSearchParams(initDataString);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (calculatedHash !== hash) {
            return res.status(403).json({ error: 'Invalid data signature. Tampering detected.' });
        }

        const user = JSON.parse(params.get('user'));
        if (user.id !== ADMIN_CHAT_ID) {
            return res.status(403).json({ error: 'Access Denied. You are not the administrator.' });
        }
        
        next();
    } catch (error) {
        return res.status(500).json({ error: 'Internal server error during authentication.' });
    }
};

// ===============================================
// === MINI APP API ENDPOINTS (SECURED) ===
// ===============================================

app.get('/api/users', authMiddleware, (req, res) => res.json(AUTHORIZED_USERS_MAP));

app.post('/api/user/add', authMiddleware, async (req, res) => {
    try {
        const { phone, name, trigger } = req.body;
        AUTHORIZED_USERS_MAP[phone] = { name, trigger_word: trigger, can_claim_gift: true };
        res.json({ message: 'User added successfully!', users: AUTHORIZED_USERS_MAP });
        updateAuthorizedUsersOnGithub(AUTHORIZED_USERS_MAP, 'Admin Dashboard', `feat: Add user ${name}`).catch(console.error);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/user/edit', authMiddleware, async (req, res) => {
    try {
        const { originalPhone, phone, name, trigger } = req.body;
        const userData = { ...AUTHORIZED_USERS_MAP[originalPhone], name, trigger_word: trigger };
        if (originalPhone !== phone) {
            delete AUTHORIZED_USERS_MAP[originalPhone];
        }
        AUTHORIZED_USERS_MAP[phone] = userData;
        res.json({ message: 'User updated successfully!', users: AUTHORIZED_USERS_MAP });
        updateAuthorizedUsersOnGithub(AUTHORIZED_USERS_MAP, 'Admin Dashboard', `feat: Edit user ${name}`).catch(console.error);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/user/delete', authMiddleware, async (req, res) => {
    try {
        const { phone } = req.body;
        delete AUTHORIZED_USERS_MAP[phone];
        res.json({ message: 'User deleted successfully!', users: AUTHORIZED_USERS_MAP });
        updateAuthorizedUsersOnGithub(AUTHORIZED_USERS_MAP, 'Admin Dashboard', `feat: Remove user ${phone}`).catch(console.error);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/user/gift', authMiddleware, async (req, res) => {
    try {
        const { phone, can_claim_gift } = req.body;
        if(AUTHORIZED_USERS_MAP[phone]) {
            AUTHORIZED_USERS_MAP[phone].can_claim_gift = can_claim_gift;
        }
        res.json({ message: `Gift access for ${phone} updated.`, users: AUTHORIZED_USERS_MAP });
        const status = can_claim_gift ? 'enabled' : 'disabled';
        updateAuthorizedUsersOnGithub(AUTHORIZED_USERS_MAP, 'Admin Dashboard', `feat: Set gift to ${status} for ${phone}`).catch(console.error);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/redeploy', authMiddleware, async (req, res) => {
    if (!RENDER_DEPLOY_HOOK) {
        return res.status(500).json({ error: "RENDER_DEPLOY_HOOK is not set on the server." });
    }
    try {
        const response = await fetch(RENDER_DEPLOY_HOOK, { method: 'POST' });
        if (response.ok) {
            res.json({ message: "Redeploy triggered successfully! Please wait 1-3 minutes." });
        } else {
            const errorText = await response.text();
            res.status(500).json({ error: `Failed to trigger redeploy hook. Status: ${response.status}. Error: ${errorText}` });
        }
    } catch (error) {
        res.status(500).json({ error: `An error occurred while contacting Render: ${error.message}` });
    }
});


// ===============================================
// === ORIGINAL BOT LOGIC (PRESERVED) ===
// ===============================================

app.get('/', (req, res) => res.send('✅ Bot server is alive!'));
app.get('/pay-redirect', (req, res) => {
    const upiLink = redirectLinkStore[req.query.id];
    if (upiLink) res.redirect(302, upiLink);
    else res.status(404).send('Link expired or not found.');
});

async function sendTypingAction(ctx) {
    await ctx.replyWithChatAction('typing');
    await new Promise(r => setTimeout(r, 600));
}

function isValidUpiId(upiId) {
    return /^[a-zA-Z0-9\.\-_]+@[a-zA-Z0-9\-]+$/.test(upiId.trim());
}

function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📜 Bot Info", "info"), Markup.button.callback("💬 Description", "description")],
    [Markup.button.callback("👤 Master", "master"), Markup.button.callback("⏱ Uptime", "uptime")],
    [Markup.button.callback("🌐 Master’s Socials", "socials")]
  ]);
}

bot.command('dashboard', async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return;
    await ctx.reply('Click the button below to open the new, powerful admin dashboard.', Markup.keyboard([
        [Markup.button.webApp('🚀 Launch Admin Dashboard', `${BOT_PUBLIC_BASE_URL}/dashboard.html`)]
    ]).resize());
});

bot.start(async (ctx) => {
  await sendTypingAction(ctx);
  await ctx.reply("Hi! Send your unique secret word you just copied to get your personalized card! ❤️❤️❤️");
});

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

bot.command('reset', async (ctx) => {
    await sendTypingAction(ctx);
    delete userStates[ctx.from.id];
    await ctx.replyWithMarkdown(
        "🧹 **Memory cleared!** Your current session has been reset. You can now start over.",
        Markup.removeKeyboard()
    );
    return bot.start(ctx);
});

bot.command('request', async (ctx) => {
    await sendTypingAction(ctx);
    userStates[ctx.from.id] = { state: "awaiting_request_name", data: {} };
    return ctx.replyWithMarkdown(
        "📝 **Custom Card Request Form: Step 1 of 6**\n\nPlease reply with your **Full Name** for the card.",
        Markup.removeKeyboard()
    );
});

bot.action(/^admin_grant_request:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return;
    const refId = ctx.match.input.split(':')[1];
    const requestData = pendingRequests[refId];
    if (!requestData) return ctx.reply(`❌ Error: Request ID \`${refId}\` not found or expired.`);
    
    try {
        await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback(`✅ GRANTED (${requestData.name})`, 'ignore')]]).reply_markup);
        await ctx.reply(`✅ Request ${refId} granted. Notifying user and adding to authorized list.`, { reply_to_message_id: ctx.callbackQuery.message.message_id });
        
        AUTHORIZED_USERS_MAP[requestData.phone] = { 
            name: requestData.name, 
            trigger_word: requestData.trigger.toLowerCase(),
            can_claim_gift: true
        };
        const commitMessage = `feat(bot): Add user ${requestData.name} via approved request ${refId}`;
        updateAuthorizedUsersOnGithub(AUTHORIZED_USERS_MAP, "Bot System (Request Grant)", commitMessage).catch(console.error);
        
    } catch (e) {
        await ctx.reply(`⚠️ Request ${refId} granted, but an error occurred during processing: ${e.message}`);
    }

    try {
        await ctx.telegram.sendMessage(
            requestData.userId,
            `🎉 **SUCCESS!** Your custom card request has been approved and you are now authorized!\n\nYour chosen **unique secret word** is:\n\`${requestData.trigger}\`\n\nUse this word to get your card. If for someone else, share this link with them: https://t.me/Wish\\_ind\\_bot`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
         await ctx.reply(`❌ Failed to send confirmation to user ${requestData.userId}. They may have blocked the bot.`);
    }
    delete pendingRequests[refId];
});

bot.action(/^admin_decline_init:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return;
    const refId = ctx.match.input.split(':')[1];
    const requestData = pendingRequests[refId];
    if (!requestData) return ctx.reply(`❌ Error: Request ID \`${refId}\` not found.`);
    
    userStates[ADMIN_CHAT_ID] = { state: "awaiting_decline_reason", data: { refId, originalMessageId: ctx.callbackQuery.message.message_id } };
    
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard([[Markup.button.callback(`❌ DECLINING...`, 'ignore')]]).reply_markup);
    await ctx.reply(
        `Please reply with the **reason** for declining request \`${refId}\`, or click to skip.`,
        { parse_mode: 'Markdown', reply_to_message_id: ctx.callbackQuery.message.message_id, ...Markup.inlineKeyboard([Markup.button.callback("Skip Comment & Decline", `admin_decline_final:${refId}:no_comment`)]) }
    );
});

bot.action(/^admin_decline_final:/, async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return;
    const [, refId, reasonEncoded] = ctx.match.input.split(':');
    const reason = reasonEncoded && reasonEncoded !== 'no_comment' ? decodeURIComponent(reasonEncoded) : null;
    const requestData = pendingRequests[refId];
    if (!requestData) return ctx.reply(`❌ Error: Request ID \`${refId}\` not found.`);
    
    const userMessage = `❌ **Your request has been declined.**\n${reason ? `Reason: *${reason}*\n` : ''}Your payment of ₹${REQUEST_FEE} will be refunded to your UPI ID (\`${requestData.refundUpi}\`) within 24 hours.`;
    await ctx.telegram.sendMessage(requestData.userId, userMessage, { parse_mode: 'Markdown' });
    await ctx.reply(`✅ Request ${refId} successfully declined. User notified.`, { reply_to_message_id: userStates[ADMIN_CHAT_ID]?.data?.originalMessageId });
    delete userStates[ADMIN_CHAT_ID];
    delete pendingRequests[refId];
});

bot.on(['photo', 'document'], async (ctx) => {
    const userId = ctx.from.id;
    const isPhoto = ctx.message.photo;
    const isDocument = ctx.message.document;
    
    let fileId = null;
    let caption = ctx.message.caption;

    if (isPhoto) {
        const photoArray = isPhoto;
        fileId = photoArray[photoArray.length - 1].file_id;
    } else if (isDocument && isDocument.mime_type?.startsWith('image')) {
        fileId = isDocument.file_id;
    } else {
        return;
    }

    const state = userStates[userId];
    
    if (state?.state === "awaiting_request_image") {
        await sendTypingAction(ctx);
        state.data.cardImageId = fileId;
        state.data.cardImageCaption = caption || 'No caption provided';
        state.state = "awaiting_payment_screenshot";
        
        await ctx.reply("✅ Card Image received. Proceeding to payment step...");
        await sendTypingAction(ctx);
        
        const captionHtml = `
<b>💰 Payment Required</b>
Please pay a standard fee of <i>₹${REQUEST_FEE}</i>. Pay via the QR code above or VPA: <code>${BOT_ADMIN_VPA}</code>.
And if you would like to include the Shagun feature with your request, please send an extra ₹500 making a total of ₹550.
ℹ️ What is the Shagun feature?
- After a user gives a rating, they will get a message asking if they would like a surprise gift. If they tap “Yes”, the bot will ask for their UPI ID. It will randomly pick a number between 1 and 500 — that number becomes their Shagun amount, sent by the admin.
The rest of the ₹500 will be refunded to the same UPI ID.
For any unresolved issues, use /masters_social.`.trim();

        if (fs.existsSync(UPI_QR_CODE_PATH)) {
            await ctx.replyWithPhoto({ source: UPI_QR_CODE_PATH }, { caption: captionHtml, parse_mode: 'HTML' });
        } else {
             await ctx.replyWithHTML(captionHtml);
        }
        
        await sendTypingAction(ctx);
        return ctx.replyWithMarkdown("💳 Once payment is successful, please reply to this chat with the **screenshot of your payment**.\n\n⚠️ **Payment has to be done within 7 days before 11:59pm IST.**");
    }
    
    if (state?.state === "awaiting_payment_screenshot") {
        await sendTypingAction(ctx);
        state.data.paymentScreenshotId = fileId;
        
        await ctx.reply("✅ Screenshot received. Your request is now being reviewed! Please wait for admin confirmation.");
        
        const requestData = state.data;
        const refId = `REQ${Date.now()}`;
        
        pendingRequests[refId] = { userId, ...requestData };

        const notificationText = `
🔔 *NEW CUSTOM CARD REQUEST PENDING* 🔔
Ref ID: \`${refId}\`
User ID: \`${userId}\`
Name: **${requestData.name}**
Phone: \`${requestData.phone}\`
Date Needed: \`${requestData.date}\`
Trigger Word: \`${requestData.trigger}\`
Refund UPI: \`${requestData.refundUpi}\``.trim();
        
        const adminKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback("✅ Grant Request & Add User", `admin_grant_request:${refId}`)],
            [Markup.button.callback("❌ Decline Request", `admin_decline_init:${refId}`)],
        ]);
        
        const sentMessage = await ctx.telegram.sendMessage(ADMIN_CHAT_ID, notificationText, { parse_mode: 'Markdown', ...adminKeyboard });
        
        await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `**[REQ ${refId}] FILES FOR REVIEW:**`, { parse_mode: 'Markdown', reply_to_message_id: sentMessage.message_id });
        
        await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, requestData.cardImageId, { caption: `Card Image for ${requestData.name} (Ref ID: ${refId})`, reply_to_message_id: sentMessage.message_id });
        await ctx.telegram.sendPhoto(ADMIN_CHAT_ID, requestData.paymentScreenshotId, { caption: `Payment Proof for ${requestData.name} (Ref ID: ${refId})`, reply_to_message_id: sentMessage.message_id });
        
        delete userStates[userId];
    }
});


bot.on("contact", async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    const contact = ctx.message.contact;
    const normalizedNumber = contact.phone_number.replace(/\D/g, '').slice(-10);

    if (state?.state === "awaiting_request_phone") {
        await sendTypingAction(ctx);
        state.data.phone = normalizedNumber;
        state.state = "awaiting_request_trigger";
        return ctx.replyWithMarkdown(`✅ Phone received: \`${normalizedNumber}\`\n\n**Step 3 of 6**\nPlease reply with the **unique trigger word** for your bot:`, Markup.removeKeyboard());
    }
  
    if (state?.state === "awaiting_contact") {
        const { potentialPhoneNumber, potentialName } = state.data;
        userStates[userId].state = null;
        
        if (normalizedNumber === potentialPhoneNumber && AUTHORIZED_USERS_MAP[normalizedNumber]) {
            userStates[userId].data.matchedName = potentialName;
            userStates[userId].data.matchedPhone = normalizedNumber;
            await sendTypingAction(ctx);
            await ctx.reply("🔐 Authenticating...");
            const confirmationKeyboard = Markup.inlineKeyboard([
                [Markup.button.callback("Yes, that's me!", "confirm_yes")],
                [Markup.button.callback("No, that's not me", "confirm_no")]
            ]);
            return ctx.replyWithMarkdown(`As per our database, are you *${potentialName}*?`, confirmationKeyboard);
        } else {
            return ctx.reply("🚫 Sorry! The shared contact does not match. Authorization failed.");
        }
    }
});

bot.on("text", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();
    const lowerText = text.toLowerCase();
    const currentState = userStates[userId]?.state;
    
    if (userId === ADMIN_CHAT_ID && currentState === "awaiting_decline_reason") {
        const { refId, originalMessageId } = userStates[userId].data;
        await ctx.reply(`Reason received. Declining request ${refId}...`, { reply_to_message_id: originalMessageId });
        return bot.handleUpdate({
            update_id: ctx.update.update_id + 1,
            callback_query: { id: `decline_${Date.now()}`, from: ctx.from, message: { chat: { id: ADMIN_CHAT_ID }, message_id: originalMessageId }, chat_instance: 'instance', data: `admin_decline_final:${refId}:${encodeURIComponent(text)}`}
        });
    }

    if (currentState?.startsWith('awaiting_request_')) {
        const state = userStates[userId];
        switch (currentState) {
            case "awaiting_request_name":
                state.data.name = text; state.state = "awaiting_request_phone";
                return ctx.replyWithMarkdown(`✅ Name received: *${text}*\n\n**Step 2 of 6**\nPlease share your **Contact Number**.`, Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize());
            case "awaiting_request_phone":
                const phone = text.replace(/\D/g, '').slice(-10);
                if (phone.length !== 10) return ctx.reply("❌ Invalid phone number. Please provide a 10-digit number.");
                state.data.phone = phone; state.state = "awaiting_request_trigger";
                return ctx.replyWithMarkdown(`✅ Phone received: \`${phone}\`\n\n**Step 3 of 6**\nPlease reply with the **unique trigger word**.`, Markup.removeKeyboard());
            case "awaiting_request_trigger":
                if (Object.values(AUTHORIZED_USERS_MAP).some(user => user.trigger_word.toLowerCase() === lowerText)) return ctx.reply(`❌ Trigger word **\`${text}\`** is already in use.`);
                state.data.trigger = text; state.state = "awaiting_request_date";
                return ctx.replyWithMarkdown(`✅ Trigger word accepted: \`${text}\`\n\n**Step 4 of 6**\nPlease reply with the **date and time**.`);
            case "awaiting_request_date":
                state.data.date = text; state.state = "awaiting_request_upi";
                return ctx.replyWithMarkdown(`✅ Date/Time received: *${text}*\n\n**Step 5 of 6**\nPlease provide your **UPI ID** for refunds.`);
            case "awaiting_request_upi":
                if (!isValidUpiId(text)) return ctx.reply("❌ Invalid UPI ID format. It should be `name@bank`.");
                state.data.refundUpi = text; state.state = "awaiting_request_image";
                return ctx.replyWithMarkdown(`✅ Refund UPI ID: \`${text}\`\n\n**Step 6 of 6**\nPlease send the **Image** for the card.`);
        }
        return;
    }

    if (currentState === "awaiting_upi") {
        if (!isValidUpiId(lowerText)) return ctx.reply("❌ Invalid UPI ID. Please try again.");
        await ctx.reply(`✅ Received UPI ID: \`${lowerText}\`.`, { parse_mode: 'Markdown' });
        
        userStates[userId].state = "spinning";
        userStates[userId].data.upiId = lowerText; 
        const giftAmount = Math.floor(Math.random() * 500) + 1; 
        userStates[userId].data.amount = giftAmount;

        const message = await ctx.reply("🎁 Spinning the wheel...");
        const messageId = message.message_id;
        const spinDuration = 4000;
        const startTime = Date.now();
        const spinIcon = '🎰';

        const updateInterval = setInterval(async () => {
            if (Date.now() - startTime < spinDuration) {
                const tempNumber = Math.floor(Math.random() * 500) + 1;
                try {
                    await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `${spinIcon} Current Selection: *₹${tempNumber}*...`, { parse_mode: 'Markdown' });
                } catch (error) {/* ignore */}
            } else {
                clearInterval(updateInterval);
                await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, `🛑 Stopping at... *₹${giftAmount}*!`, { parse_mode: 'Markdown' });
                await new Promise(r => setTimeout(r, 1000));
                await ctx.replyWithMarkdown(`🎉 You get a shagun of *₹${giftAmount}*!`);
                await ctx.reply("Click below to claim:", Markup.inlineKeyboard([Markup.button.callback(`🎁 Ask for Shagun (₹${giftAmount})`, "ask_for_gift")]));
                userStates[userId].state = null;
            }
        }, 800);
        return; 
    }
  
    if (currentState === "awaiting_contact") return ctx.reply('Please use the "Share Contact" button.');
    if (currentState === "spinning") return ctx.reply('Please wait, the wheel is spinning... 🧐');

    const matchedUser = Object.values(AUTHORIZED_USERS_MAP).find(userData => userData.trigger_word?.toLowerCase() === lowerText);
    if (matchedUser) {
        const matchedPhoneNumber = Object.keys(AUTHORIZED_USERS_MAP).find(phone => AUTHORIZED_USERS_MAP[phone] === matchedUser);
        await ctx.reply("🔍 Secret word accepted. Checking database...");
        userStates[userId] = { state: "awaiting_contact", data: { potentialPhoneNumber: matchedPhoneNumber, potentialName: matchedUser.name } };
        return ctx.replyWithMarkdown(`Please share your phone number to continue verification:`, Markup.keyboard([[Markup.button.contactRequest("Share Contact")]]).oneTime().resize());
    }

    if (!currentState && !text.startsWith('/')) {
        await sendTypingAction(ctx);
        await ctx.reply("I only respond to specific messages. You can check out more details below 👇", getMainMenu());
    }
});

bot.action('confirm_yes', async (ctx) => {
    const userId = ctx.from.id;
    const matchedName = userStates[userId]?.data?.matchedName || "the user";
    await ctx.editMessageText(`✅ Identity confirmed for *${matchedName}*! Preparing your card... 💫`, { parse_mode: 'Markdown' });
    await sendTypingAction(ctx);
    await ctx.replyWithSticker('CAACAgEAAxkBAAEPieBo5pIfbsOvjPZ6aGZJzuszgj_RMwACMAQAAhyYKEevQOWk5-70BjYE');
    await new Promise((r) => setTimeout(r, 1500));
    await sendTypingAction(ctx);
    await ctx.replyWithSticker('CAACAgEAAxkBAAEPf8Zo4QXOaaTjfwVq2EdaYp2t0By4UAAC-gEAAoyxIER4c3iI53gcxDYE');
    await new Promise((r) => setTimeout(r, 1500));
    if (fs.existsSync(IMAGE_PATH)) {
      await ctx.replyWithPhoto({ source: IMAGE_PATH }, { caption: "🎁 Your personalized card is ready — Tap to reveal!", has_spoiler: true });
    } else {
      await ctx.reply("😔 Sorry, the personalized card is missing on the server.");
    }
    const ratingKeyboard = Markup.inlineKeyboard([[1,2,3,4,5].map(n => Markup.button.callback(`${n} ⭐`, `rating_${n}`))]);
    await ctx.reply("Please rate your experience:", ratingKeyboard);
});

bot.action('confirm_no', async (ctx) => await ctx.editMessageText("🚫 Sorry! Authorization failed. Please try again."));

bot.action(/^rating_/, async (ctx) => {
  const rating = ctx.match.input.split("_")[1];
  const matchedPhone = userStates[ctx.from.id]?.data?.matchedPhone;
  await ctx.editMessageText(`Thank you for your rating of ${rating} ⭐!`);
  const username = ctx.from.username || ctx.from.first_name;
  await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `User @${username} (Chat ID: \`${ctx.chat.id}\`) rated ${rating} ⭐`, { parse_mode: 'Markdown'});
  
  if (matchedPhone && AUTHORIZED_USERS_MAP[matchedPhone]?.can_claim_gift) {
    await ctx.replyWithMarkdown("Would you like a *bonus mystery gift*? 👀", Markup.inlineKeyboard([
        [Markup.button.callback("Yes, I want a gift! 🥳", "gift_yes")],
        [Markup.button.callback("No, thank you.", "gift_no")],
    ]));
  } else {
    await ctx.reply("Thanks again for celebrating with us! 😊");
  }
});

bot.action('gift_yes', async (ctx) => {
    await ctx.editMessageText("Great choice! To send you a surprise gift, please reply with your valid *UPI ID*:", { parse_mode: 'Markdown' });
    userStates[ctx.from.id] = { state: "awaiting_upi", data: userStates[ctx.from.id]?.data || {} };
});

bot.action('gift_no', async (ctx) => await ctx.editMessageText("No worries! Thanks again for celebrating with us. 😊"));

bot.action('ask_for_gift', async (ctx) => {
    const userId = ctx.from.id;
    const state = userStates[userId];
    if (!state?.data.upiId || !state.data.amount) return ctx.reply("Sorry, details lost. Please restart.");
    const { upiId, amount } = state.data;
    const refId = `BDAYGIFT${Date.now()}`; 
    pendingGifts[refId] = { userId, userUpi: upiId, amount };
    await ctx.editMessageText("⏳ Waiting for confirmation..."); 
    const adminNotificationText = `🚨 *NEW GIFT PAYMENT REQUIRED*\nTo User ID: \`${userId}\`\nAmount: *₹${amount}*\nUPI ID: \`${upiId}\`\nRef ID: \`${refId}\``;
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, adminNotificationText, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback(`🚀 Initialize Payment Link (₹${amount})`, `admin_init_pay:${refId}`)]) });
});

bot.action(/^admin_init_pay:/, async (ctx) => {
    if(ctx.from.id !== ADMIN_CHAT_ID) return;
    const refId = ctx.match.input.split(':')[1];
    const giftData = pendingGifts[refId];
    if (!giftData) return ctx.editMessageText("❌ Error: Payment reference expired.");
    const { userId, userUpi, amount } = giftData;
    const upiLink = `upi://pay?pa=${userUpi}&am=${amount}&pn=Bday%20Gift&tr=${refId}`;
    const redirectId = Math.random().toString(36).substring(2, 15);
    redirectLinkStore[redirectId] = upiLink;
    finalConfirmationMap[refId] = userId; 
    const httpsRedirectLink = `${BOT_PUBLIC_BASE_URL}/pay-redirect?id=${redirectId}`;
    await bot.telegram.sendMessage(userId, "✨ Your gift is being processed...");
    await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n🔗 *Payment Link for ₹${amount}* to \`${userUpi}\``, {
        parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.url("🔥 Click to Pay via UPI App", httpsRedirectLink)])
    });
    await ctx.telegram.sendMessage(ADMIN_CHAT_ID, `✅ Payment link initiated.\n\n*Click below ONLY after you have successfully completed the transaction.*`, {
        parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback("✅ Payment Done - Notify User", `payment_done:${refId}`)])
    });
    delete pendingGifts[refId];
});

bot.action(/^payment_done:/, async (ctx) => {
    if(ctx.from.id !== ADMIN_CHAT_ID) return;
    const refId = ctx.match.input.split(':')[1];
    const targetUserId = finalConfirmationMap[refId];
    if (!targetUserId) return ctx.editMessageText("❌ Error: Could not determine target user.");
    await bot.telegram.sendMessage(targetUserId, "🎉 **Shagun has been sent successfully!** Please check your bank account. ❤️", { parse_mode: 'Markdown' });
    await ctx.editMessageText(`✅ User (ID: ${targetUserId}) has been notified that payment is complete.`, { parse_mode: 'Markdown' });
    delete finalConfirmationMap[refId];
});

bot.action(["info", "description", "master", "uptime", "socials", "back_to_menu"], async (ctx) => {
  const data = ctx.match.input;
  const uptimeSeconds = Math.floor((Date.now() - START_TIME) / 1000);
  const uptimeStr = `${Math.floor(uptimeSeconds/3600)}h ${Math.floor((uptimeSeconds%3600)/60)}m ${uptimeSeconds%60}s`;
  const backButton = Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "back_to_menu")]]);
  switch(data){
    case "info": await ctx.editMessageText("🤖 *Bot Info*\n\nThis bot was made for sending personalized *birthday wish cards*.", { parse_mode:"Markdown", ...backButton }); break;
    case "description": await ctx.editMessageText("💬 *Description*\n\nA fun, interactive bot built to deliver surprise birthday wishes with love 💫", { parse_mode:"Markdown", ...backButton }); break;
    case "master": await ctx.editMessageText("👤 *Master*\n\nMade by **Shovith (Sid)** ✨", { parse_mode:"Markdown", ...backButton }); break;
    case "uptime": await ctx.editMessageText(`⏱ *Uptime*\n\nThis bot has been running for \`${uptimeStr}\`.`, { parse_mode:"Markdown", ...backButton }); break;
    case "socials": await ctx.editMessageText("*🌐 Master’s Socials*\n\nChoose a platform to connect:", { parse_mode:"Markdown", ...Markup.inlineKeyboard([[Markup.button.url("WhatsApp", "https://wa.me/918777845713"), Markup.button.url("Telegram", "https://t.me/X_o_x_o_002")],[Markup.button.url("Website", "https://hawkay002.github.io/Connect/"), Markup.button.callback("⬅️ Back", "back_to_menu")]]) }); break;
    case "back_to_menu": await ctx.editMessageText("You can check out more details below 👇", getMainMenu()); break;
  }
});

// === Main startup function ===
async function main() {
    if (!GITHUB_TOKEN) console.warn("⚠️ GITHUB_TOKEN not set. Dashboard actions will fail.");
    if (!BOT_PUBLIC_BASE_URL) {
        console.error("❌ FATAL: BOT_PUBLIC_BASE_URL / RENDER_EXTERNAL_URL is not set.");
        process.exit(1);
    }
    
    await loadAuthorizedUsers();
    
    const WEBHOOK_PATH = `/telegraf/${bot.secretPathComponent()}`;
    await bot.telegram.setWebhook(`${BOT_PUBLIC_BASE_URL}${WEBHOOK_PATH}`);
    app.use(bot.webhookCallback(WEBHOOK_PATH));

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => {
        console.log(`🚀 Bot server running on port ${PORT}`);
        console.log(`🔗 Admin Dashboard available at ${BOT_PUBLIC_BASE_URL}/dashboard.html`);
    });
    
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main();
