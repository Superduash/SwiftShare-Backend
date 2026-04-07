const { io } = require("socket.io-client");

(async () => {
  const ip = `172.20.10.${Math.floor(Math.random() * 200 + 20)}`;
  const socket = io("http://localhost:3001", { transports: ["websocket"], timeout: 8000 });
  const events = {
    uploadComplete: false,
    aiReady: false,
    transferExpired: false,
  };

  socket.on("upload-complete", () => { events.uploadComplete = true; });
  socket.on("ai-ready", () => { events.aiReady = true; });
  socket.on("transfer-expired", () => { events.transferExpired = true; });

  await new Promise((resolve) => {
    socket.on("connect", resolve);
    setTimeout(resolve, 1500);
  });

  const txt = Buffer.from("socket-expiry-check");
  const fd = new FormData();
  fd.append("files", new Blob([txt], { type: "text/plain" }), "expiry.txt");
  fd.append("senderSocketId", socket.id);

  const up = await fetch("http://localhost:3001/api/upload", {
    method: "POST",
    body: fd,
    headers: { "x-forwarded-for": ip },
  });
  const upBody = await up.json();
  const data = upBody.data || upBody;

  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log(JSON.stringify({
    status: up.status,
    code: data?.code,
    events,
    socketOk: events.uploadComplete && events.aiReady && events.transferExpired,
  }));

  socket.disconnect();
})();
