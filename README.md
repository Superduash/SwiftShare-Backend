<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&height=240&color=0:111827,50:f97316,100:facc15&text=SwiftShare%20Backend&fontSize=56&fontColor=ffffff&animation=fadeIn&fontAlignY=40&desc=REST%20API%20%C2%B7%20File%20Streaming%20%C2%B7%20Real-Time%20%C2%B7%20Peer%20Discovery&descAlignY=63&descColor=f3f4f6&descSize=18"/>
</p>

<p align="center">
  <a href="https://swiftsharegg.vercel.app">
    <img src="https://img.shields.io/badge/%F0%9F%9A%80%20Live%20App-swiftsharegg.vercel.app-f97316?style=for-the-badge&labelColor=111827"/>
  </a>
  &nbsp;
  <a href="https://github.com/Superduash/SwiftShare">
    <img src="https://img.shields.io/badge/%F0%9F%8E%A8%20Frontend%20Repo-SwiftShare-facc15?style=for-the-badge&labelColor=111827"/>
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-v0.8.2-f97316?style=flat-square"/>
  <img src="https://img.shields.io/badge/Node.js_22-339933?style=flat-square&logo=node.js&logoColor=white"/>
  <img src="https://img.shields.io/badge/Express_5-black?style=flat-square&logo=express"/>
  <img src="https://img.shields.io/badge/MongoDB-47A248?style=flat-square&logo=mongodb&logoColor=white"/>
  <img src="https://img.shields.io/badge/Cloudflare_R2-F38020?style=flat-square&logo=cloudflare&logoColor=white"/>
  <img src="https://img.shields.io/badge/Socket.IO-black?style=flat-square&logo=socketdotio"/>
  <img src="https://img.shields.io/badge/Upstash_Redis-00E599?style=flat-square&logo=redis&logoColor=white"/>
</p>

