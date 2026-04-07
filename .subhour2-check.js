const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3001';
const dir = path.join(process.cwd(), '.subhour2-check');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const txt = path.join(dir, 'note.txt');
const codeFile = path.join(dir, 'main.js');
const fakeExe = path.join(dir, 'fake.pdf');
fs.writeFileSync(txt, 'hello world');
fs.writeFileSync(codeFile, 'console.log("ok")');
fs.writeFileSync(fakeExe, Buffer.from([0x4D,0x5A,0x90,0x00,0x03,0x00]));

async function j(r){ try{return await r.json();}catch{return null;} }
async function upload(file, extra={}){
  const fd = new FormData();
  fd.append('files', new Blob([fs.readFileSync(file)]), path.basename(file));
  if (extra.burnAfterDownload !== undefined) fd.append('burnAfterDownload', String(extra.burnAfterDownload));
  const r = await fetch(BASE + '/api/upload', { method:'POST', body: fd, headers: extra.headers || {} });
  return { status:r.status, body: await j(r), headers:r.headers };
}
async function getJson(url){ const r = await fetch(BASE+url); return { status:r.status, body: await j(r), headers:r.headers }; }
async function getBin(url){ const r = await fetch(BASE+url); return { status:r.status, body: Buffer.from(await r.arrayBuffer()), headers:r.headers }; }

(async()=>{
  const out = {};

  const up1 = await upload(txt);
  const code = up1.body?.code;
  const meta = await getJson(`/api/file/${code}`);
  out.secondsRemaining = meta.status === 200 && typeof meta.body?.secondsRemaining === 'number';

  const status = await getJson(`/api/transfer/${code}/status`);
  const activity1 = await getJson(`/api/transfer/${code}/activity`);
  out.activityViewedUploaded = status.status === 200 && activity1.status === 200 && Array.isArray(activity1.body?.activity)
    && activity1.body.activity.some(a => a.event === 'uploaded')
    && activity1.body.activity.some(a => a.event === 'viewed');

  const dl = await getBin(`/api/download/${code}`);
  const activity2 = await getJson(`/api/transfer/${code}/activity`);
  out.activityDownloaded = dl.status === 200 && activity2.body?.activity?.some(a => a.event === 'downloaded');

  const stats = await getJson('/api/stats');
  out.averageTransferSpeed = stats.status === 200 && typeof stats.body?.averageTransferSpeed === 'number';

  const upCode = await upload(codeFile);
  const metaCode = await getJson(`/api/file/${upCode.body?.code}`);
  out.autoCodeCategory = metaCode.status === 200 && metaCode.body?.ai?.category === 'Code';

  const blockedMagic = await upload(fakeExe);
  out.magicBytesBlocked = blockedMagic.status === 400 && blockedMagic.body?.error?.code === 'INVALID_FILE_TYPE';

  const dl2 = await getBin(`/api/download/${upCode.body?.code}`);
  const st2 = await getJson(`/api/transfer/${upCode.body?.code}/status`);
  out.downloadFlowStillOK = dl2.status === 200 && st2.status === 200;

  console.log(JSON.stringify({ out, sample: { stats: stats.body, blocked: blockedMagic.body } }));
  fs.rmSync(dir, { recursive: true, force: true });
})();
