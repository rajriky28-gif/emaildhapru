# 🤖 Cloud-Hosted Telegram Email Searcher Bot (100% Free & Secure)

A high-performance, cloud-hosted Telegram bot that connects to a pool of 100-1000 email mailboxes (Gmail, Outlook/Hotmail, Yahoo, etc.), runs concurrent IMAP searches for a specific sender and keyword, and returns a detailed Excel-compatible CSV report.

This setup runs **24/7 in the cloud** without keeping your laptop open, completely for free without requiring a credit card!

---

## 🚀 Features

*   **24/7 Cloud Operation:** Runs entirely in the cloud, meaning your laptop can be turned off.
*   **Staggered Batches (Anti-Block):** Processes connections in small batches with randomized delays to bypass IP blocks.
*   **Encrypted Cloud Storage:** Passwords stored in the cloud database are AES-256 encrypted using your local `ENCRYPTION_KEY`.
*   **Multi-Word Search:** Supports quotes for compound search phrases (e.g. `/search stripe.com "refund processed"`).
*   **Live Progress Bar:** Sends throttled progress updates directly to Telegram to avoid rate limits.
*   **Downloadable Report:** Sends a detailed Excel-compatible `.csv` report of all matches and failures.

---

## 🛠️ Step-by-Step Deployment Guide (100% Free)

Follow these steps to deploy your bot for free without entering any credit card details:

### Step 1: Create a Free Database (MongoDB Atlas)
1.  Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) and register for a free account (no card needed).
2.  Choose the **M0 Free** shared cluster.
3.  Under **Security Quickstart**:
    *   Create a Database User (write down the username and password).
    *   Set IP Access List: add `0.0.0.0/0` (allows connections from Render's cloud servers).
4.  Go to **Database** (on the left menu) $\rightarrow$ Click **Connect** $\rightarrow$ Select **Drivers**.
5.  Copy your **connection string** (e.g., `mongodb+srv://username:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority`).
    *   *Replace `<password>` inside the string with your database user password.*

### Step 2: Push code to a Private GitHub Repository
1.  Initialize a repository in this folder and push it to your GitHub account.
2.  **Make sure the repository is PRIVATE** to protect your code and files.

### Step 3: Deploy to Render (Free Web Service)
1.  Go to [Render.com](https://render.com) and register using your GitHub account (no card needed).
2.  Click **New +** $\rightarrow$ **Web Service**.
3.  Connect your private GitHub repository.
4.  Configure the settings:
    *   **Region:** Select the one closest to you.
    *   **Runtime:** `Node`
    *   **Build Command:** `npm install`
    *   **Start Command:** `npm start`
    *   **Instance Type:** **Free**
5.  Click **Advanced** to add **Environment Variables**:
    *   `TELEGRAM_BOT_TOKEN`: Your API token from [@BotFather](https://t.me/BotFather).
    *   `MONGODB_URI`: The connection string you copied in Step 1.
    *   `ENCRYPTION_KEY`: A 64-character hex string. You can use the one already in your `.env` or generate a new one.
    *   `PORT`: `3000` (Render will override this, but good to define).
6.  Click **Deploy Web Service**. Render will build and deploy the bot. Copy the URL of your Web Service (e.g., `https://your-bot-name.onrender.com`).

### Step 4: Keep it Awake 24/7 (UptimeRobot)
Render's free tier goes to sleep after 15 minutes of inactivity. We keep it awake using UptimeRobot:
1.  Go to [UptimeRobot.com](https://uptimerobot.com) and register for a free account (no card needed).
2.  Click **Add New Monitor**.
3.  Select **Monitor Type:** `HTTP(s)`
4.  Set **Friendly Name:** `Email Bot`
5.  Set **URL/IP:** Your Render Web Service URL (e.g., `https://your-bot-name.onrender.com/health`).
6.  Set **Monitoring Interval:** Every `5 minutes`.
7.  Click **Create Monitor**. UptimeRobot will ping the bot every 5 minutes, keeping it awake 24/7!

---

## 📊 CSV File Template

To load emails, send a `.csv` file directly to the Telegram bot. The headers are case-insensitive.

```csv
email,password,imap_host,imap_port
office@gmail.com,abcdefghijklmnop,,
support@hotmail.com,ms-app-password,,
alerts@mycompany.com,custom-password,imap.mycompany.com,993
```
*Note: `imap_host` and `imap_port` can be left blank for Gmail, Outlook, Hotmail, and Yahoo. The bot will automatically populate them.*

---

## 🔍 Commands in Telegram

*   `/start` - Shows welcome message and setup instruction.
*   `/status` - Check the number of loaded email accounts in MongoDB.
*   `/search <sender> [keyword]` - Run the email search.
    *   *Example:* `/search billing@stripe.com`
    *   *Example with spaces:* `/search "Google Pay" "verification code"`
*   `/clear` - Deletes all stored accounts from the MongoDB database.
