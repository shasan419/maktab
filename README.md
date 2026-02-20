# 🕌 Maktab e Ahle Sunnat

**Prayer timings · Sehri & Iftar · Live Azan via WebSocket audio streaming**

---

## How the Live Azan Works

```
Admin (mic) ──[MediaRecorder 250ms chunks]──► WebSocket ──► Node.js server
                                                                    │
                                               ┌────────────────────┘
                                               ▼
                              Visitor 1 ◄── WebSocket ──► MediaSource → <audio>
                              Visitor 2 ◄── WebSocket ──► MediaSource → <audio>
                              Visitor N ◄── WebSocket ──► MediaSource → <audio>
```

- **No third-party service** — your own WebSocket server handles everything
- **TCP-based** — works through firewalls and mobile networks (unlike WebRTC)
- **~300–600ms latency** — perfect for Azan
- **Auto-delivery** — visitors auto-hear the Azan when admin starts broadcasting
- **Scales** — handles hundreds of simultaneous listeners easily

---

## Pages

| URL | Who sees it | What it does |
|-----|-------------|--------------|
| `/` | Everyone | Prayer timings, Sehri/Iftar, auto-listen to Azan |
| `/admin/login` | Admin | Login screen |
| `/admin/dashboard` | Admin (logged in) | Edit timings + broadcast Azan |

---

## Quick Start (Local)

```bash
# 1. Extract
tar -xzf maktab-ahle-sunnat-ws.tar.gz
cd maktab-ws

# 2. Install
npm install

# 3. Set credentials
cp .env.example .env.local
# Edit .env.local with your admin credentials + JWT secret

# 4. Run dev server
npm run dev
# → http://localhost:3000
```

---

## Deploy to Railway (Recommended — Free)

Railway is the ideal host because it supports **long-lived WebSocket connections**, unlike Vercel serverless (which would kill the WS connection).

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Maktab e Ahle Sunnat"

# Create repo on github.com/new, then:
git remote add origin https://github.com/YOUR_USERNAME/maktab.git
git push -u origin main
```

### Step 2 — Deploy on Railway

1. Go to **[railway.app](https://railway.app)** → New Project → Deploy from GitHub
2. Select your `maktab` repo
3. Railway detects Node.js automatically

### Step 3 — Add Environment Variables

In Railway dashboard → Variables → Add these:

| Variable | Value |
|----------|-------|
| `ADMIN_USERNAME` | your-admin-username |
| `ADMIN_PASSWORD` | a-strong-password |
| `JWT_SECRET` | (generate below) |
| `NODE_ENV` | production |

**Generate JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Step 4 — Set Start Command

In Railway dashboard → Settings → Deploy:
```
npm run build && npm start
```

### Step 5 — Custom Domain (Optional)

Railway dashboard → Settings → Networking → Generate Domain
Or add your own domain (e.g. `maktab.yourdomain.com`)

✅ **Your app is live!** Railway provides a URL like `maktab-production.up.railway.app`

---

## Admin Guide

### Updating Prayer Timings

1. Go to `yoursite.com/admin/login`
2. Log in with your credentials
3. Update any prayer times
4. Click **Save All Timings** — homepage updates immediately

### Broadcasting Live Azan

1. Log in to the dashboard
2. Click **▶ Start Broadcast**
3. **Allow microphone access** when the browser asks
4. Begin the Azan — all visitors auto-receive it
5. Click **⏹ Stop** when finished

**What visitors experience:**
- If broadcast starts while they're on the page → green banner appears → tap to listen
- If they've already clicked anywhere → audio starts automatically
- Real-time audio visualizer shows while listening

---

## Technical Notes

### Why Railway over Vercel?

| Feature | Railway | Vercel |
|---------|---------|--------|
| WebSocket support | ✅ Native | ❌ Serverless only |
| Long-lived connections | ✅ Yes | ❌ No (30s max) |
| Custom Node server | ✅ Yes | ❌ No |
| Free tier | ✅ 500hrs/month | ✅ Yes but limited |

### Data Persistence

Prayer timings are stored **in-memory**. They reset on server restart. For permanent storage, add a database:

**Easiest: Railway + PostgreSQL addon**
1. Railway dashboard → Add Service → PostgreSQL
2. Use the `DATABASE_URL` env var Railway provides
3. Replace `global.__maktabTimings` with DB queries

Or use **Railway Volume** for file-based persistence:
```js
// lib/store.js — persist to /data/timings.json
import fs from 'fs';
const FILE = '/data/timings.json';
```

### Browser Support for Audio Streaming

| Browser | MediaSource | Works? |
|---------|------------|--------|
| Chrome (Android/Desktop) | ✅ | ✅ Yes |
| Firefox | ✅ | ✅ Yes |
| Safari macOS 14+ | ✅ | ✅ Yes |
| iOS Safari 15.4+ | ✅ | ✅ Yes |
| Older iOS | ❌ | ⚠️ Banner shown |

For **transmitting** (admin), Chrome or Firefox is required (MediaRecorder with WebM/Opus).

---

## File Structure

```
maktab-ws/
├── server.js              ← Custom Node server: Next.js + WebSocket
├── pages/
│   ├── index.js           ← Public homepage
│   ├── admin/
│   │   ├── login.js       ← Admin login
│   │   └── dashboard.js   ← Timings editor + Azan broadcaster
│   └── api/
│       ├── timings.js     ← GET/POST prayer timings
│       ├── broadcast-status.js  ← GET live status
│       └── auth/login.js  ← POST login → JWT
├── lib/auth.js            ← JWT sign/verify
├── styles/globals.css
├── public/manifest.json
├── next.config.js
└── package.json
```

---

*بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ*
