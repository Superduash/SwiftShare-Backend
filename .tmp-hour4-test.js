const fs = require('fs');
const path = require('path');
require('dotenv').config();
const mongoose = require('mongoose');
const Transfer = require('./models/Transfer');

const base = 'http://localhost:3001';
const tmpDir = path.join(process.cwd(), '.tmp-hour4-test');
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });
const aPath = path.join(tmpDir, 'a.txt');
const bPath = path.join(tmpDir, 'b.txt');
fs.writeFileSync(aPath, 'alpha');
fs.writeFileSync(bPath, 'beta');
const onePx = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6X0AAAAASUVORK5CYII=';

async function j(resp){ try{return await resp.json();}catch{return null;} }
function hasErrShape(obj){ return !!(obj && obj.success === false && obj.error && obj.error.code && obj.error.message); }

let ipCounter = 10;
function nextIp() { ipCounter += 1; return `10.55.1.${ipCounter}`; }

async function upload(files, burnAfterDownload=false, headers={}) {
  const fd = new FormData();
  for (const f of files) {
    const buf = fs.readFileSync(f);
    fd.append('files', new Blob([buf]), path.basename(f));
  }
  fd.append('burnAfterDownload', String(burnAfterDownload));
  const resp = await fetch(base + '/api/upload', { method: 'POST', body: fd, headers: { 'x-forwarded-for': nextIp(), ...headers } });
  return { status: resp.status, body: await j(resp), headers: resp.headers };
}

async function clipboard(headers={}) {
  const resp = await fetch(base + '/api/upload/clipboard', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
    body: JSON.stringify({ imageBase64: onePx, burnAfterDownload: false })
  });
  return { status: resp.status, body: await j(resp), headers: resp.headers };
}

async function getJson(url, headers={}) {
  const resp = await fetch(base + url, { headers: { 'x-forwarded-for': nextIp(), ...headers } });
  return { status: resp.status, body: await j(resp), headers: resp.headers };
}

async function getBin(url, headers={}) {
  const resp = await fetch(base + url, { headers: { 'x-forwarded-for': nextIp(), ...headers } });
  const buf = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, body: buf, headers: resp.headers };
}

(async () => {
  const r = {};

  const health = await getJson('/api/health');
  r.health = health.status === 200;

  const up = await upload([aPath], false);
  const codeUpload = up.body && up.body.code;
  r.upload = up.status === 200 && !!codeUpload;

  const clip = await clipboard();
  const codeClip = clip.body && clip.body.code;
  r.clipboard = clip.status === 200 && !!codeClip;

  const meta = await getJson('/api/file/' + codeUpload);
  r.metadata = meta.status === 200;

  const dl = await getBin('/api/download/' + codeUpload);
  r.download = dl.status === 200 && dl.body.length > 0;

  const nearSeed = await upload([aPath], false, { 'x-forwarded-for': '192.168.88.11' });
  const nearCode = nearSeed.body && nearSeed.body.code;
  const nearby = await getJson('/api/nearby', { 'x-forwarded-for': '192.168.88.99' });
  const nearbyList = nearby.body && Array.isArray(nearby.body.transfers) ? nearby.body.transfers : [];
  r.nearby = nearby.status === 200 && nearbyList.some(t => t.code === nearCode);

  const stats = await getJson('/api/stats');
  r.stats = stats.status === 200 && stats.body && stats.body.totalTransfers !== undefined && stats.body.activeTransfers !== undefined;

  const burnUp = await upload([aPath], true);
  const burnCode = burnUp.body && burnUp.body.code;
  const burn1 = await getBin('/api/download/' + burnCode);
  const burn2 = await getJson('/api/download/' + burnCode);
  r.burn = burn1.status === 200 && burn2.status === 410 && hasErrShape(burn2.body);

  const expUp = await upload([aPath], false);
  const expCode = expUp.body && expUp.body.code;
  await mongoose.connect(process.env.MONGODB_URI);
  await Transfer.updateOne({ code: expCode }, { $set: { expiresAt: new Date(Date.now() - 60000) } });
  await mongoose.disconnect();
  const expDl = await getJson('/api/download/' + expCode);
  r.expiry = expDl.status === 410 && expDl.body && expDl.body.error && expDl.body.error.code === 'TRANSFER_EXPIRED';

  const zipUp = await upload([aPath, bPath], false);
  const zipCode = zipUp.body && zipUp.body.code;
  const zipDl = await getBin('/api/download/' + zipCode);
  const ctype = zipDl.headers.get('content-type') || '';
  r.zip = zipDl.status === 200 && zipDl.body.length >= 2 && zipDl.body[0] === 0x50 && zipDl.body[1] === 0x4b && ctype.includes('application/zip');

  const delResp = await fetch(base + '/api/transfer/' + zipCode, { method: 'DELETE', headers: { 'x-forwarded-for': nextIp() } });
  const delJson = await j(delResp);
  r.delete = delResp.status === 200 && delJson && delJson.success === true;

  const e1 = await getJson('/api/file/abc');
  const e2 = await getJson('/api/download/abc');
  const e3Resp = await fetch(base + '/api/transfer/abc', { method: 'DELETE', headers: { 'x-forwarded-for': nextIp() } });
  const e3 = { status: e3Resp.status, body: await j(e3Resp) };
  r.errorshape = hasErrShape(e1.body) && hasErrShape(e2.body) && hasErrShape(e3.body);

  let got429 = false;
  const rateIp = '172.30.9.9';
  for (let i = 0; i < 45; i++) {
    const fd = new FormData();
    fd.append('files', new Blob([fs.readFileSync(aPath)]), 'a.txt');
    fd.append('burnAfterDownload', 'false');
    const x = await fetch(base + '/api/upload', { method: 'POST', body: fd, headers: { 'x-forwarded-for': rateIp } });
    if (x.status === 429) { got429 = true; break; }
  }
  r.ratelimit = got429;

  console.log(JSON.stringify(r));
})();
