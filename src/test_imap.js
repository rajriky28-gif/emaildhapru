import dotenv from 'dotenv';
import { searchMailbox } from './services/imapSearcher.js';

dotenv.config();

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('🧪 IMAP Test Script Utility');
  console.log('Usage: npm run test-imap <email> <password> <sender> [keyword] [custom_host] [custom_port]');
  console.log('Example: npm run test-imap user@gmail.com "abcd-efgh-ijkl-mnop" billing@paypal.com "Receipt"');
  process.exit(1);
}

const [email, password, sender, keyword, customHost, customPort] = args;

console.log(`🧪 Running IMAP search test...`);
console.log(`• Email: ${email}`);
console.log(`• Sender: ${sender}`);
console.log(`• Keyword: ${keyword || '(none)'}`);
if (customHost) {
  console.log(`• Custom Host: ${customHost}:${customPort || 993}`);
}

const account = {
  email,
  password,
  imapHost: customHost,
  imapPort: customPort
};

console.log('Connecting to mailbox, please wait...');

searchMailbox(account, sender, keyword)
  .then(res => {
    if (res.success) {
      console.log(`\n✅ Success! Found ${res.count} matching emails.`);
    } else {
      console.error(`\n❌ Connection/Search failed:`, res.error);
    }
    process.exit(res.success ? 0 : 1);
  })
  .catch(err => {
    console.error(`\n❌ Unexpected error:`, err);
    process.exit(1);
  });
