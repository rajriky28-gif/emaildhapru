import { MongoClient } from 'mongodb';
import { encrypt, decrypt } from '../utils/cryptoHelper.js';

let client = null;
let db = null;
let collection = null;

/**
 * Initializes connection to the MongoDB Atlas cluster
 */
export async function initStore() {
  if (db) return; // Already connected

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not defined in environment variables.');
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(); // Connects to the default database configured in connection string
  collection = db.collection('emails');

  // Create an index on email address for fast queries and logical grouping
  await collection.createIndex({ email: 1 }, { unique: true }).catch(() => {});
  console.log('🔌 Connected to MongoDB successfully.');
}

/**
 * Safely closes the database connection
 */
export async function closeStore() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    collection = null;
    console.log('🔌 Disconnected from MongoDB.');
  }
}

/**
 * Clears existing pool and inserts new encrypted email accounts
 * @param {Array<Object>} emails - Array of plain email credentials
 * @returns {Promise<number>} - Count of saved accounts
 */
export async function saveEmails(emails) {
  await initStore();

  // Clear out the previous credentials list (overwrite upload logic)
  await collection.deleteMany({});

  if (emails.length === 0) {
    return 0;
  }

  const encryptedEmails = emails.map(item => ({
    email: item.email.trim().toLowerCase(),
    password: encrypt(item.password.trim()),
    imapHost: item.imapHost ? item.imapHost.trim() : undefined,
    imapPort: item.imapPort ? parseInt(item.imapPort.toString().trim(), 10) : undefined
  }));

  const result = await collection.insertMany(encryptedEmails);
  return result.insertedCount;
}

/**
 * Loads raw encrypted email list from MongoDB
 * @returns {Promise<Array<Object>>}
 */
export async function loadEmails() {
  await initStore();
  return await collection.find({}).toArray();
}

/**
 * Decrypts and returns all email accounts for processing
 * @returns {Promise<Array<Object>>}
 */
export async function getDecryptedEmails() {
  const encryptedEmails = await loadEmails();
  return encryptedEmails.map(item => {
    try {
      return {
        email: item.email,
        password: decrypt(item.password),
        imapHost: item.imapHost,
        imapPort: item.imapPort
      };
    } catch (err) {
      console.error(`Error decrypting password for ${item.email}:`, err.message);
      return {
        email: item.email,
        password: '',
        imapHost: item.imapHost,
        imapPort: item.imapPort
      };
    }
  });
}

/**
 * Returns the count of registered email accounts
 * @returns {Promise<number>}
 */
export async function getEmailCount() {
  await initStore();
  return await collection.countDocuments({});
}
