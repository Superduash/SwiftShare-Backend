require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  const ip = `123.45.67.${Math.floor(Math.random() * 200 + 20)}`;
  const txt = Buffer.from("x");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3iYAAAAASUVORK5CYII=", "base64");

  const fd1 = new FormData();
  fd1.append("files", new Blob([png], { type: "image/png" }), "preview.png");
  const up1 = await fetch("http://localhost:3001/api/upload", {
    method: "POST",
    body: fd1,
    headers: { "x-forwarded-for": ip },
  });
  const b1 = await up1.json();
  const d1 = b1.data || b1;

  const p = await fetch(`http://localhost:3001/api/file/${d1.code}/preview/0`);
  const pbuf = Buffer.from(await p.arrayBuffer());

  const fd2 = new FormData();
  fd2.append("files", new Blob([txt], { type: "text/plain" }), "exp.txt");
  const up2 = await fetch("http://localhost:3001/api/upload", {
    method: "POST",
    body: fd2,
    headers: { "x-forwarded-for": ip },
  });
  const b2 = await up2.json();
  const d2 = b2.data || b2;

  await mongoose.connect(process.env.MONGODB_URI);
  const r = await mongoose.connection.collection("transfers").updateOne(
    { code: d2.code },
    { $set: { expiresAt: new Date(Date.now() - 120000) } },
  );
  await mongoose.disconnect();

  const ex = await fetch(`http://localhost:3001/api/download/${d2.code}`);
  const exTxt = await ex.text();

  console.log(JSON.stringify({
    up1: up1.status,
    previewStatus: p.status,
    previewCt: p.headers.get("content-type"),
    previewSize: pbuf.length,
    up2: up2.status,
    update: {
      acknowledged: r.acknowledged,
      matchedCount: r.matchedCount,
      modifiedCount: r.modifiedCount,
    },
    expiredStatus: ex.status,
    expiredBody: exTxt.slice(0, 140),
  }));
})();
