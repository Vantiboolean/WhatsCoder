import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const DEV_URL = 'http://localhost:6188';
const READY_MARKERS = ['/@vite/client', '/src/main.tsx'];
const STARTUP_RETRIES = 30;
const STARTUP_DELAY_MS = 1000;
const DESKTOP_APP_CWD = fileURLToPath(new URL('../apps/desktop/', import.meta.url));

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function probeExistingServer() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(DEV_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return { status: 'occupied', reason: `HTTP ${response.status}` };
    }

    const html = await response.text();
    const isViteServer = READY_MARKERS.every((marker) => html.includes(marker));
    return isViteServer
      ? { status: 'ready' }
      : { status: 'occupied', reason: 'listener is not the desktop Vite dev server' };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { status: 'occupied', reason: 'listener did not respond in time' };
    }

    return { status: 'missing' };
  }
}

async function waitForServerReady() {
  for (let attempt = 1; attempt <= STARTUP_RETRIES; attempt += 1) {
    const probe = await probeExistingServer();
    if (probe.status === 'ready') {
      return;
    }

    await delay(STARTUP_DELAY_MS);
  }

  throw new Error(`Vite dev server did not become ready at ${DEV_URL} within ${STARTUP_RETRIES} seconds.`);
}

async function main() {
  const probe = await probeExistingServer();

  if (probe.status === 'ready') {
    console.log(`[ensure-desktop-dev-server] Reusing existing desktop dev server at ${DEV_URL}.`);
    return;
  }

  if (probe.status === 'occupied') {
    throw new Error(`[ensure-desktop-dev-server] Port 6188 is already in use: ${probe.reason}.`);
  }

  console.log('[ensure-desktop-dev-server] Starting desktop Vite dev server on port 6188...');

  const child = spawn(getPnpmCommand(), ['dev'], {
    cwd: DESKTOP_APP_CWD,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  await waitForServerReady();

  await new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`[ensure-desktop-dev-server] Desktop dev server exited with code ${code}.`));
    });

    child.once('error', reject);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
