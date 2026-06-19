<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&height=240&color=0:111827,50:f97316,100:facc15&text=SwiftShare%20Backend&fontSize=56&fontColor=ffffff&animation=fadeIn&fontAlignY=40&desc=The%20Infrastructure%20Behind%20Every%20Transfer&descAlignY=63&descColor=f3f4f6&descSize=18"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js_22-339933?style=flat-square&logo=node.js&logoColor=white"/>
  <img src="https://img.shields.io/badge/Express_5-black?style=flat-square&logo=express"/>
  <img src="https://img.shields.io/badge/MongoDB-47A248?style=flat-square&logo=mongodb&logoColor=white"/>
  <img src="https://img.shields.io/badge/Cloudflare_R2-F38020?style=flat-square&logo=cloudflare&logoColor=white"/>
  <img src="https://img.shields.io/badge/Socket.IO-black?style=flat-square&logo=socketdotio"/>
</p>

<p align="center">
  <a href="https://github.com/Superduash/SwiftShare">Frontend repo →</a>
</p>

The API and infrastructure layer for [SwiftShare](https://swiftsharegg.vercel.app) — handles every file from the moment it's selected to the moment it's deleted: streaming it to storage, generating the transfer code, enforcing expiry/burn rules, and pushing real-time status back to the client over WebSockets.

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

Rate limiting (Upstash Redis) and security headers (Helmet) sit in front of all of this; Sentry watches for anything that slips through.

## Upload pipeline

This is the part that isn't a typical CRUD-and-multer setup, so it's worth spelling out:

1. **Streamed, not buffered.** Incoming multipart requests are parsed with Busboy and piped directly into a Cloudflare R2 multipart upload as bytes arrive — files are never written to disk or held fully in memory, even for multi-file batches.
2. **Mid-stream limit enforcement.** Total bytes received are tracked live; if a request exceeds the allowed size the stream is aborted and unwound immediately rather than rejecting only after the full body has already been received.
3. **Content is verified, not trusted.** Client-reported MIME types are cross-checked against the actual file signature (magic bytes) rather than taken at face value — this matters in practice, since phone file managers frequently mislabel screenshots and images with the wrong MIME type.
4. **Filenames are sanitized and extensions checked against a blocklist** before a key is ever written to storage, alongside a check for known dangerous file signatures.
5. **Metadata lands in MongoDB only after storage succeeds** — code generation, expiry, and burn-after-download flags are written as one consistent record, not assembled from partial state.

## Design decisions worth mentioning

- **Burn-after-download as an atomic claim, not a soft delete.** A burned transfer is claimed exactly once — the validation, the deletion trigger, and the response to the downloader happen as a single guarded operation so two simultaneous requests can't both succeed against the same one-time file.
- **Real-time status is scoped per transfer.** Socket.IO clients join a room keyed by transfer code, so progress and download events are pushed only to the people actually involved in that transfer — not broadcast globally.
- **Expiry is enforced on a schedule, not on read.** A cron job sweeps and deletes expired transfers from both MongoDB and R2, so storage doesn't quietly accumulate orphaned files between requests.
- **Rate limiting lives outside the process.** Upstash Redis backs the limiter so limits hold up across multiple server instances, not just per-process memory.

## API surface

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/upload` | Stream one or more files into a new transfer |
| `GET` | `/api/download/:code` | Resolve and stream a transfer by code |
| `GET` | `/api/file/:code/:id` | Stream/preview a single file from a transfer |
| `GET` | `/api/transfer/:code` | Fetch transfer metadata (expiry, file list, password state) |
| `GET` | `/api/nearby` | Local-network device discovery |
| `GET` | `/api/stats` | Aggregate, non-identifying usage stats |
| `GET` | `/api/ping`, `/api/health` | Liveness / readiness checks |

## Tech stack

| Component | Technology |
|---|---|
| Runtime | Node.js 22 |
| Framework | Express 5 |
| Database | MongoDB |
| Object storage | Cloudflare R2 |
| Real-time | Socket.IO |
| Rate limiting | Upstash Redis |
| Scheduling | node-cron |
| Monitoring | Sentry |
| Security headers | Helmet |

## Project structure

```text
SwiftShare-Backend
├── config/        # Service + environment configuration
├── middleware/     # Validation, rate limiting, security headers
├── models/         # MongoDB schemas
├── routes/         # API route handlers
├── services/        # R2, Socket.IO, cleanup, mailing/etc.
├── utils/           # Sanitization, MIME sniffing, helpers
├── tests/
└── server.js
```

## Running locally

```bash
git clone https://github.com/Superduash/SwiftShare-Backend.git
cd SwiftShare-Backend
npm install
npm run dev
```

```env
MONGODB_URI=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
FRONTEND_URL=
SHARE_BASE_URL=
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
