import { ImapFlow } from 'imapflow';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * Auto-detects or configures IMAP server settings based on domain or custom parameters
 * @param {string} email - Email address
 * @param {string} [customHost] - Optional override host
 * @param {string|number} [customPort] - Optional override port
 * @returns {{host: string, port: number, secure: boolean}}
 */
export function getImapSettings(email, customHost, customPort) {
  if (customHost && customHost.trim()) {
    return {
      host: customHost.trim(),
      port: customPort ? parseInt(customPort.toString().trim(), 10) : 993,
      secure: true
    };
  }

  const domain = email.trim().toLowerCase().split('@')[1];
  if (!domain) {
    throw new Error(`Invalid email address: ${email}`);
  }

  // Gmail
  if (domain === 'gmail.com') {
    return { host: 'imap.gmail.com', port: 993, secure: true };
  }

  // Outlook, Hotmail, Live
  if (
    domain === 'outlook.com' ||
    domain === 'hotmail.com' ||
    domain === 'live.com' ||
    domain === 'live.co.uk' ||
    domain.endsWith('.outlook.com') ||
    domain.endsWith('.hotmail.com')
  ) {
    return { host: 'outlook.office365.com', port: 993, secure: true };
  }

  // Yahoo
  if (
    domain === 'yahoo.com' ||
    domain === 'ymail.com' ||
    domain.endsWith('.yahoo.com')
  ) {
    return { host: 'imap.mail.yahoo.com', port: 993, secure: true };
  }

  // Fallback to standard guess
  return { host: `imap.${domain}`, port: 993, secure: true };
}

/**
 * Creates a proxy agent based on the proxy URL scheme
 * @param {string} proxyUrl - Proxy URL (e.g. socks5://host:port or http://host:port)
 * @returns {SocksProxyAgent|HttpsProxyAgent|null}
 */
export function createProxyAgent(proxyUrl) {
  if (!proxyUrl || !proxyUrl.trim()) return null;
  const urlStr = proxyUrl.trim();

  if (urlStr.startsWith('socks5://') || urlStr.startsWith('socks4://') || urlStr.startsWith('socks://')) {
    return new SocksProxyAgent(urlStr);
  }
  if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
    return new HttpsProxyAgent(urlStr);
  }
  // Default to socks5 if no scheme is specified
  return new SocksProxyAgent(`socks5://${urlStr}`);
}

/**
 * Connects to a single mailbox and searches for emails matching the sender and keyword
 * @param {Object} account - Account configuration
 * @param {string} account.email - Email address
 * @param {string} account.password - Decrypted password
 * @param {string} [account.imapHost] - Custom IMAP host
 * @param {string|number} [account.imapPort] - Custom IMAP port
 * @param {string} sender - Sender email address or name to search
 * @param {string} [keyword] - Keyword to search in subject or body
 * @param {Object} [agent] - Optional SOCKS/HTTP Proxy Agent
 * @returns {Promise<{success: boolean, count?: number, error?: string}>}
 */
export async function searchMailbox(account, sender, keyword, agent) {
  let settings;
  try {
    settings = getImapSettings(account.email, account.imapHost, account.imapPort);
  } catch (err) {
    return { success: false, error: `Config Error: ${err.message}` };
  }

  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: {
      user: account.email,
      pass: account.password
    },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    agent: agent || undefined
  });

  try {
    await client.connect();

    // Select Inbox
    await client.selectMailbox('INBOX');

    // Build Search Criteria
    const searchCriteria = {
      from: sender.trim()
    };

    if (keyword && keyword.trim()) {
      const kw = keyword.trim();
      searchCriteria.or = [
        { subject: kw },
        { body: kw }
      ];
    }

    const uids = await client.search(searchCriteria);
    return { success: true, count: uids.length };
  } catch (err) {
    return { success: false, error: err.message || 'IMAP connection failed' };
  } finally {
    try {
      await client.logout();
    } catch (e) {
      // Ignore logout errors as connection might already be closed
    }
  }
}

/**
 * Runs parallel IMAP searches across multiple mailboxes using a worker pool with delays
 * @param {Array<Object>} accounts - List of decrypted email accounts
 * @param {string} sender - Sender to search
 * @param {string} [keyword] - Keyword to search
 * @param {Array<string>} [proxies] - Optional list of rotating proxies
 * @param {Function} [onProgress] - Progress callback: (completedCount, totalCount, currentResults) => {}
 * @returns {Promise<Array<Object>>} - Search results for all accounts
 */
export async function searchAllMailboxes(accounts, sender, keyword, proxies = [], onProgress = null) {
  const maxConcurrency = parseInt(process.env.MAX_CONCURRENT_CONNECTIONS || '5', 10);
  const delayMs = parseInt(process.env.DELAY_BETWEEN_CONNECTIONS_MS || '1000', 10);

  const results = [];
  let completed = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < accounts.length) {
      const currentIdx = nextIndex++;
      if (currentIdx >= accounts.length) break;

      const account = accounts[currentIdx];

      // Setup Proxy if available
      let agent = null;
      if (proxies && proxies.length > 0) {
        const proxyUrl = proxies[currentIdx % proxies.length];
        try {
          agent = createProxyAgent(proxyUrl);
        } catch (err) {
          console.error(`Failed to create proxy agent for ${proxyUrl}:`, err.message);
        }
      }

      // Add stagger delay (jitter) between starting connections to avoid concurrent spikes on IP
      if (currentIdx >= maxConcurrency) {
        const stagger = delayMs + Math.floor(Math.random() * 500);
        await new Promise(resolve => setTimeout(resolve, stagger));
      }

      const result = await searchMailbox(account, sender, keyword, agent);
      results.push({ email: account.email, ...result });

      completed++;
      if (onProgress) {
        try {
          onProgress(completed, accounts.length, results);
        } catch (err) {
          console.error('Error in onProgress callback:', err);
        }
      }
    }
  };

  // Spawn parallel workers up to maxConcurrency
  const workers = Array.from(
    { length: Math.min(maxConcurrency, accounts.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}
