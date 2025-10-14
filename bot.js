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

// === Authorized Users Map (Will be populated dynamically on startup) ===
// Structure: { "phoneNumber": { name: "User Name", trigger_word: "unique_word" } }
let AUTHORIZED_USERS_MAP = {};
let GITHUB_FILE_SHA = null; // Store the current file SHA, required for updates
// ===============================================

const ADMIN_CHAT_ID = 1299129410; // Your Telegram User ID
const START_TIME = Date.now();
const BOT_ADMIN_VPA = "8777845713@upi"; 

// === Create bot instance ===
const bot = new Telegraf(TOKEN);

// Global state tracking for multi-step interactions
// user_id -> { state: "awaiting_contact" | "awaiting_upi" | "spinning" | null, data: { ... } }
const userStates = {}; 
const pendingGifts = {}; 
const redirectLinkStore = {}; 
const finalConfirmationMap = {};

// NEW: Global state for the multi-step deletion command
// user_id -> { state: "awaiting_deletion_choice", matches: { 1: { phone: "...", data: {...} }, ... } }
const deletionStates = {};


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
        
        // Update global state
        if (typeof data === 'object' && data !== null && metadata.sha) {
            AUTHORIZED_USERS_MAP = data;
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
    
    // Base64 encode the new JSON content
    const contentEncoded = Buffer.from(JSON.stringify(newContent, null, 2)).toString('base64');
    
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
        // Use a generic committer email if admin doesn't have a username
        const committerEmail = ctx.from.username ? `${ctx.from.username}@telegram.org` : 'admin@telegram.org';
        const commitMessage = `feat(bot): Remove user ${userName} (${phoneToDelete}) via Telegram`;

        await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, committerEmail, commitMessage);
        
        // 3. Update the local map immediately
        AUTHORIZED_USERS_MAP = newAuthorizedUsers;
        
        // 4. Clean up state
        if (deletionStates[userId]) {
            delete deletionStates[userId];
        }

        await ctx.editMessageText(`✅ User **${userName}** (\`${phoneToDelete}\`) successfully removed from the authorized list and committed to GitHub!`, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error("GitHub Deletion Error:", error);
        await ctx.editMessageText(`❌ Failed to remove user **${userName}**: ${error.message}. Please check logs and GitHub status.`, { parse_mode: 'Markdown' });
    }
});

