<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=rect&height=180&color=0:1E293B,100:0F766E&text=SwiftShare%20Backend&fontSize=44&fontColor=ffffff&desc=Express%20API%20for%20secure%20temporary%20transfers&descAlignY=70" alt="SwiftShare Backend banner" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-%3E%3D22-3C873A?style=for-the-badge&logo=node.js&logoColor=white" alt="Node >=22" />
  <img src="https://img.shields.io/badge/Framework-Express%205-111827?style=for-the-badge&logo=express" alt="Express 5" />
  <img src="https://img.shields.io/badge/DB-MongoDB-0B7D3E?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" />
  <img src="https://img.shields.io/badge/Realtime-Socket.IO-111111?style=for-the-badge&logo=socket.io" alt="Socket.IO" />
  <img src="https://img.shields.io/badge/Object%20Storage-Cloudflare%20R2-F38020?style=for-the-badge" alt="Cloudflare R2" />
</p>

---

## Overview 👋

SwiftShare Backend is the modern API architecture powering secure file sharing.
The backend seemingly handles all your traffic in the background, providing you an uninterrupted, clean, and blazing fast experience when serving file streams, AI data, and socket events.

SwiftShare Backend features robust real-time updates, integrates flawlessly with your frontend themes, and includes a suite of security features like rate limiting and payload verification.

## Features ✨

- 🚀 **Lightning Fast Streams:** Upload and metadata pipelines for multi-file sessions.
- 🔒 **Password Protection:** Safe verification endpoints for locked transfers.
- 🔥 **Burn-After-Downloading:** Claimant ownership with explicit finalize endpoints.
- 👁️ **Media Previews:** Real-time file and document preview conversion routes.
- ⚡ **Real-Time Sync:** Transfer updates and progress via Socket.IO rooms.
- 🧹 **Auto-Cleanup:** Scheduled cleanup job for expired/deleted transfers.
- 🤖 **Generative AI:** Summary support through Google's Gemini Models.
- 🛡️ **Rate Limiting:** Optional Upstash Redis integrations.
- 🐛 **Error Tracking:** Production monitoring through Sentry.

> *"Does a better job than what legacy file share websites officially offer."* — **Tech Enthusiast**

## API Surface 🌐

Mounted route groups:

- 📤 `/api/upload` - File uploads
- 📄 `/api/file` - File metadata & previews
- 📥 `/api/download` - Stream resolution
- 🔄 `/api/transfer` - Transfer lifecycle
- 📡 `/api/nearby` - Local discovery
- 📊 `/api/stats` - Server metrics

Utility endpoints:

- 🏓 `GET /api/ping`
- 🏥 `GET /api/health`

## How to install 📥

```bash
cd Backend
npm install
cp .env.example .env
npm run dev
```

Default port: `3001`

## Environment Variables ⚙️

Minimum required in `.env`:

```env
MONGODB_URI=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=swiftshare
FRONTEND_URL=https://your-frontend.vercel.app
SHARE_BASE_URL=https://your-frontend.vercel.app
```

Optional Configs:

- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `SENTRY_DSN`
- tuning values such as `SESSION_EXPIRY_MINUTES`, `MAX_FILE_SIZE_MB`, `MAX_FILE_COUNT`

## Credits 🙌

- **Superduash** - Backend Architecture & Development

## Dependencies 📦

- `express`
- `mongoose`
- `socket.io`
- `@aws-sdk/client-s3` (Cloudflare R2)
- `@google/generative-ai`

---

<p align="center">
  Backend built with 💖 by Superduash
</p>
