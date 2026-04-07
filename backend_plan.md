# SwiftShare — Backend Plan (5 Hours)

> **Goal:** Fully functional, demo-ready file sharing backend. Zero errors during expo demonstration.

---

## Stack Decision (Optimized for Free + Fast)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js + Express | You know it, fast to ship |
| Database | MongoDB Atlas M0 (512MB) | Session metadata only — tiny footprint |
| Temp File Storage | Cloudflare R2 (10GB free) | Zero egress fees, S3-compatible SDK, auto-cleanup via lifecycle rules |
| Real-time | Socket.io | Upload/download progress, countdown sync, nearby device presence |
| AI | Google Gemini 1.5 Flash (free tier) | 15 RPM, 1M tokens/day — more than enough for demo |
| Rate Limiting | Upstash Redis (500K cmd/mo) | Rate limit + session expiry pub/sub |
| QR Generation | `qrcode` npm package | Server-side QR as data URI — zero external calls |
| Hosting | Render free tier | Auto-deploy from GitHub, 750 hrs/mo |
| Secrets | `.env` on Render | Doppler is overkill for 3-day sprint, use Render env vars |
| Error Tracking | Sentry free tier | Catches any demo-day crashes before judges see them |
| Domain | `swiftshare.me` via Namecheap student pack | Clean branding for expo |

### What You're NOT Using (And Why)
- **Meilisearch** — no search feature needed, skip
- **Resend** — no email flow, skip
- **Stripe/Razorpay** — no payments, skip
- **Datadog** — Sentry is enough for a 3-day project
- **Doppler** — Render env vars are fine
- **DigitalOcean Droplet** — Render free tier is simpler, no server management

---

## Architecture Overview

```
Client (React on Vercel)
  │
  ├── REST API ──► Express on Render
  │                  ├── /api/upload       → multer → R2
  │                  ├── /api/file/:code   → metadata + AI summary
  │                  ├── /api/download/:code → R2 stream → client
  │                  └── /api/nearby       → same-subnet detection
  │
  ├── WebSocket ──► Socket.io on same Express server
  │                  ├── upload-progress
  │                  ├── download-progress
  │                  ├── countdown-tick
  │                  └── nearby-presence
  │
  └── AI ──► Gemini 1.5 Flash (called server-side)
              ├── PDF/DOCX/TXT → content summary
              ├── Images → description
              ├── Any file → suggested filename + category tag
              └── Response cached in MongoDB (no repeat calls)
```

---

## Database Schema (MongoDB)

### `transfers` collection — one document per upload session

```js
{
  _id: ObjectId,
  code: "A7X9K2",                    // 6-char alphanumeric, unique index
  shortUrl: "swiftshare.me/g/A7X9K2",

  // File info
  files: [
    {
      originalName: "OS_Notes.pdf",
      storedKey: "transfers/a7x9k2/OS_Notes.pdf",  // R2 object key
      size: 2048000,                 // bytes
      mimeType: "application/pdf",
      icon: "pdf"                    // derived category for frontend icon
    }
  ],
  totalSize: 2048000,
  fileCount: 1,
  isZipped: false,                   // true if folder was auto-zipped

  // AI
  ai: {
    summary: "College notes covering OS process scheduling algorithms including FCFS, SJF, and Round Robin.",
    suggestedName: "OS_Scheduling_Notes",
    category: "Notes",               // "Assignment" | "Notes" | "Invoice" | "Image" | "Video" | "Code" | "Other"
    imageDescription: null            // populated only for image files
  },

  // Security & lifecycle
  burnAfterDownload: false,          // one-time download toggle
  downloadCount: 0,
  maxDownloads: null,                // null = unlimited, 1 = burn mode
  expiresAt: ISODate,               // created + 10 minutes
  isExpired: false,
  isDeleted: false,

  // Sender context
  senderSocketId: "socket_abc",
  senderIp: "192.168.1.5",          // for nearby detection
  senderDeviceName: "Chrome on Windows",
  qrDataUri: "data:image/png;base64,...",

  // Timestamps
  createdAt: ISODate,
  downloadedAt: ISODate | null,
  deletedAt: ISODate | null
}
```