// === Handle Text Messages (Updated for dynamic trigger word check and admin commands) ===
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  const lowerText = text.toLowerCase();

  // 0. Handle Admin Commands
  if (userId === ADMIN_CHAT_ID) {
      
      // --- ADMIN COMMAND: /redeploy ---
      if (lowerText === '/redeploy') {
          return adminRedeployService(ctx);
      }

      // --- ADMIN COMMAND: /show_users ---
      if (lowerText === '/show_users') {
          await sendTypingAction(ctx);
          if (Object.keys(AUTHORIZED_USERS_MAP).length === 0) {
              return ctx.reply("The authorized user list is currently empty.");
          }
          
          const userList = Object.entries(AUTHORIZED_USERS_MAP)
              .map(([phone, data], index) => 
                  `${index + 1}. *${data.name}* (\`${phone}\`) -> \`${data.trigger_word}\``
              )
              .join('\n');
          
          const header = `👤 *Authorized Users List* (${Object.keys(AUTHORIZED_USERS_MAP).length} total):\n\n`;
          
          // Telegram messages have a 4096 character limit
          if (userList.length + header.length > 4096) {
              await ctx.replyWithMarkdown(header + "List is too long, displaying partial content...");
              // Simple splitting logic for large lists
              const maxChunkSize = 3500;
              for (let i = 0; i < userList.length; i += maxChunkSize) {
                  await ctx.replyWithMarkdown(userList.substring(i, i + maxChunkSize));
              }
          } else {
              await ctx.replyWithMarkdown(header + userList);
          }

          return;
      }

      // --- ADMIN COMMAND: /add_user (Updated separator to comma) ---
      if (lowerText.startsWith('/add_user')) {
          await sendTypingAction(ctx);
          // Use comma as separator, then trim whitespace from all parts
          const parts = text.slice('/add_user'.length).trim().split(',').map(p => p.trim());
          
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
                  // 1. Prepare new data structure
                  const newAuthorizedUsers = { ...AUTHORIZED_USERS_MAP };
                  newAuthorizedUsers[phoneNumber] = { 
                      name: name, 
                      trigger_word: triggerWord.toLowerCase() 
                  };
                  
                  const committerEmail = ctx.from.username ? `${ctx.from.username}@telegram.org` : 'admin@telegram.org';
                  const commitMessage = `feat(bot): Add new user via Telegram for ${name}`;

                  // 2. Update the file on GitHub
                  await updateAuthorizedUsersOnGithub(newAuthorizedUsers, ctx.from.first_name, committerEmail, commitMessage);
                  
                  // 3. Update the local map immediately
                  AUTHORIZED_USERS_MAP = newAuthorizedUsers;

                  await ctx.replyWithMarkdown(`✅ User **${name}** added successfully!
Phone: \`${phoneNumber}\`
Trigger: \`${triggerWord}\`
The new list is now live. Use \`/show_users\` to verify.`);
                  
              } catch (error) {
                  console.error(error);
                  await ctx.replyWithMarkdown(`❌ Failed to update GitHub file: ${error.message}. Please check logs and your GITHUB_TOKEN.`);
              }
              return;
          } else {
              return ctx.replyWithMarkdown("❌ Invalid command format. Use: `/add_user <10-digit phone>, <Full Name>, <unique_trigger>`");
          }
      }

      // --- NEW ADMIN COMMAND: /remove ---
      if (lowerText.startsWith('/remove')) {
          await sendTypingAction(ctx);
          const query = text.slice('/remove'.length).trim();
          
          if (!query) {
              return ctx.replyWithMarkdown("❌ Invalid command format. Use: `/remove <10-digit phone/partial name>`");
          }

          // 1. Search for matches (case-insensitive for name, partial match for phone)
          const matches = Object.entries(AUTHORIZED_USERS_MAP)
              .filter(([phone, data]) => 
                  phone.includes(query) || data.name.toLowerCase().includes(query.toLowerCase())
              );
              
          if (matches.length === 0) {
              return ctx.replyWithMarkdown(`🔍 No users found matching: **\`${query}\`**`);
          }

          // 2. Prepare the list and keyboard for confirmation
          let matchText = `🔍 Found *${matches.length}* user(s) matching **\`${query}\`**:\n\n`;
          let keyboardButtons = [];
          const currentMatches = {}; // Temporary map to hold the matches for state tracking

          matches.forEach(([phone, data], index) => {
              const matchId = index + 1;
              const formattedName = data.name.replace(/([_*`[\]()])/g, '\\$1'); // Escape markdown
              
              matchText += `${matchId}. Name: *${formattedName}*\n   Phone: \`${phone}\`\n   Trigger: \`${data.trigger_word}\`\n\n`;
              
              // Button action uses the phone number for direct deletion
              keyboardButtons.push(Markup.button.callback(`Remove ${matchId} (${data.name})`, `admin_delete:${phone}`)); 
              
              currentMatches[matchId] = { phone, data };
          });
          
          // 3. Store the state and send the confirmation message
          // deletionStates[userId] = { state: "awaiting_deletion_choice", matches: currentMatches }; 
          // Note: We don't strictly need to store 'matches' here since the button already contains the phone number.

          // Split buttons into rows of 1 for better display on mobile
          const rows = keyboardButtons.map(btn => [btn]);
          
          await ctx.replyWithMarkdown(
              matchText + "⚠️ *Select a user to permanently remove them from the authorized list. This action is irreversible.*", 
              Markup.inlineKeyboard(rows)
          );
          
          return;
      }
  }


  // 1. Handle Awaiting UPI State
  if (userStates[userId]?.state === "awaiting_upi") {
    const upiId = lowerText;
    
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


  // 4. Handle Dynamic Trigger Message flow (User flow)
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

  // 5. Non-trigger message: show warning + main menu buttons
  await sendTypingAction(ctx);
  await ctx.reply("I only respond to a specific messages.");
  
  await sendTypingAction(ctx);
  await ctx.reply("You can check out more details below 👇", getMainMenu());
});

// === Handle Contact Messages (Updated for dynamic user verification) ===
bot.on("contact", async (ctx) => {
  const userId = ctx.from.id;
  const contact = ctx.message.contact;

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


// === Handle Ratings (Original Flow) ===
bot.action(/^rating_/, async (ctx) => {
  const rating = ctx.match.input.split("_")[1];
  const username = ctx.from.username || ctx.from.first_name;

  await ctx.editMessageText(`Thank you for your rating of ${rating} ⭐!`);

  await ctx.telegram.sendMessage(
    ADMIN_CHAT_ID,
    `User @${username} (ID: ${ctx.chat.id}) rated ${rating} ⭐`
  );

  await sendTypingAction(ctx);
  const giftKeyboard = Markup.inlineKeyboard([
    Markup.button.callback("Yes, I want a gift! 🥳", "gift_yes"),
    Markup.button.callback("No, thank you.", "gift_no"),
  ]);

  await ctx.replyWithMarkdown(
    "That's wonderful! We have one more surprise. Would you like a *bonus mystery gift* from us 👀?",
    giftKeyboard
  );
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
