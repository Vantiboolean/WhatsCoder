import { AppServerClient } from './lib/app-server-client.mjs';
import { CdpClient, fetchTargetWebSocketUrl, sleep } from './lib/cdp-client.mjs';

const desktopUrl = process.env.DESKTOP_DEV_URL ?? 'http://localhost:6188/';
const appServerUrl = process.env.APP_SERVER_URL ?? 'ws://127.0.0.1:4500';
const smokeId = `SMOKE-${Date.now()}`;
const prompt = `[${smokeId}] Reply with exactly: smoke ok. Do not use tools, commands, or markdown.`;

function normalizeAssistantText(text) {
  return String(text ?? '')
    .trim()
    .replace(/[.!?]+$/g, '')
    .trim()
    .toLowerCase();
}

function extractContentText(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
        return entry.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractAgentTexts(turn) {
  return (turn?.items ?? [])
    .filter((item) => item?.type === 'agentMessage')
    .map((item) => {
      const text = typeof item.text === 'string' ? item.text : extractContentText(item.content);
      return text.trim();
    })
    .filter((text) => text.length > 0);
}

async function ensureDesktopReady(client) {
  await client.waitFor('document.readyState === "complete"');

  const recoveryState = await client.evaluate(`(() => ({
    href: location.href,
    body: document.body?.innerText?.slice(0, 300) ?? ''
  }))()`);

  if (typeof recoveryState?.href === 'string' && recoveryState.href.startsWith('chrome-error://')) {
    console.log(`[real-smoke] detected error page, forcing reload to ${desktopUrl}`);
    await client.evaluate(`(() => {
      location.href = ${JSON.stringify(desktopUrl)};
      return true;
    })()`);
    await client.waitFor('document.readyState === "complete"', 15000, 250);
  }

  const initialState = await client.waitFor(`
    (() => {
      const hasConnect = !!document.querySelector('.connect-input-row input');
      const textarea = !!document.querySelector('.bottom-bar-textarea');
      const connected = document.body?.innerText?.includes('connected');
      return hasConnect || textarea ? { hasConnect, textarea, connected } : null;
    })()
  `);

  if (initialState.hasConnect) {
    const connectResult = await client.evaluate(`
      (() => {
        const input = document.querySelector('.connect-input-row input');
        const button = document.querySelector('.connect-input-row .btn-primary');
        if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) {
          return 'connect-overlay-not-found';
        }

        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(appServerUrl)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return 'connect-clicked';
      })()
    `);
    console.log(`[real-smoke] ${connectResult}`);
  }

  await client.waitFor(`(() => {
    const connected = document.body?.innerText?.includes('connected');
    const textarea = !!document.querySelector('.bottom-bar-textarea');
    return connected && textarea;
  })()`, 30000, 250);
}

async function sendSmokePrompt(client) {
  const prepareResult = await client.evaluate(`
    (() => {
      const newThreadButton = document.querySelector('.sidebar-nav .sidebar-nav-btn');
      if (newThreadButton instanceof HTMLElement) {
        newThreadButton.click();
      }

      const textarea = document.querySelector('.bottom-bar-textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return 'textarea-not-found';
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, ${JSON.stringify(prompt)});
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      const sendButton = document.querySelector('.bottom-bar-send');
      if (!(sendButton instanceof HTMLButtonElement)) {
        return 'send-button-not-found';
      }

      sendButton.click();
      return 'sent';
    })()
  `);

  console.log(`[real-smoke] ${prepareResult}`);
  if (prepareResult !== 'sent') {
    throw new Error(`Failed to send smoke prompt: ${prepareResult}`);
  }
}

async function waitForSmokeThread(appClient) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    const result = await appClient.listThreads({
      limit: 50,
      searchTerm: smokeId,
      cwd: 'C:\\Users\\Vantiboolean\\Desktop\\codex-mobile',
    });
    const match = (result?.data ?? []).find((thread) =>
      thread?.preview?.includes(smokeId) || thread?.name?.includes(smokeId)
    );
    if (match) {
      return match;
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for smoke thread ${smokeId}`);
}

async function selectSmokeThreadInUi(client) {
  const searchResult = await client.evaluate(`
    (() => {
      const input = document.querySelector('.sidebar-search-input');
      if (!(input instanceof HTMLInputElement)) {
        return 'search-input-not-found';
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(smokeId)});
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const refreshButton = [...document.querySelectorAll('.sidebar-icon-btn')]
        .find((button) => button.getAttribute('title') === 'Refresh threads');
      if (refreshButton instanceof HTMLButtonElement) {
        refreshButton.click();
      }

      return 'search-applied';
    })()
  `);
  console.log(`[real-smoke] ${searchResult}`);

  try {
    const selection = await client.waitFor(`
      (() => {
        const target = [...document.querySelectorAll('.sidebar-thread-item')]
          .find((button) => button.textContent?.includes(${JSON.stringify(smokeId)}));
        if (!(target instanceof HTMLElement)) {
          return null;
        }

        target.click();
        return {
          selectedText: (target.textContent ?? '').trim(),
        };
      })()
    `, 10000, 250);

    console.log(`[real-smoke] selected thread in UI: ${JSON.stringify(selection)}`);
    return selection;
  } catch {
    console.log('[real-smoke] sidebar selection skipped; thread view verification will continue');
    return null;
  }
}

async function verifySettingsRoundtrip(client) {
  const settingsOpened = await client.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.sidebar-footer-btn, button')]
        .find((entry) => entry.textContent?.trim() === 'Settings');
      if (!(button instanceof HTMLButtonElement)) {
        return 'settings-button-not-found';
      }
      button.click();
      return 'settings-opened';
    })()
  `);
  console.log(`[real-smoke] ${settingsOpened}`);

  if (settingsOpened !== 'settings-opened') {
    throw new Error(`Unable to open Settings: ${settingsOpened}`);
  }

  await client.waitFor('!!document.querySelector(".settings-content")', 10000, 250);

  const restored = await client.evaluate(`
    (() => {
      const target = [...document.querySelectorAll('.sidebar-thread-item')]
        .find((button) => button.textContent?.includes(${JSON.stringify(smokeId)}));
      if (!(target instanceof HTMLElement)) {
        return { ok: false, reason: 'thread-button-not-found' };
      }

      target.click();
      return {
        ok: true,
        selectedText: (target.textContent ?? '').trim(),
      };
    })()
  `);

  if (!restored?.ok) {
    throw new Error(`Unable to restore smoke thread after Settings: ${restored?.reason ?? 'unknown'}`);
  }

  await client.waitFor(`
    (() => {
      const title = document.querySelector('.tv-title')?.textContent?.trim() ?? '';
      return title.includes(${JSON.stringify(smokeId)});
    })()
  `, 10000, 250);

  console.log(`[real-smoke] settings roundtrip restored: ${JSON.stringify(restored)}`);
  return restored;
}

