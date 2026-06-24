import { Telegraf, Markup } from 'telegraf';
import { message } from 'telegraf/filters';
import dotenv from 'dotenv';
import { parse } from 'csv-parse/sync';
import fs from 'fs/promises';
import http from 'http';
import { initStore, closeStore, saveEmails, getDecryptedEmails, getEmailCount } from './services/emailStore.js';
import { searchAllMailboxes } from './services/imapSearcher.js';

dotenv.config();

// 1. Initialize Configuration
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ Error: TELEGRAM_BOT_TOKEN is not defined in the .env file.');
  console.error('Please configure it in .env, then restart the bot.');
  process.exit(1);
}

const bot = new Telegraf(token);

// 2. Start Keep-Alive Ping Server (for UptimeRobot / Render)
const pingPort = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(pingPort, '0.0.0.0', () => {
  console.log(`📡 Keep-Alive server is listening on port ${pingPort}`);
});

// State Machine for Search Wizard
const userStates = new Map(); // Key: chatId, Value: { step: string, sender?: string }

// Helper: Parse arguments, preserving quoted strings
function parseArguments(text) {
  const regex = /[^\s"]+|"([^"]*)"/gi;
  const args = [];
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    args.push(match[1] !== undefined ? match[1] : match[0]);
  }
  
  args.shift(); // Remove command
  return args;
}

// Helper: Load proxies
async function loadProxies() {
  const proxyPath = process.env.PROXY_LIST_PATH || 'proxies.txt';
  try {
    const data = await fs.readFile(proxyPath, 'utf8');
    return data
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error reading proxies.txt:', err.message);
    }
    return [];
  }
}

// Helper: Render Main Menu
function sendMainMenu(ctx, welcomeText = '') {
  const msg = (welcomeText ? welcomeText + '\n\n' : '') +
              `🤖 *Main Menu*\n\n` +
              `Please choose an option below to manage credentials or start searching:`;
              
  const menu = Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Bot Status', 'btn_status'),
      Markup.button.callback('🔍 Search Emails', 'btn_search_init')
    ],
    [
      Markup.button.callback('🧹 Clear Database', 'btn_clear_confirm'),
      Markup.button.callback('❓ Help Guide', 'btn_help')
    ]
  ]);

  if (ctx.callbackQuery) {
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...menu }).catch(() => {
      ctx.replyWithMarkdown(msg, menu);
    });
  } else {
    ctx.replyWithMarkdown(msg, menu);
  }
}