**Indexes:**
- `{ code: 1 }` — unique, primary lookup
- `{ expiresAt: 1 }` — TTL index, MongoDB auto-deletes expired docs
- `{ senderIp: 1, isExpired: false }` — nearby device queries
- `{ createdAt: -1 }` — stats/recent transfers

---

## API Endpoints — Full Specification

### 1. `POST /api/upload`

**What it does:** Receives file(s), stores to R2, generates code + QR, triggers AI analysis, returns everything.

**Request:** `multipart/form-data`
- `files` — up to 10 files, max 500MB total
- `burnAfterDownload` — boolean (optional, default false)

**Flow:**
1. Validate: file exists, total size ≤ 500MB, file count ≤ 10
2. Generate unique 6-char alphanumeric code (retry if collision)
3. Upload each file to R2 under `transfers/{code}/{filename}`
4. Generate QR code data URI containing the share link
5. Create MongoDB document with all metadata
6. Set `expiresAt` = now + 10 minutes
7. **Async (non-blocking):** Call Gemini for AI summary — update MongoDB when done, push result via Socket.io
8. Emit `upload-complete` via Socket.io to sender
9. Return response immediately (AI summary arrives via socket later)

**Response:**
```json
{
  "success": true,
  "code": "A7X9K2",
  "shareLink": "https://swiftshare.me/g/A7X9K2",
  "qr": "data:image/png;base64,...",
  "expiresAt": "2026-04-06T15:10:00Z",
  "files": [
    { "name": "OS_Notes.pdf", "size": 2048000, "type": "application/pdf", "icon": "pdf" }
  ],
  "totalSize": 2048000,
  "burnAfterDownload": false
}
```

### 2. `GET /api/file/:code`

**What it does:** Returns file metadata + AI summary for the receiver's preview screen. Does NOT trigger download or deletion.

**Flow:**
1. Look up transfer by code
2. If not found or expired → 404 with `{ reason: "expired" | "not_found" | "already_downloaded" }`
3. Return metadata (never the file itself)

**Response:**
```json
{
  "code": "A7X9K2",
  "files": [
    { "name": "OS_Notes.pdf", "size": 2048000, "type": "application/pdf", "icon": "pdf" }
  ],
  "totalSize": 2048000,
  "fileCount": 1,
  "ai": {
    "summary": "College notes covering OS scheduling...",
    "suggestedName": "OS_Scheduling_Notes",
    "category": "Notes",
    "imageDescription": null
  },
  "expiresAt": "2026-04-06T15:10:00Z",
  "burnAfterDownload": false,
  "senderDeviceName": "Chrome on Windows"
}
```

### 3. `GET /api/download/:code`

**What it does:** Streams the actual file to the receiver. Handles cleanup.

**Flow:**
1. Look up transfer — validate not expired/deleted/burned
2. If multiple files → stream as ZIP on the fly (use `archiver` npm)
3. If single file → stream directly from R2 with correct `Content-Disposition` header
4. Increment `downloadCount`
5. Emit `download-started` and `download-progress` via Socket.io to sender
6. **After stream completes:**
   - If `burnAfterDownload` → delete from R2, mark `isDeleted: true` in MongoDB
   - If not burn → file stays until TTL expiry
7. Emit `download-complete` to both sender and receiver sockets

**Headers set:**
```
Content-Type: application/octet-stream (or actual mime type)
Content-Disposition: attachment; filename="OS_Notes.pdf"
Content-Length: 2048000
```

### 4. `GET /api/download/:code/single/:fileIndex`

**What it does:** Downloads a specific file when multiple were uploaded (receiver picks one instead of all).

Same flow as above but streams only `files[fileIndex]`.

### 5. `GET /api/nearby`

**What it does:** Returns active (non-expired) transfer sessions from the same local network.