async function verifyProcessingComposerState(client) {
  const snapshot = await client.waitFor(`
    (() => {
      const textarea = document.querySelector('.bottom-bar-textarea');
      const sendButton = [...document.querySelectorAll('.bottom-bar-send')]
        .find((button) => !button.classList.contains('bottom-bar-send--stop'));
      const stopButton = document.querySelector('.bottom-bar-send--stop');
      if (!(textarea instanceof HTMLTextAreaElement) || !(sendButton instanceof HTMLButtonElement) || !(stopButton instanceof HTMLButtonElement)) {
        return null;
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'follow-up while processing');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        textareaDisabled: textarea.disabled,
        placeholder: textarea.placeholder,
        sendDisabled: sendButton.disabled,
        sendClassName: sendButton.className,
        stopVisible: !stopButton.disabled,
      };
    })()
  `, 15000, 250);

  await client.evaluate(`
    (() => {
      const textarea = document.querySelector('.bottom-bar-textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) {
        return false;
      }

      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);

  console.log(`[real-smoke] processing composer: ${JSON.stringify(snapshot)}`);
  if (snapshot.textareaDisabled || snapshot.sendDisabled || !snapshot.stopVisible) {
    throw new Error(`Processing composer is not interactive enough: ${JSON.stringify(snapshot)}`);
  }
  return snapshot;
}

async function waitForSmokeCompletion(appClient, threadId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180000) {
    const thread = await appClient.readThread(threadId, true);
    if (!thread) {
      await sleep(1000);
      continue;
    }

    const turns = thread.turns ?? [];
    const lastTurn = turns[turns.length - 1];
    const agentTexts = extractAgentTexts(lastTurn);
    const exactMatch = agentTexts.find((text) => normalizeAssistantText(text) === 'smoke ok');
    if (exactMatch && lastTurn?.status === 'completed') {
      return {
        thread,
        lastTurn,
        agentTexts,
      };
    }

    if (lastTurn?.status === 'failed' || lastTurn?.status === 'interrupted') {
      throw new Error(`Smoke turn ended with status ${lastTurn.status}: ${JSON.stringify(agentTexts)}`);
    }

    await sleep(1000);
  }

  throw new Error('Timed out waiting for smoke turn completion');
}

async function waitForSmokeUiResult(client) {
  return await client.waitFor(`
    (() => {
      const activeThread = document.querySelector('.sidebar-thread-item--active');
      const title = document.querySelector('.tv-title')?.textContent?.trim() ?? null;
      const bubbles = [...document.querySelectorAll('.tv-agent-bubble')]
        .map((node) => (node.textContent ?? '').trim())
        .filter(Boolean);
      const normalizedBubbles = bubbles.map((text) =>
        String(text ?? '')
          .replace(/\bFinal\b/gi, ' ')
          .replace(/\bCommentary\b/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[.!?]+$/g, '')
          .trim()
          .toLowerCase()
      );
      const hasExactSmoke = normalizedBubbles.some((text) => text === 'smoke ok' || text.endsWith('smoke ok'));
      const stopVisible = !!document.querySelector('.bottom-bar-send--stop');
      const searchValue = document.querySelector('.sidebar-search-input')?.value ?? '';

      if (!hasExactSmoke || stopVisible) {
        return null;
      }

      return {
        activeThread: activeThread ? (activeThread.textContent ?? '').trim() : null,
        title,
        searchValue,
        bubbles: bubbles.slice(-3),
      };
    })()
  `, 120000, 500);
}

async function main() {
  const appClient = new AppServerClient(appServerUrl);
  let cdpClient = null;
  try {
    await appClient.connect();

    const wsUrl = await fetchTargetWebSocketUrl();
    cdpClient = new CdpClient(wsUrl);
    await cdpClient.connect();
    await cdpClient.send('Runtime.enable');
    await cdpClient.send('Page.enable');

    await ensureDesktopReady(cdpClient);
    await sendSmokePrompt(cdpClient);

    const smokeThread = await waitForSmokeThread(appClient);
    console.log(`[real-smoke] thread located: ${JSON.stringify({
      id: smokeThread.id,
      preview: smokeThread.preview,
      source: smokeThread.source,
      modelProvider: smokeThread.modelProvider,
      status: smokeThread.status,
    })}`);

    await selectSmokeThreadInUi(cdpClient);
    const settingsRoundtrip = await verifySettingsRoundtrip(cdpClient);
    const processingComposer = await verifyProcessingComposerState(cdpClient);

    const completion = await waitForSmokeCompletion(appClient, smokeThread.id);
    const uiResult = await waitForSmokeUiResult(cdpClient);

    console.log(`[real-smoke] ${JSON.stringify({
      ok: true,
      smokeId,
      threadId: completion.thread.id,
      turnId: completion.lastTurn.id,
      turnStatus: completion.lastTurn.status,
      agentTexts: completion.agentTexts,
      settingsRoundtrip,
      processingComposer,
      ui: uiResult,
    })}`);
  } finally {
    if (cdpClient) {
      await cdpClient.close();
    }
    await appClient.close();
  }
}

main().catch((error) => {
  console.error(`[real-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
