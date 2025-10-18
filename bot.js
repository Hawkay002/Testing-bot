import { Telegraf, Markup } from "telegraf";
import express from "express";
import fs from "fs";
import cors from "cors";
import path from "path";
import { fileURLToPath } from 'url';

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
const BOT_PUBLIC_BASE_URL = process.env.RENDER_EXTERNAL_URL; // Use Render's provided URL
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

// === Global State Tracking ===
const userStates = {};
const pendingGifts = {};
const redirectLinkStore = {};
const finalConfirmationMap = {};
const pendingRequests = {};

// --- Express Server Setup ---
app.use(cors()); // Enable CORS for Mini App API calls
app.use(express.json()); // Middleware to parse JSON bodies

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the dashboard.html file
app.use(express.static(path.join(__dirname, 'public')));
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


// === Function to load user data from GitHub ===
async function loadAuthorizedUsers() {
    console.log(`📡 Fetching authorized users from: ${GITHUB_USERS_URL}`);
    try {
        const contentResponse = await fetch(GITHUB_USERS_URL, { cache: 'no-store' });
        if (!contentResponse.ok) throw new Error(`HTTP status: ${contentResponse.status}`);
        const data = await contentResponse.json();
        
        const metadataUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
        const metadataResponse = await fetch(metadataUrl, { headers: { 'Authorization': `token ${GITHUB_TOKEN}` } });
        if (!metadataResponse.ok) throw new Error(`Metadata fetch failed: ${metadataResponse.status}`);
        const metadata = await metadataResponse.json();
        
        if (typeof data === 'object' && data !== null && metadata.sha) {
            AUTHORIZED_USERS_MAP = Object.fromEntries(
                Object.entries(data).map(([phone, userData]) => [phone, { ...userData, can_claim_gift: userData.can_claim_gift !== false }])
            );
            GITHUB_FILE_SHA = metadata.sha;
            console.log(`✅ Loaded ${Object.keys(AUTHORIZED_USERS_MAP).length} users. SHA: ${GITHUB_FILE_SHA}`);
        } else {
            throw new Error("Invalid data or SHA missing.");
        }
    } catch (error) {
        console.error(`❌ FATAL: Could not load authorized users: ${error.message}`);
    }
}

// === Function to update the file content on GitHub ===
async function updateAuthorizedUsersOnGithub(newContent, committerName, commitMessage) {
    if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set.");
    if (!GITHUB_FILE_SHA) throw new Error("File SHA is unknown.");
    
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
        committer: { name: committerName, email: 'telegram-bot@hawkay.com' }
    };
    
    const response = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (response.ok) {
        const result = await response.json();
        GITHUB_FILE_SHA = result.content.sha;
        await loadAuthorizedUsers(); // Reload fresh data after successful push
        return true;
    } else {
        const errorText = await response.text();
        throw new Error(`GitHub API Error: ${response.statusText} - ${errorText}`);
    }
}

// ===============================================
// === MINI APP API ENDPOINTS (START) ===
// ===============================================

app.get('/api/users', (req, res) => {
    res.json(AUTHORIZED_USERS_MAP);
});