**Flow:**
1. Extract requester's IP
2. Query MongoDB: same IP subnet (`x.x.x.*`), `isExpired: false`, `isDeleted: false`, created in last 10 min
3. Return list of active nearby sessions

**Response:**
```json
{
  "devices": [
    {
      "code": "A7X9K2",
      "deviceName": "Chrome on Windows",
      "fileCount": 1,
      "totalSize": 2048000,
      "category": "Notes"
    }
  ]
}
```

> **Note on "nearby" for demo:** On the expo WiFi, all devices will share the same public IP (behind NAT). This actually makes the feature work perfectly for demo — everyone on the expo WiFi sees each other's shares. This is a feature, not a bug. Mention this to judges as "zero-config local network discovery."

### 6. `DELETE /api/transfer/:code`

**What it does:** Sender manually cancels/deletes their transfer before expiry.

**Flow:**
1. Validate sender (match senderSocketId or senderIp)
2. Delete file(s) from R2
3. Mark MongoDB doc as deleted
4. Emit `transfer-cancelled` to any connected receivers

### 7. `GET /api/stats`

**What it does:** Returns live platform stats for the homepage hero section.

**Response:**
```json
{
  "totalTransfers": 847,
  "activeTransfers": 3,
  "totalDataShared": "12.4 GB"
}
```

> Seed with realistic fake numbers on first deploy so the demo homepage looks alive.

### 8. `POST /api/upload/clipboard`

**What it does:** Receives a base64 image from clipboard paste (Ctrl+V).

**Request:**
```json
{
  "image": "data:image/png;base64,...",
  "burnAfterDownload": false
}
```

**Flow:** Decode base64 → save as temp file → run through same upload pipeline as `POST /api/upload`.

---

## Socket.io Events — Full List

### Server → Client (sender)
| Event | Payload | When |
|---|---|---|
| `upload-progress` | `{ percent, speed, elapsed }` | During R2 upload |
| `upload-complete` | `{ code, qr, shareLink }` | Upload finished |
| `ai-ready` | `{ summary, category, suggestedName }` | Gemini analysis done |
| `download-started` | `{ receiverDevice }` | Someone started downloading |
| `download-progress` | `{ percent }` | Streaming to receiver |
| `download-complete` | `{ receiverDevice }` | Transfer finished |
| `transfer-expired` | `{ code }` | 10 min timer hit |
| `transfer-cancelled` | `{ code }` | Sender cancelled |

### Server → Client (receiver)
| Event | Payload | When |
|---|---|---|
| `download-progress` | `{ percent, speed }` | During download stream |
| `download-complete` | `{}` | File fully received |
| `transfer-expired` | `{ code }` | File expired while viewing |

### Client → Server
| Event | Payload | When |
|---|---|---|
| `join-room` | `{ code }` | Receiver enters code |
| `register-sender` | `{ code }` | Sender page loaded |
| `nearby-ping` | `{ ip }` | Discovering nearby devices |

### Rooms
Each transfer code = one Socket.io room. Sender and receiver both join `room:{code}`. All events scoped to the room.

---

## AI Integration — Gemini 1.5 Flash

### How It Works
1. Upload completes → `analyzeFile(filePath, mimeType)` called async
2. For text-based files (PDF, DOCX, TXT, code):
   - Extract text (use `pdf-parse` for PDF, `mammoth` for DOCX, raw read for TXT)
   - Send first 4000 chars to Gemini with prompt
3. For images (PNG, JPG, WEBP):
   - Send image binary to Gemini multimodal endpoint
4. For other files (ZIP, video, etc.):
   - Use filename + mime type only, ask Gemini to categorize

### Gemini Prompt Template
```
You are a file analysis assistant. Given the following file content, respond in JSON only:
{
  "summary": "2-3 sentence description of what this file contains",
  "suggestedName": "a_clean_filename_without_extension",
  "category": "one of: Assignment, Notes, Invoice, Report, Image, Video, Code, Presentation, Spreadsheet, Other",
  "imageDescription": "if image, describe what's in it, otherwise null"
}

File name: {{filename}}
File type: {{mimeType}}
Content preview:
{{contentPreview}}
```

