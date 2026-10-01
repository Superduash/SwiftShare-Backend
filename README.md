<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&height=240&color=0:111827,50:f97316,100:facc15&text=SwiftShare%20Backend&fontSize=56&fontColor=ffffff&animation=fadeIn&fontAlignY=40&desc=The%20Infrastructure%20Behind%20Every%20Transfer&descAlignY=63&descColor=f3f4f6&descSize=18"/>
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

<p align="center">
  <a href="https://github.com/Superduash/SwiftShare">Frontend repo →</a>
</p>

The API and infrastructure layer for [SwiftShare](https://swiftsharegg.vercel.app) — handles every file from the moment it's selected to the moment it's deleted: streaming it to storage, generating unambiguous 6-character transfer codes, enforcing expiry/burn rules, dual-stack subnet peer discovery, and pushing real-time status back to the client over WebSockets.

---

## Contents

- [System overview](#system-overview)
- [Upload pipeline](#upload-pipeline)
- [Design decisions worth mentioning](#design-decisions-worth-mentioning)
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

Rate limiting (Upstash Redis) and security headers (Helmet) sit in front of all endpoints; Sentry monitors real-time error tracking and performance bottlenecks.

## Upload pipeline

This is the part that isn't a typical CRUD-and-multer setup, so it's worth spelling out:

1. **Streamed, not buffered.** Incoming multipart requests are parsed with Busboy and piped directly into a Cloudflare R2 multipart upload as bytes arrive — files are never written to disk or held fully in memory, even for multi-file batches.
2. **Mid-stream limit enforcement.** Total bytes received are tracked live; if a request exceeds the allowed size the stream is aborted and unwound immediately rather than rejecting only after the full body has already been received.
3. **Content is verified, not trusted.** Client-reported MIME types are cross-checked against the actual file signature (magic bytes) rather than taken at face value — phone file managers frequently mislabel screenshots and images with generic MIME types.
4. **Filenames are sanitized and extensions checked against a blocklist** before a key is ever written to storage, alongside a check for known dangerous executable file signatures.
5. **Metadata lands in MongoDB only after storage succeeds** — code generation, expiry, and burn-after-download flags are written as one consistent record, not assembled from partial state.

## Design decisions worth mentioning

- **Dual-Stack Wi-Fi & Hotspot Discovery.** Devices sharing the same local Wi-Fi router share an IPv4 `/24` subnet prefix, while devices sharing a mobile hotspot share an IPv6 `/64` network prefix. The discovery engine clusters peers across both network topologies dynamically.
- **Burn-after-download as an atomic claim, not a soft delete.** A burned transfer is claimed exactly once — the validation, the deletion trigger, and the response to the downloader happen as a single atomic operation with a 15-second claimant disconnect grace period so concurrent requests cannot duplicate a one-time download.
- **Real-time status is scoped per transfer.** Socket.IO clients join a room keyed by transfer code, so progress, countdown reconciliation ticks, and download events are pushed only to the participants involved in that specific transfer.
- **Expiry is enforced on a schedule, not on read.** A cron job sweeps and deletes expired transfers from both MongoDB and R2, so storage never accumulates orphaned files.
- **Distributed rate limiting.** Upstash Redis backs the limiter so limits hold up across multiple server instances with a graceful in-memory fallback.
- **Granular Admin Time-Series Aggregations.** Optimized MongoDB aggregations partition metrics across 24-hour, 7-day, 30-day, 90-day, and all-time windows with zero client-side automatic polling reloads.

## API surface

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Stream one or more files into a new transfer |
| `GET` | `/api/download/:code` | Resolve and stream a transfer archive by code |
| `GET` | `/api/file/:code/:id` | Stream/preview a single file from a transfer |
| `GET` | `/api/transfer/:code` | Fetch transfer metadata (expiry, file list, password state) |
| `POST` | `/api/transfer/:code/extend` | Extend transfer TTL duration (requires ownership token) |
| `DELETE` | `/api/transfer/:code` | Cancel / delete a transfer immediately (requires ownership token) |
| `POST` | `/api/transfer/:code/verify-password` | Verify transfer password and obtain access token |
| `GET` | `/api/nearby` | Local Wi-Fi & Hotspot network device discovery |
| `GET` | `/api/stats` | Aggregate, non-identifying usage stats |
| `POST` | `/api/analytics/pv` | Lightweight, privacy-first page view logging |
| `POST` | `/api/admin/login` | Authenticate admin session with secure JWT cookies |
| `GET` | `/api/admin/metrics` | Real-time transfer statistics, conversion rates, and storage usage |
| `GET` | `/api/admin/timeseries` | Granular time-series aggregations (24h, 7d, 30d, 90d, All) |
| `GET` | `/api/ping`, `/api/health` | Liveness and readiness health checks |

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
├── middleware/     # Validation, rate limiting, security headers
├── models/         # MongoDB schemas (Transfer, AdminSession, PageView)
├── routes/         # API route handlers (upload, download, nearby, admin)
├── services/        # R2 storage client, cleanup sweeps, Sentry
├── utils/           # Sanitization, MIME sniffing, subnet helpers, logger
├── tests/          # Jest & Supertest automated test suites
└── server.js       # Main server bootstrap
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

Powering SwiftShare behind the scenes.

Built with ❤️ by Superduash.
</div>

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&height=110&section=footer&color=0:facc15,50:f97316,100:111827"/>
</p>

