const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { io } = require("socket.io-client");

const BASE = "http://localhost:3001";
const MONGODB_URI = process.env.MONGODB_URI;

function unwrap(body) {
  if (body && typeof body === "object" && body.data && body.success === true) {
    return body.data;
  }
  return body;
}

function isErrorShape(body) {
  return Boolean(body && body.success === false && body.error && body.error.code && body.error.message);
}

async function readJson(res) {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadFiles(files, extra = {}) {
  const fd = new FormData();
  for (const file of files) {
    fd.append("files", new Blob([file.buffer]), file.name);
  }
  if (extra.burnAfterDownload !== undefined) fd.append("burnAfterDownload", String(extra.burnAfterDownload));
  if (extra.senderSocketId) fd.append("senderSocketId", extra.senderSocketId);

  const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: fd });
  const body = await readJson(res);
  return { status: res.status, body, data: unwrap(body), headers: res.headers };
}

async function clipboardUpload(base64Png) {
  const res = await fetch(`${BASE}/api/upload/clipboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: base64Png }),
  });
  const body = await readJson(res);
  return { status: res.status, body, data: unwrap(body), headers: res.headers };
}

async function getJson(url) {
  const res = await fetch(`${BASE}${url}`);
  const body = await readJson(res);
  return { status: res.status, body, data: unwrap(body), headers: res.headers };
}

async function postJson(url, payload = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await readJson(res);
  return { status: res.status, body, data: unwrap(body), headers: res.headers };
}

async function getBinary(url) {
  const res = await fetch(`${BASE}${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  if (res.status >= 400) {
    try { body = JSON.parse(buf.toString("utf8")); } catch { body = { __raw: buf.toString("utf8") }; }
  }
  return { status: res.status, buffer: buf, body, headers: res.headers };
}

(async () => {
  const out = {
    Health: false,
    Upload: false,
    Clipboard: false,
    Metadata: false,
    Preview: false,
    Download: false,
    ZIP: false,
    Burn: false,
    Expiry: false,
    Extend: false,
    Activity: false,
    Nearby: false,
    Stats: false,
    "Rate Limit": false,
    Socket: false,
    "Error Format": false,
  };

  const details = [];
  const errorBodies = [];

  const pingStart = Date.now();
  const ping = await getJson("/api/ping");
  const pingMs = Date.now() - pingStart;
  out.Health = false;
  out.Ping = ping.status === 200 && pingMs < 5000;

  const health = await getJson("/api/health");
  const healthData = unwrap(health.body);
  out.Health = health.status === 200
    && healthData?.status === "ok"
    && typeof healthData?.version === "string"
    && typeof healthData?.uptime === "number"
    && typeof healthData?.activeTransfers === "number";
  if (!out.Health) details.push({ check: "Health", health });

  const socketEvents = {
    uploadComplete: false,
    aiReady: false,
    downloadComplete: false,
  };

  const socket = io(BASE, { transports: ["websocket"], timeout: 8000 });
  await new Promise((resolve) => {
    socket.on("connect", resolve);
    setTimeout(resolve, 1500);
  });

  socket.on("upload-complete", () => { socketEvents.uploadComplete = true; });
  socket.on("ai-ready", () => { socketEvents.aiReady = true; });
  socket.on("download-complete", () => { socketEvents.downloadComplete = true; });

  const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3iYAAAAASUVORK5CYII=", "base64");
  const txt = Buffer.from("swiftshare-final-polish");

  const up = await uploadFiles([{ name: "preview.png", buffer: tinyPng }], { senderSocketId: socket.id });
  const code = up.data?.code;
  out.Upload = up.status === 200 && Boolean(up.data?.code && up.data?.qr && up.data?.expiresAt);
  if (!out.Upload) details.push({ check: "Upload", up });

  const clip = await clipboardUpload(`data:image/png;base64,${tinyPng.toString("base64")}`);
  out.Clipboard = clip.status === 200 && Boolean(clip.data?.code && clip.data?.qr && clip.data?.expiresAt);
  if (!out.Clipboard) details.push({ check: "Clipboard", clip });

  const meta = await getJson(`/api/file/${code}`);
  out.Metadata = meta.status === 200
    && Array.isArray(meta.data?.files)
    && Object.prototype.hasOwnProperty.call(meta.data || {}, "ai")
    && typeof meta.data?.secondsRemaining === "number";
  if (!out.Metadata) details.push({ check: "Metadata", meta });

  const preview = await getBinary(`/api/file/${code}/preview/0`);
  const previewType = preview.headers.get("content-type") || "";
  out.Preview = preview.status === 200 && /image|pdf/i.test(previewType) && preview.buffer.length > 0;
  if (!out.Preview) details.push({ check: "Preview", previewStatus: preview.status, previewType, size: preview.buffer.length });

  const dl = await getBinary(`/api/download/${code}`);
  out.Download = dl.status === 200 && dl.buffer.length > 0;
  if (!out.Download) details.push({ check: "Download", dlStatus: dl.status, body: dl.body });

  const zipUp = await uploadFiles([
    { name: "a.txt", buffer: txt },
    { name: "b.txt", buffer: Buffer.from("two") },
  ], { senderSocketId: socket.id });
  const zipCode = zipUp.data?.code;
  const zipDl = await getBinary(`/api/download/${zipCode}`);
  const cd = zipDl.headers.get("content-disposition") || "";
  out.ZIP = zipDl.status === 200 && /zip/i.test(cd);
  if (!out.ZIP) details.push({ check: "ZIP", zipStatus: zipDl.status, cd, body: zipDl.body });

  const burnUp = await uploadFiles([{ name: "burn.txt", buffer: txt }], { burnAfterDownload: true });
  const burnCode = burnUp.data?.code;
  const burn1 = await getBinary(`/api/download/${burnCode}`);
  const burn2 = await getBinary(`/api/download/${burnCode}`);
  if (burn2.body) errorBodies.push(burn2.body);
  out.Burn = burn1.status === 200
    && burn2.status === 410
    && burn2.body?.error?.code === "ALREADY_DOWNLOADED";
  if (!out.Burn) details.push({ check: "Burn", burn1: burn1.status, burn2: burn2.status, body: burn2.body });

  const statusRes = await getJson(`/api/transfer/${code}/status`);
  out.Status = statusRes.status === 200 && typeof statusRes.data?.status === "string";

  const ext1 = await postJson(`/api/transfer/${code}/extend`);
  const ext2 = await postJson(`/api/transfer/${code}/extend`);
  if (ext2.status >= 400) errorBodies.push(ext2.body);
  out.Extend = ext1.status === 200 && [409, 410].includes(ext2.status);
  if (!out.Extend) details.push({ check: "Extend", ext1, ext2 });

  const activity = await getJson(`/api/transfer/${code}/activity`);
  out.Activity = activity.status === 200 && Array.isArray(activity.data?.activity);
  if (!out.Activity) details.push({ check: "Activity", activity });

  if (MONGODB_URI) {
    await mongoose.connect(MONGODB_URI);
    await mongoose.connection.collection("transfers").updateOne({ code: zipCode }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
    await mongoose.disconnect();
  }
  const expiredDl = await getBinary(`/api/download/${zipCode}`);
  if (expiredDl.body) errorBodies.push(expiredDl.body);
  out.Expiry = expiredDl.status === 410 && expiredDl.body?.error?.code === "TRANSFER_EXPIRED";
  if (!out.Expiry) details.push({ check: "Expiry", expiredDl: { status: expiredDl.status, body: expiredDl.body } });

  const nearby = await getJson("/api/nearby");
  const nearbyOk = nearby.status === 200 && Array.isArray(nearby.data?.devices)
    && nearby.data.devices.every((d) => Object.prototype.hasOwnProperty.call(d, "fileCount") && Object.prototype.hasOwnProperty.call(d, "category"));
  out.Nearby = nearbyOk;
  if (!out.Nearby) details.push({ check: "Nearby", nearby });

  const stats = await getJson("/api/stats");
  const statsData = stats.data || {};
  const fakeKeys = Object.keys(statsData).filter((k) => /fake/i.test(k));
  out.Stats = stats.status === 200 && fakeKeys.length === 0;
  if (!out.Stats) details.push({ check: "Stats", stats, fakeKeys });

  let saw429 = false;
  for (let i = 0; i < 40; i += 1) {
    const spam = await uploadFiles([{ name: `spam-${i}.txt`, buffer: txt }]);
    if (spam.status === 429) {
      saw429 = true;
      errorBodies.push(spam.body);
      break;
    }
  }
  out["Rate Limit"] = saw429;
  if (!out["Rate Limit"]) details.push({ check: "Rate Limit", note: "No 429 after 40 upload attempts" });

  await delay(2000);
  out.Socket = socketEvents.uploadComplete && socketEvents.aiReady && socketEvents.downloadComplete;
  if (!out.Socket) details.push({ check: "Socket", socketEvents });

  const invalid = await getJson("/api/file/INVALID");
  if (invalid.status >= 400) errorBodies.push(invalid.body);
  const allErrorShapesValid = errorBodies.length > 0 && errorBodies.every(isErrorShape);
  out["Error Format"] = allErrorShapesValid;
  if (!out["Error Format"]) details.push({ check: "Error Format", errorBodies });

  socket.disconnect();

  console.log(JSON.stringify({ out, details }, null, 2));
})();
