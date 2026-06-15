<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&height=240&color=0:111827,50:f97316,100:facc15&text=SwiftShare%20Backend&fontSize=56&fontColor=ffffff&animation=fadeIn&fontAlignY=40&desc=The%20Infrastructure%20Behind%20Every%20Transfer&descAlignY=63&descColor=f3f4f6&descSize=18"/>
</p>

<div align="center">

### ⚙️ Upload Pipeline • ☁️ Storage Engine • ⚡ Real-Time Events • 🛡️ Security

The backend architecture powering SwiftShare's temporary file transfer ecosystem.

<br>

<img src="https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white"/>
<img src="https://img.shields.io/badge/Express-5-black?style=for-the-badge&logo=express"/>
<img src="https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white"/>
<img src="https://img.shields.io/badge/Cloudflare_R2-F38020?style=for-the-badge&logo=cloudflare&logoColor=white"/>
<img src="https://img.shields.io/badge/Socket.IO-Real_Time-black?style=for-the-badge&logo=socketdotio"/>

<br>

### 🎨 Frontend Repository

https://github.com/Superduash/SwiftShare

</div>

---

# Overview

SwiftShare Backend manages the complete lifecycle of every transfer.

From the moment a file is uploaded until it expires, gets downloaded, or is destroyed in burn mode, the backend coordinates storage, security, transfer management, and real-time communication.

Core responsibilities include:

- File uploads
- Download streaming
- Transfer codes
- Password verification
- Burn-after-download logic
- Activity tracking
- Nearby discovery
- Cloud storage management
- Automatic cleanup

---

# Core Systems

### 📤 Upload Pipeline

- Multi-file uploads
- Streaming architecture
- Metadata generation
- Validation and sanitization
- Direct Cloudflare R2 storage

### 📥 Download System

- Direct file streaming
- ZIP downloads
- Secure transfer validation
- Download tracking

### 🔥 Burn-After-Download

Transfers can automatically self-destruct after a successful download.

The backend handles:

- One-time claims
- Ownership validation
- Automatic deletion
- Transfer invalidation

### ⚡ Real-Time Infrastructure

Powered by Socket.IO:

- Transfer updates
- Download notifications
- Activity events
- Nearby discovery broadcasts

### ☁️ Cloud Storage

Cloudflare R2 provides:

- Scalable object storage
- Fast file delivery
- Multipart uploads
- Automated cleanup integration

### 🛡 Security

Built-in protections include:

- Password-protected transfers
- Rate limiting
- MIME validation
- Dangerous file filtering
- Security headers
- Input sanitization
- Secure token generation

---

# Architecture

```text
           Client Browser
                 │
                 ▼
         Express API Server
                 │
 ┌───────────────┼─────────────┐
 ▼               ▼             ▼
MongoDB    Cloudflare R2    Socket.IO
Metadata       Files        Real-Time
```

---

# API Surface

### Uploads

```text
/api/upload
```

### Downloads

```text
/api/download
```

### Files

```text
/api/file
```

### Transfers

```text
/api/transfer
```

### Nearby Devices

```text
/api/nearby
```

### Statistics

```text
/api/stats
```

### Health Checks

```text
/api/ping
/api/health
```

---

# Technology Stack

| Component | Technology |
|------------|------------|
| Runtime | Node.js 22 |
| Framework | Express 5 |
| Database | MongoDB |
| Storage | Cloudflare R2 |
| Real-Time | Socket.IO |
| Monitoring | Sentry |
| Security | Helmet |
| Rate Limiting | Upstash Redis |
| Scheduling | Node Cron |

---

# Project Structure

```text
SwiftShare-Backend
│
├── config/
├── middleware/
├── models/
├── routes/
├── services/
├── tests/
├── utils/
│
├── server.js
├── package.json
├── render.yaml
└── .env.example
```

---

# Local Development

```bash
git clone https://github.com/Superduash/SwiftShare-Backend.git

cd SwiftShare-Backend

npm install

npm run dev
```

Required Environment Variables:

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

# Related Repository

### SwiftShare

The main project repository containing the React frontend and user experience layer.

➡️ https://github.com/Superduash/SwiftShare

---

# Engineering Goals

SwiftShare Backend was built around four principles:

- Fast
- Secure
- Temporary
- Reliable

Every transfer should be:

⚡ Fast

🔒 Secure

📦 Temporary

🌍 Accessible

---

# License

MIT License

Free to use, modify, and distribute.

---

<div align="center">

⭐ If you found the project interesting, consider starring the repository.

Powering SwiftShare behind the scenes.

Built with ❤️ by Superduash.
</div>

<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&height=110&section=footer&color=0:facc15,50:f97316,100:111827"/>
</p>