// Helper: Execute Mailbox Search
async function executeSearch(ctx, sender, keyword) {
  const chatId = ctx.chat.id;
  
  try {
    const accounts = await getDecryptedEmails();
    if (accounts.length === 0) {
      const msg = '⚠️ No email accounts loaded. Please upload a CSV/TXT file with credentials first.';
      const backBtn = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]);
      
      if (ctx.callbackQuery) {
        return ctx.editMessageText(msg, backBtn).catch(() => ctx.reply(msg, backBtn));
      } else {
        return ctx.reply(msg, backBtn);
      }
    }

    const proxies = await loadProxies();
    
    const startText = `🔍 *Search Started...*\n\n` +
                      `• Sender: \`${sender}\`\n` +
                      `• Keyword: \`${keyword || '(none)'}\`\n` +
                      `• Accounts to check: *${accounts.length}*\n\n` +
                      `Initializing connections...`;

    let progressMsg;
    if (ctx.callbackQuery) {
      progressMsg = await ctx.editMessageText(startText, { parse_mode: 'Markdown' })
        .catch(() => ctx.replyWithMarkdown(startText));
    } else {
      progressMsg = await ctx.replyWithMarkdown(startText);
    }
    
    const messageId = progressMsg.message_id;
    let lastEditTime = 0;
    const EDIT_THROTTLE_MS = 2000;

    const onProgress = (completed, total, results) => {
      const now = Date.now();
      const isFinal = completed === total;
      
      if (!isFinal && now - lastEditTime < EDIT_THROTTLE_MS) {
        return;
      }
      lastEditTime = now;

      const successful = results.filter(r => r.success);
      const totalMatches = successful.reduce((sum, r) => sum + r.count, 0);
      const failed = results.filter(r => !r.success).length;

      const barLength = 10;
      const filledLength = Math.round((completed / total) * barLength);
      const emptyLength = barLength - filledLength;
      const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);
      const percent = Math.round((completed / total) * 100);

      const text = `🔍 *Searching Email Accounts...*\n\n` +
                   `• Sender: \`${sender}\`\n` +
                   `• Keyword: \`${keyword || '(none)'}\`\n\n` +
                   `Progress: \`[${bar}]\` ${percent}% (${completed}/${total})\n` +
                   `📈 Matches found so far: *${totalMatches}*\n` +
                   `⚠️ Failed connections: *${failed}*\n\n` +
                   `_Please wait, checking mailboxes concurrently..._`;

      ctx.telegram.editMessageText(chatId, messageId, null, text, { parse_mode: 'Markdown' })
         .catch(() => {});
    };

    const results = await searchAllMailboxes(accounts, sender, keyword, proxies, onProgress);

    const successful = results.filter(r => r.success);
    const totalMatches = successful.reduce((sum, r) => sum + r.count, 0);
    const failed = results.filter(r => !r.success);

    let reportMsg = `✅ *Search Completed!*\n\n` +
                    `📋 *Summary:*\n` +
                    `• Mailboxes Checked: *${results.length}*\n` +
                    `• Total Matches Found: *${totalMatches}*\n` +
                    `• Failed Connections: *${failed.length}*\n\n`;

    const matchesDetails = successful.filter(r => r.count > 0);
    if (matchesDetails.length > 0) {
      reportMsg += `*Hits by Account:*\n`;
      matchesDetails.slice(0, 20).forEach(r => {
        reportMsg += `• \`${r.email}\`: *${r.count}* matches\n`;
      });
      if (matchesDetails.length > 20) {
        reportMsg += `• _...and ${matchesDetails.length - 20} more (see full CSV)_`;
      }
      reportMsg += `\n`;
    }

    if (failed.length > 0) {
      reportMsg += `*Failed Mailboxes (first 10 shown):*\n`;
      failed.slice(0, 10).forEach(r => {
        reportMsg += `• \`${r.email}\`: _${r.error}_\n`;
      });
      if (failed.length > 10) {
        reportMsg += `• _...and ${failed.length - 10} more errors_`;
      }
    }

    // Delete progress message and send report
    await ctx.telegram.deleteMessage(chatId, messageId).catch(() => {});
    
    const backBtn = Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]
    ]);
    await ctx.replyWithMarkdown(reportMsg, backBtn);

    // Send complete detailed CSV report to user
    const csvHeader = 'Email,Status,Matches,Error\n';
    const csvRows = results.map(r => {
      const escapedEmail = r.email.replace(/"/g, '""');
      if (r.success) {
        return `"${escapedEmail}",Success,${r.count},`;
      } else {
        const escapedError = r.error.replace(/"/g, '""');
        return `"${escapedEmail}",Failed,0,"${escapedError}"`;
      }
    }).join('\n');

    const csvContent = csvHeader + csvRows;
    const filename = `search_results_${Date.now()}.csv`;

    await ctx.replyWithDocument(
      { source: Buffer.from(csvContent, 'utf8'), filename: filename },
      { caption: `📂 Full report for search: Sender: "${sender}", Keyword: "${keyword || 'None'}"` }
    );

  } catch (err) {
    ctx.reply(`❌ An error occurred during search: ${err.message}`, Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]
    ]));
  }
}

// --- Bot Commands ---