### Caching
- AI result stored in MongoDB `ai` field on the transfer document
- `GET /api/file/:code` returns cached result — Gemini called only once per upload
- If Gemini fails (rate limit/timeout), `ai` field = `null`, frontend shows "AI analysis unavailable" gracefully

### Rate Limit Safety
- Gemini free tier: 15 requests/minute
- For demo: you'll upload maybe 20 files total across the whole expo — nowhere near the limit
- Add a simple in-memory counter as safety net, skip AI if over 14 RPM

---

## File Handling Details

### Upload Pipeline
```
Browser → multer (memory storage, 500MB limit)
  → validate file type + size
  → generate unique code
  → upload to R2 via @aws-sdk/client-s3 (S3-compatible)
  → create MongoDB doc
  → return response
  → async: AI analysis → update doc → socket emit
```

### Why Multer Memory Storage (Not Disk)
- Render free tier has ephemeral disk — files vanish on restart
- Memory buffer → direct stream to R2 = no temp file dependency
- 500MB limit keeps memory safe (Render gives 512MB RAM on free)
- For files > ~200MB: use multer disk to `/tmp` then stream to R2 (fallback)

### R2 Object Structure
```
bucket: swiftshare
├── transfers/
│   ├── a7x9k2/
│   │   ├── OS_Notes.pdf
│   │   └── Lecture_3.pdf
│   ├── b3m7p1/
│   │   └── screenshot.png
```

### R2 Lifecycle Rule
- Set a lifecycle rule on the R2 bucket: **delete all objects older than 15 minutes**
- This is your safety net — even if MongoDB TTL or manual deletion fails, R2 cleans itself
- Configure via Cloudflare dashboard → R2 → bucket settings → Object lifecycle

### Auto-ZIP for Folders
- If user drops a folder, frontend sends all files with relative paths
- Backend receives them, uses `archiver` to create a ZIP in memory
- Uploads single ZIP to R2
- Transfer metadata shows original file list but download streams the ZIP

---

## Security & Rate Limiting

### Session Code Generation
```js
// 6-char alphanumeric, 2.17 billion combinations
const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // removed 0/O/1/I to avoid confusion
function generateCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}
```
- Check MongoDB for collision before saving (retry up to 3 times)
- Ambiguous characters removed (0, O, 1, I) — judges will notice this UX detail

### Rate Limiting (Upstash Redis)
- `POST /api/upload` → 10 uploads per IP per hour
- `GET /api/download/:code` → 30 downloads per IP per hour
- `GET /api/file/:code` → 60 lookups per IP per hour
- Use `@upstash/ratelimit` SDK — 3 lines of code

### Input Validation
- File size: reject > 500MB immediately with clear error
- File count: max 10 per upload
- Code format: must match `/^[A-Z2-9]{6}$/` — reject anything else before DB query
- Mime type: no `.exe`, `.bat`, `.sh`, `.cmd` — basic blocklist for demo safety
- Filename sanitization: strip path traversal characters (`../`, etc.)

### CORS
- Allow only your Vercel frontend origin
- Socket.io CORS configured separately (same origin)

### Helmet.js
- Add `helmet()` middleware — sets security headers automatically
- One line, significant security improvement, judges check for this

---

## Cleanup System

Three layers of cleanup (belt + suspenders + duct tape):

1. **MongoDB TTL Index** — `expiresAt` field, MongoDB auto-deletes docs after expiry
2. **R2 Lifecycle Rule** — objects auto-deleted after 15 minutes
3. **Cron Job (backup)** — runs every 5 minutes via `node-cron`:
   - Query transfers where `expiresAt < now` AND `isDeleted: false`
   - Delete from R2
   - Mark as deleted in MongoDB
   - This catches edge cases where TTL or lifecycle missed something

> **Why three layers:** During demo, a judge might ask "what if deletion fails?" — you say "triple redundancy" and they're impressed.

---

## Error Handling Strategy