app.post('/api/user/add', async (req, res) => {
    const { phone, name, trigger } = req.body;
    if (!/^\d{10}$/.test(phone) || !name || !trigger) {
        return res.status(400).json({ error: 'Invalid data provided.' });
    }
    if (AUTHORIZED_USERS_MAP[phone]) {
        return res.status(409).json({ error: 'Phone number already exists.' });
    }
    if (Object.values(AUTHORIZED_USERS_MAP).some(u => u.trigger_word.toLowerCase() === trigger.toLowerCase())) {
        return res.status(409).json({ error: 'Trigger word is already in use.' });
    }
    
    try {
        const newUsers = { ...AUTHORIZED_USERS_MAP, [phone]: { name, trigger_word: trigger, can_claim_gift: true } };
        await updateAuthorizedUsersOnGithub(newUsers, 'Admin Dashboard', `feat: Add user ${name} via Mini App`);
        res.json({ message: 'User added successfully!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/edit', async (req, res) => {
    const { originalPhone, phone, name, trigger } = req.body;
    if (!originalPhone || !phone || !name || !trigger) {
        return res.status(400).json({ error: 'All fields are required.' });
    }
    
    let currentUsers = { ...AUTHORIZED_USERS_MAP };
    if (!currentUsers[originalPhone]) {
        return res.status(404).json({ error: 'Original user not found.' });
    }

    if (originalPhone !== phone && currentUsers[phone]) {
        return res.status(409).json({ error: 'New phone number already exists.' });
    }
     if (Object.entries(currentUsers).some(([p, u]) => u.trigger_word.toLowerCase() === trigger.toLowerCase() && p !== originalPhone)) {
        return res.status(409).json({ error: 'Trigger word is in use by another user.' });
    }
    
    try {
        const userData = { ...currentUsers[originalPhone], name, trigger_word: trigger };
        if (originalPhone !== phone) {
            delete currentUsers[originalPhone];
        }
        currentUsers[phone] = userData;
        await updateAuthorizedUsersOnGithub(currentUsers, 'Admin Dashboard', `feat: Edit user ${name} via Mini App`);
        res.json({ message: 'User updated successfully!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/delete', async (req, res) => {
    const { phone } = req.body;
    if (!AUTHORIZED_USERS_MAP[phone]) {
        return res.status(404).json({ error: 'User not found.' });
    }
    try {
        const newUsers = { ...AUTHORIZED_USERS_MAP };
        delete newUsers[phone];
        await updateAuthorizedUsersOnGithub(newUsers, 'Admin Dashboard', `feat: Remove user ${phone} via Mini App`);
        res.json({ message: 'User deleted successfully!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user/gift', async (req, res) => {
    const { phone, can_claim_gift } = req.body;
    if (!AUTHORIZED_USERS_MAP[phone]) {
        return res.status(404).json({ error: 'User not found.' });
    }
    try {
        const newUsers = { ...AUTHORIZED_USERS_MAP };
        newUsers[phone].can_claim_gift = can_claim_gift;
        const status = can_claim_gift ? 'enabled' : 'disabled';
        await updateAuthorizedUsersOnGithub(newUsers, 'Admin Dashboard', `feat: Set gift eligibility to ${status} for ${phone} via Mini App`);
        res.json({ message: `Gift access for ${phone} set to ${status}.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// ===============================================
// === MINI APP API ENDPOINTS (END) ===
// ===============================================

// Basic keep-alive and redirect routes
app.get('/', (req, res) => res.send('✅ Bot server is alive!'));
app.get('/pay-redirect', (req, res) => {
    const upiLink = redirectLinkStore[req.query.id];
    if (upiLink) res.redirect(302, upiLink);
    else res.status(404).send('Link expired or not found.');
});


// === BOT LOGIC (Commands, Actions, etc.) ===

bot.start(async (ctx) => {
    await ctx.reply("Hi! Send your unique secret word to get your personalized card! ❤️❤️❤️");
});

// --- NEW: /dashboard Command to launch the Mini App ---
bot.command('dashboard', async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return;
    await ctx.reply('Click the button below to open the admin dashboard.', Markup.keyboard([
        [Markup.button.webApp('🚀 Launch Dashboard', `${BOT_PUBLIC_BASE_URL}/dashboard`)]
    ]).resize());
});

bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_CHAT_ID) return;
    await ctx.reply('The admin panel has been upgraded! Use /dashboard to open the new Mini App interface.');
});


// ... [The rest of your bot's logic for user-facing interactions remains here]
// For brevity, I am omitting the large blocks of existing bot logic that do not need changes.
// The functions like `confirm_yes`, `rating_`, `gift_yes`, text handler for trigger words,
// contact handler, photo handler for custom requests, etc., are all still here.

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

//... and so on for the rest of the user-facing bot logic.


// === Main startup function ===
async function main() {
    if (!GITHUB_TOKEN) console.warn("⚠️ GITHUB_TOKEN not set. Dashboard actions will fail.");
    if (!BOT_PUBLIC_BASE_URL) {
        console.error("❌ FATAL: BOT_PUBLIC_BASE_URL / RENDER_EXTERNAL_URL is not set.");
        process.exit(1);
    }
    
    await loadAuthorizedUsers();
    
    // Set up bot webhook
    const WEBHOOK_PATH = `/telegraf/${bot.secretPathComponent()}`;
    await bot.telegram.setWebhook(`${BOT_PUBLIC_BASE_URL}${WEBHOOK_PATH}`);
    app.use(bot.webhookCallback(WEBHOOK_PATH));

    // Start listening
    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => {
        console.log(`🚀 Bot server running on port ${PORT}`);
        console.log(`🔗 Dashboard available at ${BOT_PUBLIC_BASE_URL}/dashboard`);
    });
    
    process.once("SIGINT", () => bot.stop("SIGINT"));
    process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main();
