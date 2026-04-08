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

## Overview

SwiftShare Backend powers transfer creation, secure download flows, and lifecycle cleanup.
It exposes REST endpoints under `/api/*`, emits real-time socket events, and manages temporary transfer state in MongoDB + R2.

## Key Backend Features

- Upload and metadata pipelines for multi-file sessions.
- Password verification endpoint for protected transfers.
- Burn-after-download flow with claim ownership and explicit finalize endpoint.
- File preview and document preview conversion routes.
- Real-time transfer updates via Socket.IO rooms.
- Automatic cleanup job for expired/deleted transfers.
- Optional AI summary support through Gemini.
- Optional rate limiting via Upstash Redis.
- Production error monitoring through Sentry integration.

## API Surface

Mounted route groups:

- `/api/upload`
- `/api/file`
- `/api/download`
- `/api/transfer`
- `/api/nearby`
- `/api/stats`

Utility endpoints:

- `GET /api/ping`
- `GET /api/health`

## Run Locally

```bash
cd Backend
npm install
cp .env.example .env
npm run dev
```

Default port: `3001`

## Environment Variables

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

Optional:

- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `SENTRY_DSN`
- tuning values such as `SESSION_EXPIRY_MINUTES`, `MAX_FILE_SIZE_MB`, `MAX_FILE_COUNT`

## Scripts

```bash
npm run dev    # nodemon development server (with port guard)
npm start      # production start
```

## Operational Notes

- `FRONTEND_URL` supports comma-separated origins for preview + production domains.
- CORS allows loopback/private hosts in non-production for easier local testing.
- Health checks include MongoDB, Redis, R2, Gemini, active transfer count, uptime, and version.

---

<p align="center">
  Backend maintained by Superduash
</p>