### Global Error Handler
```js
app.use((err, req, res, next) => {
  console.error(err);
  Sentry.captureException(err); // if Sentry is configured
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Something went wrong',
    code: err.code || 'INTERNAL_ERROR'
  });
});
```

### Specific Error Codes (Frontend Can React to These)
| Code | Meaning |
|---|---|
| `FILE_TOO_LARGE` | Over 500MB |
| `TOO_MANY_FILES` | Over 10 files |
| `BLOCKED_FILE_TYPE` | .exe etc |
| `CODE_NOT_FOUND` | No transfer with that code |
| `TRANSFER_EXPIRED` | Past expiry time |
| `ALREADY_DOWNLOADED` | Burn-after-download was on |
| `RATE_LIMITED` | Too many requests |
| `AI_UNAVAILABLE` | Gemini failed, non-fatal |
| `UPLOAD_FAILED` | R2 upload error |

### Graceful Degradation
- If Redis is down → skip rate limiting, continue working
- If Gemini is down → skip AI, return `ai: null`
- If R2 upload fails → retry once, then return error
- If MongoDB is down → nothing works, return 503 with "Try again in a moment"

---

## Environment Variables

```env
# MongoDB
MONGODB_URI=mongodb+srv://...

# Cloudflare R2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=swiftshare
R2_PUBLIC_URL=https://pub-xxx.r2.dev  # if using public bucket, otherwise generate presigned URLs

# Gemini
GEMINI_API_KEY=

# Upstash Redis
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=

# App
PORT=3001
NODE_ENV=production
FRONTEND_URL=https://swiftshare.vercel.app
SESSION_EXPIRY_MINUTES=10
MAX_FILE_SIZE_MB=500

# Sentry (optional but recommended)
SENTRY_DSN=
```

---

## NPM Dependencies

```json
{
  "dependencies": {
    "express": "^4.18",
    "cors": "^2.8",
    "helmet": "^7.1",
    "morgan": "^1.10",
    "multer": "^1.4",
    "mongoose": "^8.0",
    "socket.io": "^4.7",
    "@aws-sdk/client-s3": "^3.500",
    "@aws-sdk/lib-storage": "^3.500",
    "@upstash/redis": "^1.28",
    "@upstash/ratelimit": "^1.0",
    "qrcode": "^1.5",
    "@google/generative-ai": "^0.21",
    "pdf-parse": "^1.1",
    "mammoth": "^1.6",
    "archiver": "^7.0",
    "node-cron": "^3.0",
    "dotenv": "^16.3",
    "uuid": "^9.0",
    "@sentry/node": "^7.0"
  }
}
```

**Total: 18 packages. No bloat.**

---

## Project File Structure

```
swiftshare-backend/
├── server.js                    # Entry point — Express + Socket.io init
├── .env                         # Environment variables (not committed)
├── package.json
│
├── config/
│   ├── db.js                    # MongoDB connection
│   ├── r2.js                    # Cloudflare R2 S3 client
│   ├── redis.js                 # Upstash Redis client
│   ├── gemini.js                # Gemini AI client
│   └── socket.js                # Socket.io setup + room logic
│
├── routes/
│   ├── upload.js                # POST /api/upload, POST /api/upload/clipboard
│   ├── file.js                  # GET /api/file/:code
│   ├── download.js              # GET /api/download/:code, GET /api/download/:code/single/:index
│   ├── nearby.js                # GET /api/nearby
│   ├── transfer.js              # DELETE /api/transfer/:code
│   └── stats.js                 # GET /api/stats
│
├── middleware/
│   ├── rateLimiter.js           # Upstash rate limiting
│   ├── validateUpload.js        # File size, count, type validation
│   ├── validateCode.js          # Code format regex check
│   └── errorHandler.js          # Global error handler
│
├── services/
│   ├── codeGenerator.js         # 6-char code gen + collision check
│   ├── aiAnalyzer.js            # Gemini integration — summary, category, filename
│   ├── fileManager.js           # R2 upload, download stream, delete
│   ├── qrGenerator.js           # QR code data URI generation
│   ├── zipService.js            # Auto-ZIP for folders / multi-file download
│   └── cleanupService.js        # Cron job + manual cleanup
│
├── models/
│   └── Transfer.js              # Mongoose schema + indexes
│
└── utils/
    ├── constants.js             # Max sizes, allowed types, error codes
    ├── helpers.js               # IP extraction, device name parsing, mime-to-icon mapping
    └── logger.js                # Console wrapper (swap for winston if needed)
```

