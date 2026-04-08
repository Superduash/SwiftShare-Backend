<div align="center">
  <img src="https://raw.githubusercontent.com/Superduash/SwiftShare/main/public/vite.svg" alt="Backend Logo" width="100" />
  
  # SwiftShare Backend

  ![Version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=for-the-badge)
  ![Node.js](https://img.shields.io/badge/node.js-22.x-green.svg?style=for-the-badge&logo=node.js&logoColor=white)
  ![Express.js](https://img.shields.io/badge/express.js-%23404d59.svg?style=for-the-badge&logo=express&logoColor=%2361DAFB)
  ![MongoDB](https://img.shields.io/badge/MongoDB-%234ea94b.svg?style=for-the-badge&logo=mongodb&logoColor=white)

  **The powerhouse backend operating SwiftShare's lightning-fast secure temporary file transfers.**
  <br />
  Featuring Socket.io real-time syncing, AI integrations, and automatic burn-on-download storage.

</div>

---

<br />

## Backend Features ✨

* **Real-time Event Architecture**: Built on Socket.io for instantaneous transfer updates and progress tracking.
* **Auto-Shred Sessions**: Implements true "burn-after-reading" logic. Once the claimant downloads a session or closes the tab, the objects (and MongoDB documents) are purged.
* **S3-Compatible Object Storage**: Optimized blob storage utilizing Cloudflare R2 (via @aws-sdk/client-s3) without excessive egress fees.
* **Stateful Fingerprinting**: SHA-256 IP/UA request fingerprinting limits session access to securely prevent hijacking.
* **Generative AI Summaries**: Integrates with Google's Gemini (@google/generative-ai) to read documents (PDFs, Word) using pdf-parse/mammoth and extract intelligent summaries.
* **Automated Packaging**: On-the-fly .zip bundling of multi-file streams via dm-zip and rchiver.
* **Robust Rate Limiting**: Redis-backed limits (@upstash/ratelimit) ensure API safety from bot attacks and abuse.

---

> *"Security, speed, and real-time synchronization elegantly packed into a single Node.js runtime."*

---

### Tech Stack 💻

| Tool | Purpose |
|------|---------|
| **Node.js 22** | Core Javascript Runtime |
| **Express.js** | Next-generation routing and API layer |
| **MongoDB / Mongoose** | Schema-enforced NoSQL sessions and logs |
| **Redis (Upstash)** | High-speed cache for rate limits |
| **Socket.io** | Bidirectional WebSocket communication |
| **AWS S3 Client** | R2 Object Storage connector |

<br />

## Getting Started 🚀

### Prerequisites
Make sure you have Node >= 22.x installed and a MongoDB instance running. Ensure you have the .env file populated.

### Installation & Run

1. **Clone the repository:**
   `ash
   git clone https://github.com/Superduash/SwiftShare-Backend.git
   `
2. **Navigate to the Backend directory:**
   `ash
   cd SwiftShare/Backend
   `
3. **Install dependencies:**
   `ash
   npm install
   `
4. **Boot up in Dev Mode:**
   `ash
   npm run dev
   `

*(Ensure ports 3001 or your configured options are available).*

<br />

## Environment Variables 🔐

Requires configuration for Redis, MongoDB, R2, Gemini, Sentry, and custom CORS scopes. See .env.example in the repo for templates.

<div align="center">
  <sub>Built with ❤️ by Superduash</sub>
</div>