bot.start((ctx) => {
  const welcomeText = `👋 *Welcome to the Cloud-Hosted Email Searcher Bot!*\n\n` +
                      `I manage your company's email pool and search across multiple accounts for a sender and keyword.\n\n` +
                      `⚙️ *How to setup:*\n` +
                      `1. Upload a \`.csv\` or \`.txt\` file containing your email credentials.\n` +
                      `2. The file can be a CSV with headers (\`email\` and \`password\`) or a text file with one \`email,password\` (or \`email:password\`) per line.\n` +
                      `   *(Optional columns: \`imap_host\`, \`imap_port\`)*`;
  sendMainMenu(ctx, welcomeText);
});

bot.help((ctx) => {
  sendMainMenu(ctx, `❓ *Need help?* Use the menu buttons below to interact with the bot, or upload a new credentials file.`);
});

// /status
bot.command('status', async (ctx) => {
  try {
    const count = await getEmailCount();
    const proxies = await loadProxies();
    let msg = `📊 *Bot Status:*\n` +
              `• Loaded Email Accounts: *${count}*\n` +
              `• Configured Proxies: *${proxies.length}*`;
    ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]));
  } catch (err) {
    ctx.reply(`❌ Error getting status: ${err.message}`);
  }
});

// /clear
bot.command('clear', async (ctx) => {
  try {
    await saveEmails([]);
    ctx.reply('🧹 Credentials database cleared successfully.', Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]));
  } catch (err) {
    ctx.reply(`❌ Error clearing database: ${err.message}`);
  }
});

// /search
bot.command('search', async (ctx) => {
  const args = parseArguments(ctx.message.text);
  if (args.length === 0) {
    return ctx.replyWithMarkdown(
      `⚠️ *Usage:* \`/search <sender> [keyword]\`\n` +
      `_Examples:_\n` +
      `• \`/search paypal.com\`\n` +
      `• \`/search stripe.com invoice\`\n\n` +
      `💡 _Or simply click "Search Emails" in the main menu to use the guided wizard!_`
    );
  }
  const sender = args[0];
  const keyword = args[1] || '';
  await executeSearch(ctx, sender, keyword);
});

// --- Callback Actions (Buttons) ---

bot.action('btn_menu', (ctx) => {
  userStates.delete(ctx.chat.id); // Reset state
  sendMainMenu(ctx);
});

bot.action('btn_status', async (ctx) => {
  try {
    const count = await getEmailCount();
    const proxies = await loadProxies();
    
    let msg = `📊 *Bot Status:*\n\n` +
              `• Loaded Email Accounts: *${count}*\n` +
              `• Configured Proxies: *${proxies.length}*\n\n`;
              
    if (count === 0) {
      msg += `💡 _No emails loaded. Please upload a .csv or .txt file to store credentials in MongoDB._`;
    } else {
      msg += `Ready to run searches! Click "Search Emails" below or use the /search command.`;
    }

    const menu = Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Search Emails', 'btn_search_init')],
      [Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]
    ]);

    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...menu }).catch(() => {});
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]));
  }
});

bot.action('btn_search_init', async (ctx) => {
  try {
    const count = await getEmailCount();
    if (count === 0) {
      const msg = `⚠️ *No Accounts Loaded*\n\nPlease upload a \`.csv\` or \`.txt\` credentials file first to store email credentials in MongoDB.`;
      const menu = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]);
      return ctx.editMessageText(msg, { parse_mode: 'Markdown', ...menu }).catch(() => {});
    }

    // Initialize state
    userStates.set(ctx.chat.id, { step: 'awaiting_sender' });

    const msg = `🔍 *Email Search (Step 1 of 2)*\n\n` +
                `Please reply to this message with the **Sender email address or domain** you want to search (e.g. \`paypal.com\` or \`stripe.com\`):`;
                
    const menu = Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Search', 'btn_menu')]]);
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...menu }).catch(() => ctx.replyWithMarkdown(msg, menu));
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.action('btn_clear_confirm', (ctx) => {
  const msg = `⚠️ *Are you sure you want to delete all credentials?*\n\n` +
              `This will wipe all email logins from your MongoDB database. This action cannot be undone.`;
              
  const menu = Markup.inlineKeyboard([
    [
      Markup.button.callback('🗑️ Yes, Clear Everything', 'btn_clear_yes'),
      Markup.button.callback('❌ No, Cancel', 'btn_menu')
    ]
  ]);
  ctx.editMessageText(msg, { parse_mode: 'Markdown', ...menu }).catch(() => {});
});

