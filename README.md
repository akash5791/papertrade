# PaperTrade — NSE & Crypto Simulator

A paper trading app with real-time simulated prices, NSE equity + F&O trading, and crypto trading.

## Quick start (local)

```bash
npm install
npm start
# Open http://localhost:3000
```

---

## Deploy on Railway (free, recommended)

1. Go to https://railway.app → Sign up with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Upload or push this folder to a GitHub repo (see below)
4. Railway auto-detects Node.js and deploys
5. Click **Generate Domain** → you get a free URL like `papertrade.up.railway.app`

---

## Deploy on Render (free tier)

1. Go to https://render.com → Sign up
2. Click **New** → **Web Service**
3. Connect your GitHub repo
4. Settings:
   - Build command: `npm install`
   - Start command: `node server.js`
5. Click **Create Web Service** → free URL in ~2 minutes

---

## Deploy on Vercel (static, no server needed)

Since the app is pure HTML/CSS/JS, you can also deploy just the `public/` folder:

1. Install Vercel CLI: `npm i -g vercel`
2. Run: `cd public && vercel`
3. Follow prompts → get a free `.vercel.app` URL instantly

---

## Push to GitHub (required for Railway/Render)

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main

# Create a repo on github.com first, then:
git remote add origin https://github.com/YOUR_USERNAME/papertrade.git
git push -u origin main
```

---

## Angel One API setup

1. Go to https://smartapi.angelbroking.com
2. Log in → Create New App → get **API Key**
3. In the app, click **Connect Angel One** and enter:
   - API Key
   - Client ID (e.g. A123456)
   - MPIN (4-digit)
   - TOTP (current 6-digit code from authenticator)