---

## Hour-by-Hour Build Plan

### Hour 1 (0:00 – 1:00) — Foundation + Upload

**Goal:** Server running, file upload to R2 working, code generated.

1. `npm init -y` + install all 18 dependencies
2. Create `server.js` — Express + CORS + Helmet + Morgan + Socket.io
3. Create `config/db.js` — MongoDB Atlas connection
4. Create `config/r2.js` — S3 client pointing to Cloudflare R2
5. Create `models/Transfer.js` — full schema with all indexes
6. Create `services/codeGenerator.js` — 6-char code with collision check
7. Create `services/qrGenerator.js` — QR data URI from share link
8. Create `middleware/validateUpload.js` — size, count, type checks
9. Create `routes/upload.js` — `POST /api/upload`
   - Multer memory storage
   - Validate → generate code → upload to R2 → save to MongoDB → return response
10. Test with Postman/curl — upload a file, get back code + QR

**Checkpoint:** You can upload a file and get a 6-digit code back. ✅

### Hour 2 (1:00 – 2:00) — Download + Metadata + Expiry

**Goal:** Full upload → share code → download flow working.

1. Create `routes/file.js` — `GET /api/file/:code` (metadata only)
2. Create `routes/download.js` — `GET /api/download/:code`
   - Stream from R2 → response with correct headers
   - Increment download count
   - If burn mode → delete from R2 + mark deleted
3. Create `routes/download.js` — add `/single/:fileIndex` route
4. Create `middleware/validateCode.js` — regex format check
5. Create `services/cleanupService.js`
   - `node-cron` every 5 minutes
   - Find expired transfers → delete from R2 → mark deleted
6. Add MongoDB TTL index on `expiresAt` in the Transfer model
7. Create `routes/transfer.js` — `DELETE /api/transfer/:code`
8. Create `middleware/errorHandler.js` — global handler with error codes
9. Create `utils/constants.js` — all magic numbers, error codes, allowed types
10. Test full flow: upload → get code → fetch metadata → download → verify burn mode

**Checkpoint:** Complete upload → download flow works. Burn-after-download works. Expired files auto-delete. ✅

### Hour 3 (2:00 – 3:00) — Socket.io + AI Integration

**Goal:** Real-time progress events working. AI summaries returning.

1. Create `config/socket.js` — Socket.io setup, room management
   - `join-room` / `register-sender` handlers
   - Helper: `emitToRoom(code, event, data)`
2. Wire Socket.io into upload route — emit `upload-complete`
3. Wire Socket.io into download route — emit `download-started`, `download-progress`, `download-complete`
4. Add countdown timer — on upload, schedule `transfer-expired` emit at `expiresAt`
5. Create `config/gemini.js` — Gemini client init
6. Create `services/aiAnalyzer.js`
   - `analyzeFile(buffer, filename, mimeType)` → extracts text → calls Gemini → returns JSON
   - PDF text extraction via `pdf-parse`
   - DOCX text extraction via `mammoth`
   - Image → Gemini multimodal
   - Fallback: filename + mime only
   - In-memory rate counter (skip if > 14 RPM)
7. Wire AI into upload route (async, non-blocking):
   - After R2 upload, call `analyzeFile` in background
   - On completion, update MongoDB `ai` field + emit `ai-ready` via Socket.io
8. Test: upload a PDF → check AI summary appears → check socket events fire

**Checkpoint:** Upload a PDF, see AI summary in metadata response. Socket events fire correctly. ✅

### Hour 4 (3:00 – 4:00) — Nearby + Clipboard + Stats + Rate Limiting + Polish