bot.action('btn_clear_yes', async (ctx) => {
  try {
    await saveEmails([]);
    const msg = `🧹 *Database Cleared Successfully!*\nAll credentials have been deleted.`;
    const menu = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]);
    ctx.editMessageText(msg, { parse_mode: 'Markdown', ...menu }).catch(() => {});
  } catch (err) {
    ctx.reply(`❌ Error clearing database: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]));
  }
});

bot.action('btn_help', (ctx) => {
  const msg = `❓ *Help Guide & Instructions*\n\n` +
              `• *Uploading Emails:* Upload a \`.csv\` or \`.txt\` file containing your accounts. Columns should be \`email\` and \`password\`.\n\n` +
              `• *App Passwords:* Ensure your accounts (Gmail/Outlook/Yahoo) have 2FA enabled and you use an *App Password* rather than your normal password.\n\n` +
              `• *Proxy Rotation:* Place SOCKS5/HTTP proxies in \`proxies.txt\` inside the root folder to route connections and prevent IP rate-limiting.\n\n` +
              `• *Search Options:* Search by sender address, and optionally filter by keyword in subject/body. Results are displayed as a summary and a detailed CSV report file.`;

  const menu = Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]]);
  ctx.editMessageText(msg, { parse_mode: 'Markdown', ...menu }).catch(() => {});
});

bot.action('skip_keyword', async (ctx) => {
  const state = userStates.get(ctx.chat.id);
  if (!state || state.step !== 'awaiting_keyword') {
    userStates.delete(ctx.chat.id);
    return sendMainMenu(ctx);
  }

  const sender = state.sender;
  userStates.delete(ctx.chat.id); // Clear state
  await executeSearch(ctx, sender, '');
});

