# SwiftShare – Backend ⚙️

## Overview

SwiftShare backend powers the temporary file transfer system — handling uploads, session codes, QR generation, real-time progress, AI summaries, and automatic file deletion.

The backend uses **Node.js, Express, Socket.io, Multer, and Gemini API** to manage temporary encrypted file transfer sessions with zero permanent storage. 

---

## Core Responsibilities

* Handle file uploads
* Generate 6-digit session codes
* Generate QR codes
* Store files temporarily
* Auto-delete after download or expiry
* Provide file metadata
* Stream downloads
* Real-time upload/download progress
* AI file summary generation
* Detect nearby devices (same WiFi)

---

## Tech Stack

| Component   | Technology                 |
| ----------- | -------------------------- |
| Server      | Node.js + Express          |
| Real-time   | Socket.io                  |
| File Upload | Multer                     |
| Auto ZIP    | Archiver                   |
| Session ID  | NanoID                     |
| AI Summary  | Gemini API                 |
| Storage     | Temporary (local / memory) |
| Deployment  | Render                     |

---

## Project Structure

```
backend/
│
├── controllers/
│   ├── uploadController.js
│   ├── downloadController.js
│   ├── fileController.js
│
├── routes/
│   ├── uploadRoutes.js
│   ├── fileRoutes.js
│   ├── downloadRoutes.js
│
├── services/
│   ├── aiService.js
│   ├── zipService.js
│   ├── cleanupService.js
│
├── sockets/
│   └── transferSocket.js
│
├── utils/
│   ├── generateCode.js
│   ├── generateQR.js
│
├── storage/
│   └── tempUploads/
│
├── server.js
└── app.js
```

---

## How Backend Works

1. User uploads file → stored in temp folder
2. Server generates **session code + QR**
3. File metadata stored in memory
4. Receiver enters code → file metadata sent
5. Receiver downloads → file streamed
6. File auto-deleted after download or 10 minutes

---

## Key Features

* Temporary encrypted file storage
* Auto-delete system
* QR + 6-digit code sessions
* Real-time progress tracking
* AI file summary
* Nearby device transfer

---