The backend provides the REST API, file streaming pipeline, transfer lifecycle management, real-time WebSocket events, local peer discovery (IPv4 + IPv6), rate limiting, and administrative analytics for [SwiftShare](https://swiftsharegg.vercel.app).

---

## Contents

- [System overview](#system-overview)
- [Upload pipeline](#upload-pipeline)
- [Engineering decisions](#engineering-decisions)
- [API surface](#api-surface)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Running locally](#running-locally)

---

## System overview

```text
                         Client (browser)
                                │
                          multipart upload
                                │
                                ▼
                      Express API + Busboy parser
                                │
                 ┌──────────────┼──────────────┐
                 ▼              ▼              ▼
          Validation      Streamed to      Socket.IO
        (MIME sniff,        Cloudflare        room
       size, filename)         R2          (live progress)
                 │              │
                 └──────┬───────┘
                        ▼
                 MongoDB (transfer
                  metadata, TTL)
                        │
                        ▼
              node-cron sweep → expired
            transfers purged from R2 + DB
```

Rate limiting (Upstash Redis) and security headers (Helmet) sit in front of all endpoints. Sentry monitors errors and performance.

## Upload pipeline

1. **Streamed, not buffered.** Busboy pipes multipart requests directly into Cloudflare R2 multipart uploads as bytes arrive — files are never written to disk or held fully in memory.
2. **Mid-stream limit enforcement.** Byte count is tracked live; requests exceeding the limit are aborted and unwound immediately.
3. **Content verified, not trusted.** Client-reported MIME types are cross-checked against magic bytes — phone file managers frequently mislabel files.
4. **Filename sanitization and extension blocklist** checked before any key is written to storage, alongside dangerous executable signature detection.
5. **Metadata lands in MongoDB only after storage succeeds** — code, expiry, and burn flags are written as one consistent record.

## Engineering decisions

- **Dual-Stack Wi-Fi & Hotspot Discovery.** IPv4 `/24` subnet matching for local Wi-Fi; IPv6 `/64` prefix matching for mobile hotspot tethering. The discovery engine clusters peers across both topologies dynamically.
- **Atomic burn-after-download.** A burned transfer is claimed exactly once — validated, deleted, and responded to in a single atomic operation with a 15-second claimant disconnect grace period.
- **Per-transfer Socket.IO rooms.** Progress ticks, countdown reconciliation, and download events are pushed only to the transfer participants — not broadcast globally.
- **Scheduled expiry, not lazy reads.** A cron job sweeps expired transfers from both MongoDB and R2 on a schedule.
- **Distributed rate limiting.** Upstash Redis keeps limits consistent across server instances with an in-memory fallback.
- **Ownership tokens.** Senders receive a UUID `ownershipToken` in the upload response. The backend validates it with `crypto.timingSafeEqual` before any destructive action.
- **Granular admin aggregations.** MongoDB time-series aggregations across 24h, 7d, 30d, 90d, and all-time windows. No client-side polling — manual refresh only.

## API surface

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Stream one or more files into a new transfer |
| `GET` | `/api/download/:code` | Resolve and stream a transfer archive by code |
| `GET` | `/api/file/:code/:id` | Stream/preview a single file from a transfer |
| `GET` | `/api/transfer/:code` | Fetch transfer metadata (expiry, file list, password state) |
| `POST` | `/api/transfer/:code/extend` | Extend transfer TTL (requires ownership token) |
| `DELETE` | `/api/transfer/:code` | Cancel / delete a transfer (requires ownership token) |
| `POST` | `/api/transfer/:code/verify-password` | Verify password and obtain access token |
| `GET` | `/api/nearby` | Local Wi-Fi & Hotspot peer discovery |
| `GET` | `/api/stats` | Aggregate, non-identifying usage stats |
| `POST` | `/api/analytics/pv` | Privacy-first page view logging |
| `POST` | `/api/admin/login` | Authenticate admin session (JWT) |
| `GET` | `/api/admin/metrics` | Transfer statistics, conversion rates, storage usage |
| `GET` | `/api/admin/timeseries` | Time-series aggregations (24h, 7d, 30d, 90d, All) |
| `GET` | `/api/ping`, `/api/health` | Liveness and readiness checks |

## Tech stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22 |
| Framework | Express 5 |
| Database | MongoDB Atlas + Mongoose |
| Object storage | Cloudflare R2 (S3-compatible) |
| Real-time | Socket.IO |
| Rate limiting | Upstash Redis |
| Scheduling | node-cron |
| Monitoring | Sentry |
| Security headers | Helmet |

## Project structure

```text
SwiftShare-Backend
├── config/        # Service, database, and WebSocket configuration
├── middleware/    # Validation, rate limiting, security headers
├── models/        # MongoDB schemas (Transfer, AdminSession, PageView)
├── routes/        # API route handlers (upload, download, nearby, admin)
├── services/      # R2 storage client, cleanup sweeps, Sentry
├── utils/         # Sanitization, MIME sniffing, subnet helpers, logger
├── tests/         # Jest & Supertest automated test suites (30 tests)
└── server.js      # Main server bootstrap
```

## Running locally

```bash
git clone https://github.com/Superduash/SwiftShare-Backend.git
cd SwiftShare-Backend
npm install
npm run dev
```

```env
PORT=3001
MONGODB_URI=mongodb://localhost:27017/swiftshare
R2_ACCOUNT_ID=your_r2_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=swiftshare
R2_PUBLIC_URL=https://your-bucket.r2.dev
FRONTEND_URL=http://localhost:5173
SHARE_BASE_URL=http://localhost:5173
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
JWT_SECRET=your_jwt_secret
```

---

<p align="center">
MIT Licensed · Free to use, modify, and distribute.
</p>

<div align="center">

⭐ If you found the project interesting, consider starring the repository.

Built with ❤️ by Superduash.
</div>

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&height=110&section=footer&color=0:facc15,50:f97316,100:111827"/>
</p>