**Goal:** All remaining features working. Rate limiting active. Demo-ready.

1. Create `routes/nearby.js` — `GET /api/nearby`
   - Extract IP, match subnet, return active transfers from same network
   - Parse `x-forwarded-for` header (important behind Render's proxy)
2. Create `routes/upload.js` — add `POST /api/upload/clipboard`
   - Accept base64 image → decode → pipe through same upload flow
3. Create `routes/stats.js` — `GET /api/stats`
   - Count total transfers, active transfers, sum total bytes
   - Seed initial fake counts for demo (set in DB or constants)
4. Create `config/redis.js` — Upstash client
5. Create `middleware/rateLimiter.js` — per-endpoint rate limits
   - Wrap in try-catch: if Redis fails, skip limiting (graceful degradation)
6. Create `services/zipService.js` — multi-file ZIP streaming with `archiver`
7. Create `utils/helpers.js` — IP extraction, user-agent → device name, mime → icon mapping
8. Add `morgan` request logging for debugging
9. Review ALL error paths:
   - Upload with no file → proper error
   - Invalid code format → proper error
   - Expired code → proper error with reason
   - Download burned file → proper error
   - File too large → proper error
   - Blocked file type → proper error
10. Test every error scenario. Fix anything broken.

**Checkpoint:** All endpoints working. Rate limiting active. Every error returns a clean JSON response. ✅

### Hour 5 (4:00 – 5:00) — Deploy + Integration Test + Demo Prep

**Goal:** Live on Render. Tested end-to-end from phone + laptop. Zero bugs.

1. Create `.gitignore` — node_modules, .env
2. Push to GitHub
3. Create Render web service:
   - Connect GitHub repo
   - Set all environment variables
   - Build command: `npm install`
   - Start command: `node server.js`
4. Configure R2 lifecycle rule — auto-delete after 15 minutes (Cloudflare dashboard)
5. **Test every endpoint against the LIVE deployed URL:**
   - Upload a file from laptop → get code
   - Open phone browser → enter code → see metadata + AI summary
   - Download on phone → verify file is correct
   - Upload with burn mode → download → try again → confirm "already downloaded"
   - Wait 10 minutes → confirm expired
   - Upload from phone → check nearby on laptop (same WiFi)
   - Ctrl+V clipboard upload (test on deploy)
   - Hit rate limit intentionally → confirm 429 response
   - Upload blocked file type → confirm rejection
6. Seed stats endpoint with realistic numbers
7. Add `console.log` timestamps to every major action for live demo debugging
8. **Final check:** restart Render service, upload one file, download it — everything still works

**Checkpoint:** Live on Render. Tested from multiple devices. Ready for frontend integration. ✅

---

## Demo Day Tips (Built Into the Backend)

These are already part of the plan above, but calling them out so you don't miss them during demo:

1. **Seeded stats** — homepage shows "847 transfers completed" not "0"
2. **Ambiguous char removal** — mention to judges that 0/O/1/I are excluded from codes
3. **Triple cleanup** — TTL + lifecycle + cron = "triple redundancy"
4. **Nearby works on expo WiFi** — all attendees behind same NAT = automatic discovery
5. **AI runs async** — upload returns instantly, summary appears via websocket = feels fast
6. **Graceful degradation** — if any service is down, the core transfer still works
7. **No account needed** — say this explicitly, it's your #1 differentiator vs LimeWire
8. **Burn-after-download** — visually dramatic for demo, upload → download → try again → "gone"
9. **QR across the room** — have a judge scan your QR from their seat, instant wow factor

---

## What's NOT in Backend (Frontend Will Handle)

- Drag & drop UI
- OTP-style code input
- Countdown ring animation
- Confetti on transfer complete
- Dark/light mode toggle
- Glassmorphism styling
- File type icons
- Skeleton loading screens
- Toast notifications
- Device-responsive layout
- "How it works" explainer
- About page with architecture diagram

These are all purely frontend — no backend endpoint needed. Listed here so you don't waste time adding backend support for visual features.
