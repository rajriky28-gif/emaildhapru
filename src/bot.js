import { Telegraf } from 'telegraf';
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

// --- Bot Commands ---

// /start
bot.start((ctx) => {
  const msg = `👋 *Welcome to the Cloud-Hosted Email Searcher Bot!*\n\n` +
              `I manage your company's email pool and search across multiple accounts for a sender and keyword.\n\n` +
              `⚙️ *How to setup:*\n` +
              `1. Upload a \`.csv\` or \`.txt\` file containing your email credentials.\n` +
              `2. The file can be a CSV with headers (\`email\` and \`password\`) or a text file with one \`email,password\` (or \`email:password\`) per line.\n` +
              `   *(Optional columns: \`imap_host\`, \`imap_port\`)*\n\n` +
              `🔍 *Commands:*\n` +
              `• \`/search <sender> [keyword]\` - Search across all accounts\n` +
              `  _Example:_ \`/search paypal.com invoice\`\n` +
              `  _Example with spaces:_ \`/search "John Doe" "refund process"\`\n` +
              `• \`/status\` - View currently loaded email count\n` +
              `• \`/clear\` - Remove all loaded email accounts from the database\n\n` +
              `🔒 *Security Note:* Your passwords are encrypted using AES-256 before storing them in MongoDB Atlas.`;
  ctx.replyWithMarkdown(msg);
});

bot.help((ctx) => ctx.replyWithMarkdown(`🔍 *Commands:*\n• \`/search <sender> [keyword]\`\n• \`/status\`\n• \`/clear\`\n\nUpload a \`.csv\` or \`.txt\` file to update your credentials pool.`));

// /status
bot.command('status', async (ctx) => {
  try {
    const count = await getEmailCount();
    const proxies = await loadProxies();
    
    let msg = `📊 *Bot Status:*\n` +
              `• Loaded Email Accounts: *${count}*\n` +
              `• Configured Proxies: *${proxies.length}*\n\n`;
              
    if (count === 0) {
      msg += `💡 _No emails loaded. Please upload a .csv or .txt file to store credentials in MongoDB._`;
    } else {
      msg += `Ready to run searches! Use \`/search <sender> [keyword]\``;
    }
    ctx.replyWithMarkdown(msg);
  } catch (err) {
    ctx.reply(`❌ Error getting status: ${err.message}`);
  }
});

// /clear
bot.command('clear', async (ctx) => {
  try {
    await saveEmails([]);
    ctx.reply('🧹 Credentials database cleared successfully.');
  } catch (err) {
    ctx.reply(`❌ Error clearing database: ${err.message}`);
  }
});

// File Upload Handler (CSV & TXT)
bot.on(message('document'), async (ctx) => {
  const document = ctx.message.document;
  const isCsv = document.file_name.endsWith('.csv');
  const isTxt = document.file_name.endsWith('.txt');
  
  if (!isCsv && !isTxt) {
    return ctx.reply('⚠️ Please upload a valid CSV (.csv) or text (.txt) file.');
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

    // 2. Fallback Line-by-Line Parsing (if CSV parsing yielded 0 valid accounts)
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
      `✅ *Success!*\nLoaded and encrypted *${savedCount}* email accounts into MongoDB.\n\nUse \`/status\` to check or \`/search\` to begin querying.`
    );
  } catch (err) {
    ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      null,
      `❌ *Upload Failed:*\n${err.message}`
    );
  }
});

// /search <sender> [keyword]
bot.command('search', async (ctx) => {
  const args = parseArguments(ctx.message.text);
  
  if (args.length === 0) {
    return ctx.replyWithMarkdown(
      `⚠️ *Usage:* \`/search <sender> [keyword]\`\n` +
      `_Examples:_\n` +
      `• \`/search paypal.com\`\n` +
      `• \`/search stripe.com invoice\`\n` +
      `• \`/search "John Doe" "chargeback alert"\``
    );
  }

  const sender = args[0];
  const keyword = args[1] || '';

  try {
    const accounts = await getDecryptedEmails();
    if (accounts.length === 0) {
      return ctx.reply('⚠️ No email accounts loaded. Please upload a CSV file with credentials first.');
    }

    const proxies = await loadProxies();
    
    const progressMsg = await ctx.replyWithMarkdown(
      `🔍 *Search Started...*\n\n` +
      `• Sender: \`${sender}\`\n` +
      `• Keyword: \`${keyword || '(none)'}\`\n` +
      `• Accounts to check: *${accounts.length}*\n\n` +
      `Initializing connections...`
    );

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

      ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, null, text, { parse_mode: 'Markdown' })
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

    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id).catch(() => {});
    await ctx.replyWithMarkdown(reportMsg);

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
    ctx.reply(`❌ An error occurred during search: ${err.message}`);
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
