const { execSync } = require('child_process');

function parsePidsFromNetstat(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pids = new Set();

  for (const line of lines) {
    // Windows netstat format:
    // TCP    0.0.0.0:3001   0.0.0.0:0   LISTENING   12345
    const columns = line.split(/\s+/);
    const state = columns[3];
    const pid = columns[4];

    if (state !== 'LISTENING') continue;
    if (!pid || pid === '0') continue;
    pids.add(Number(pid));
  }

  return Array.from(pids).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function getListeningPidsWindows(port) {
  try {
    const output = execSync(`netstat -ano -p tcp | findstr :${port}`, {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString();
    return parsePidsFromNetstat(output);
  } catch {
    return [];
  }
}

function getListeningPidsUnix(port) {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString();
    return String(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((pid) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function killPidWindows(pid) {
  execSync(`taskkill /PID ${pid} /F`, { stdio: ['ignore', 'ignore', 'ignore'] });
}

function killPidUnix(pid) {
  process.kill(pid, 'SIGTERM');
}

function main() {
  const port = Number(process.argv[2] || 3001);

  if (!Number.isInteger(port) || port <= 0) {
    console.error(`[port-guard] Invalid port: ${process.argv[2]}`);
    process.exit(1);
  }

  const pids = process.platform === 'win32'
    ? getListeningPidsWindows(port)
    : getListeningPidsUnix(port);

  if (pids.length === 0) {
    console.log(`[port-guard] Port ${port} is free.`);
    return;
  }

  const failures = [];

  for (const pid of pids) {
    if (pid === process.pid) continue;

    try {
      if (process.platform === 'win32') {
        killPidWindows(pid);
      } else {
        killPidUnix(pid);
      }
      console.log(`[port-guard] Stopped PID ${pid} on port ${port}.`);
    } catch (error) {
      failures.push({ pid, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (failures.length > 0) {
    console.error(`[port-guard] Failed to free port ${port}.`);
    for (const failure of failures) {
      console.error(`- PID ${failure.pid}: ${failure.message}`);
    }
    process.exit(1);
  }

  console.log(`[port-guard] Port ${port} is now free.`);
}

main();