// File Upload Handler (CSV & TXT)
bot.on(message('document'), async (ctx) => {
  const document = ctx.message.document;
  const isCsv = document.file_name.endsWith('.csv');
  const isTxt = document.file_name.endsWith('.txt');
  
  if (!isCsv && !isTxt) {
    return ctx.reply('⚠️ Please upload a valid CSV (.csv) or text (.txt) file.');
  }

  // File size limit check (5MB)
  const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
  if (document.file_size && document.file_size > MAX_FILE_SIZE_BYTES) {
    return ctx.reply(`⚠️ The uploaded file is too large (${(document.file_size / 1024 / 1024).toFixed(2)} MB). Please upload a credentials list smaller than 5MB.`);
  }

  const processingMsg = await ctx.reply('⏳ Downloading and parsing file...');

  try {
    const fileLink = await ctx.telegram.getFileLink(document.file_id);
    const response = await fetch(fileLink.href);
    
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }
    
    const fileText = await response.text();
    let emailsList = [];

    // 1. Try CSV Parsing (assumes headers exist)
    try {
      const records = parse(fileText, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

      if (records.length > 0) {
        emailsList = records.map(row => {
          const emailKey = Object.keys(row).find(k => k.toLowerCase() === 'email');
          const passKey = Object.keys(row).find(k => k.toLowerCase() === 'password' || k.toLowerCase() === 'pass');
          const hostKey = Object.keys(row).find(k => k.toLowerCase() === 'imap_host' || k.toLowerCase() === 'host' || k.toLowerCase() === 'imaphost');
          const portKey = Object.keys(row).find(k => k.toLowerCase() === 'imap_port' || k.toLowerCase() === 'port' || k.toLowerCase() === 'imapport');

          if (!emailKey || !passKey) return null;

          return {
            email: row[emailKey],
            password: row[passKey],
            imapHost: hostKey ? row[hostKey] : undefined,
            imapPort: portKey ? row[portKey] : undefined
          };
        }).filter(Boolean);
      }
    } catch (err) {
      // Ignore CSV parser errors to allow raw line-by-line fallback
    }

    // 2. Fallback Line-by-Line Parsing (if CSV parsing yielded 0 valid records)
    if (emailsList.length === 0) {
      const lines = fileText.split(/\r?\n/);
      emailsList = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.toLowerCase().startsWith('email')) return null; // skip headers or empty lines

        // Split by comma, tab, pipe, or colon
        const parts = trimmed.split(/[,\t|:]/);
        if (parts.length < 2) return null;

        const email = parts[0].trim();
        const password = parts[1].trim();

        // Check if first part looks like an email
        if (!email.includes('@')) return null;

        return {
          email,
          password,
          imapHost: parts[2] ? parts[2].trim() : undefined,
          imapPort: parts[3] ? parseInt(parts[3].trim(), 10) : undefined
        };
      }).filter(Boolean);
    }

    if (emailsList.length === 0) {
      throw new Error('No valid email/password patterns found. Make sure the file format is: email,password (one per line).');
    }

    const savedCount = await saveEmails(emailsList);
    
    ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `✅ *Success!*\nLoaded and encrypted *${savedCount}* email accounts into MongoDB.`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]])
    );
  } catch (err) {
    ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `❌ *Upload Failed:*\n${err.message}`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'btn_menu')]])
    );
  }
});

// --- Text Messages Handler (Wizard Flow Routing) ---

bot.on(message('text'), async (ctx) => {
  const text = ctx.message.text.trim();
  
  // Skip command messages (they are handled by specific bot.command handlers)
  if (text.startsWith('/')) {
    return;
  }

  const state = userStates.get(ctx.chat.id);

  if (!state) {
    // If no active state, redirect them to the Main Menu
    return sendMainMenu(ctx, `💡 _Please use the buttons below to interact with the bot._`);
  }

  if (state.step === 'awaiting_sender') {
    // Save sender and update state
    state.sender = text;
    state.step = 'awaiting_keyword';
    userStates.set(ctx.chat.id, state);

    const msg = `🔍 *Email Search (Step 2 of 2)*\n\n` +
                `• Sender: \`${state.sender}\`\n\n` +
                `Please reply with the **Keyword** to search inside email subject or body (or click the button below to search all emails from this sender):`;
                
    const menu = Markup.inlineKeyboard([
      [Markup.button.callback('⏭️ Skip Keyword (Search All)', 'skip_keyword')],
      [Markup.button.callback('❌ Cancel Search', 'btn_menu')]
    ]);

    return ctx.replyWithMarkdown(msg, menu);
  }

  if (state.step === 'awaiting_keyword') {
    // Execute search and clear state
    const sender = state.sender;
    userStates.delete(ctx.chat.id); // Reset state
    await executeSearch(ctx, sender, text);
  }
});

// Start Database and Launch Bot
async function start() {
  try {
    await initStore(); // Connect to MongoDB Atlas
    await bot.launch();
    console.log('🤖 Telegram bot is running successfully!');
  } catch (err) {
    console.error('❌ Failed to launch the bot/database:', err.message);
    process.exit(1);
  }
}

start();

// Graceful Stop Hooks
process.once('SIGINT', async () => {
  bot.stop('SIGINT');
  await closeStore();
  process.exit(0);
});

process.once('SIGTERM', async () => {
  bot.stop('SIGTERM');
  await closeStore();
  process.exit(0);
});
