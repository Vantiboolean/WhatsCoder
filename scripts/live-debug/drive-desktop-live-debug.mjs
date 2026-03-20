import { CdpClient, fetchTargetWebSocketUrl, sleep } from './lib/cdp-client.mjs';

const desktopUrl = process.env.DESKTOP_DEV_URL ?? 'http://localhost:6188/';
const appServerUrl = process.env.APP_SERVER_URL ?? 'ws://127.0.0.1:4500';
const threadMatch = process.env.LIVE_DEBUG_THREAD_MATCH ?? 'Live Debug Requests';
const mockAccessToken = process.env.MOCK_CHATGPT_ACCESS_TOKEN ?? 'mock-access-token';
const mockAccountId = process.env.MOCK_CHATGPT_ACCOUNT_ID ?? 'acc-desktop-live-debug';
const mockPlanType = process.env.MOCK_CHATGPT_PLAN_TYPE ?? 'plus';

async function ensureDesktopReady(client) {
  await client.waitFor('document.readyState === "complete"');

  const recoveryState = await client.evaluate(`(() => ({
    href: location.href,
    body: document.body?.innerText?.slice(0, 300) ?? ''
  }))()`);

  if (typeof recoveryState?.href === 'string' && recoveryState.href.startsWith('chrome-error://')) {
    console.log(`[live-debug] detected error page, forcing reload to ${desktopUrl}`);
    await client.evaluate(`(() => {
      location.href = ${JSON.stringify(desktopUrl)};
      return true;
    })()`);
    await client.waitFor('document.readyState === "complete"', 15000, 250);
  }

  const initialState = await client.waitFor(`
    (() => {
      const hasConnect = !!document.querySelector('.connect-input-row input');
      const hasThreadList = !!document.querySelector('.sidebar-thread-list');
      const hasDisconnect = !![...document.querySelectorAll('.sidebar-icon-btn')]
        .find((button) => button.getAttribute('title') === 'Disconnect');
      return hasConnect || hasThreadList
        ? {
            hasConnect,
            hasDisconnect,
            hasThreads: !!document.querySelector('.sidebar-thread-item'),
            threadCount: document.querySelectorAll('.sidebar-thread-item').length,
            title: document.title,
            body: document.body?.innerText?.slice(0, 400) ?? '',
          }
        : null;
    })()
  `);
  console.log(`[live-debug] initial state: ${JSON.stringify(initialState)}`);

  if (!initialState.hasConnect && initialState.hasDisconnect) {
    const disconnectResult = await client.evaluate(`
      (() => {
        const button = [...document.querySelectorAll('.sidebar-icon-btn')]
          .find((entry) => entry.getAttribute('title') === 'Disconnect');
        if (!(button instanceof HTMLButtonElement)) {
          return 'disconnect-button-not-found';
        }
        button.click();
        return 'disconnect-clicked';
      })()
    `);
    console.log(`[live-debug] ${disconnectResult}`);
    await client.waitFor('!!document.querySelector(".connect-input-row input")', 15000, 250);
  }

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
  console.log(`[live-debug] ${connectResult}`);
  await client.waitFor('document.querySelectorAll(".sidebar-thread-item").length >= 0 && !!document.querySelector(".sidebar-thread-list")', 30000, 250);
}

async function selectLiveDebugThread(client) {
  await client.evaluate(`
    (() => {
      const searchInput = document.querySelector('.sidebar-search-input');
      if (searchInput instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(searchInput, ${JSON.stringify(threadMatch)});
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const refreshButton = [...document.querySelectorAll('.sidebar-icon-btn')]
        .find((button) => button.getAttribute('title') === 'Refresh threads');
      if (refreshButton instanceof HTMLButtonElement) {
        refreshButton.click();
      }

      const groupToggles = [...document.querySelectorAll('.thread-group-toggle')];
      groupToggles.forEach((toggle) => {
        const chevron = toggle.querySelector('.thread-group-chevron');
        const isOpen = chevron?.classList.contains('thread-group-chevron--open') === true;
        if (!isOpen && toggle instanceof HTMLButtonElement) {
          toggle.click();
        }
      });

      if (refreshButton instanceof HTMLButtonElement) {
        return 'refresh-clicked / groups=' + groupToggles.length;
      }
      return 'refresh-missing / groups=' + groupToggles.length;
    })()
  `);

  await client.waitFor(`
    (() => {
      const groupToggles = [...document.querySelectorAll('.thread-group-toggle')];
      groupToggles.forEach((toggle) => {
        const chevron = toggle.querySelector('.thread-group-chevron');
        const isOpen = chevron?.classList.contains('thread-group-chevron--open') === true;
        if (!isOpen && toggle instanceof HTMLButtonElement) {
          toggle.click();
        }
      });
      const buttons = [...document.querySelectorAll('.sidebar-thread-item')];
      return buttons.some((button) => button.textContent?.includes(${JSON.stringify(threadMatch)}));
    })()
  `, 30000, 250);

  const selectedThread = await client.evaluate(`
    (() => {
      const buttons = [...document.querySelectorAll('.sidebar-thread-item')];
      const target = buttons.find((button) => button.textContent?.includes(${JSON.stringify(threadMatch)})) ?? buttons[0];
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      target.click();
      return (target.textContent ?? '').trim();
    })()
  `);

  if (!selectedThread) {
    throw new Error(`Unable to select live-debug thread matching "${threadMatch}"`);
  }

  console.log(`[live-debug] selected thread: ${selectedThread}`);
}

async function handleVisibleModal(client) {
  const state = await client.evaluate(`(() => {
    if (document.querySelector('.auth-refresh-card')) {
      return { kind: 'auth-refresh' };
    }
    const elicitation = document.querySelector('.elicitation-card');
    if (elicitation) {
      return {
        kind: 'elicitation',
        mode: elicitation.querySelector('.elicitation-url-block') ? 'url' : 'form',
      };
    }
    const dynamic = document.querySelector('.dynamic-tool-card');
    if (dynamic) {
      return {
        kind: 'dynamic-tool',
        tool: dynamic.querySelector('.user-input-progress')?.textContent?.trim() ?? '',
      };
    }
    return null;
  })()`);

  if (!state) {
    return null;
  }

  if (state.kind === 'auth-refresh') {
    const result = await client.evaluate(`
      (() => {
        const root = document.querySelector('.auth-refresh-card');
        if (!root) {
          return 'auth-refresh-card-not-found';
        }

        const token = root.querySelector('textarea.auth-refresh-token');
        const account = root.querySelector('input.auth-refresh-account-id');
        const plan = root.querySelector('input.auth-refresh-plan-type');
        const submitButton = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('Submit token'));

        if (!(token instanceof HTMLTextAreaElement) || !(account instanceof HTMLInputElement) || !(plan instanceof HTMLInputElement) || !(submitButton instanceof HTMLButtonElement)) {
          return 'auth-refresh-fields-not-found';
        }

        const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

        textareaSetter.call(token, ${JSON.stringify(mockAccessToken)});
        token.dispatchEvent(new Event('input', { bubbles: true }));

        inputSetter.call(account, ${JSON.stringify(mockAccountId)});
        account.dispatchEvent(new Event('input', { bubbles: true }));

        inputSetter.call(plan, ${JSON.stringify(mockPlanType)});
        plan.dispatchEvent(new Event('input', { bubbles: true }));

        submitButton.click();
        return 'auth-refresh-submitted';
      })()
    `);
    return { kind: 'auth-refresh', result };
  }

  if (state.kind === 'elicitation') {
    const result = await client.evaluate(`
      (() => {
        const root = document.querySelector('.elicitation-card');
        if (!root) {
          return 'elicitation-card-not-found';
        }

        if (root.querySelector('.elicitation-url-block')) {
          const primary = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes("completed"));
          if (!(primary instanceof HTMLButtonElement)) {
            return 'elicitation-url-submit-not-found';
          }
          primary.click();
          return 'elicitation-url-submitted';
        }

        const textFields = root.querySelectorAll('textarea.elicitation-input, input.elicitation-input');
        const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

        textFields.forEach((field) => {
          const label = field.closest('.elicitation-field')?.querySelector('.elicitation-label')?.textContent?.toLowerCase() ?? '';
          const nextValue =
            label.includes('email') ? 'desktop-live-debug@example.com'
            : label.includes('url') || label.includes('uri') ? 'https://example.com/live-debug'
            : label.includes('date') ? '2026-03-20'
            : 'desktop-live-debug';

          if (field instanceof HTMLTextAreaElement) {
            textareaSetter.call(field, nextValue);
            field.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (field instanceof HTMLInputElement) {
            inputSetter.call(field, nextValue);
            field.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });

        const select = root.querySelector('select.elicitation-input');
        if (select instanceof HTMLSelectElement) {
          const nextValue = [...select.options].find((option) => option.value === 'high')?.value
            ?? [...select.options].find((option) => option.value)?.value
            ?? '';
          select.value = nextValue;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const checkbox = root.querySelector('.elicitation-checkbox-row input');
        if (checkbox instanceof HTMLInputElement && !checkbox.checked) {
          checkbox.click();
        }

        const submitButton = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('Submit'));
        if (!(submitButton instanceof HTMLButtonElement)) {
          return 'elicitation-submit-not-found';
        }
        submitButton.click();
        return 'elicitation-submitted';
      })()
    `);
    return { kind: 'elicitation', mode: state.mode, result };
  }

  if (state.kind === 'dynamic-tool') {
    const result = await client.evaluate(`
      (() => {
        const root = document.querySelector('.dynamic-tool-card');
        if (!root) {
          return 'dynamic-tool-card-not-found';
        }

        const tool = root.querySelector('.user-input-progress')?.textContent?.trim().toLowerCase() ?? '';
        const textareas = root.querySelectorAll('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;

        if (textareas[0]) {
          const textValue = tool.includes('failure')
            ? 'Mock failure response from desktop live debug.'
            : tool.includes('empty')
            ? ''
            : 'Ticket ABC-123 is open and assigned to desktop-live-debug.';
          setter.call(textareas[0], textValue);
          textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
        }

        if (textareas[1]) {
          const imageValue = tool.includes('multi')
            ? 'https://example.com/mock-ticket-abc-123.png\\nhttps://example.com/mock-ticket-abc-123-2.png'
            : tool.includes('empty') || tool.includes('failure')
            ? ''
            : 'https://example.com/mock-ticket-abc-123.png';
          setter.call(textareas[1], imageValue);
          textareas[1].dispatchEvent(new Event('input', { bubbles: true }));
        }

        const buttons = [...root.querySelectorAll('button')];
        const submitButton = tool.includes('failure')
          ? buttons.find((button) => button.textContent?.includes('Return failure'))
          : buttons.find((button) => button.textContent?.includes('Return success'));

        if (!(submitButton instanceof HTMLButtonElement)) {
          return 'dynamic-submit-not-found';
        }

        submitButton.click();
        return tool.includes('failure') ? 'dynamic-tool-failure-submitted' : 'dynamic-tool-success-submitted';
      })()
    `);
    return { kind: 'dynamic-tool', tool: state.tool, result };
  }

  return null;
}

async function main() {
  const wsUrl = await fetchTargetWebSocketUrl();
  const client = new CdpClient(wsUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');

  await ensureDesktopReady(client);
  await selectLiveDebugThread(client);

  const handled = [];
  let idleRounds = 0;

  while (idleRounds < 10) {
    const handledState = await handleVisibleModal(client);
    if (handledState) {
      console.log(`[live-debug] ${JSON.stringify(handledState)}`);
      handled.push(handledState);
      idleRounds = 0;
      await sleep(500);
      continue;
    }

    idleRounds += 1;
    await sleep(500);
  }

  const threadSnapshot = await client.evaluate(`
    (() => ({
      title: document.querySelector('.tv-title')?.textContent?.trim() ?? null,
      body: document.querySelector('.tv-container')?.innerText?.slice(0, 2000) ?? null,
      toast: document.querySelector('.toast')?.innerText ?? null
    }))()
  `);

  const settingsState = await client.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.sidebar-footer-btn, .sidebar-nav-btn, button')]
        .find((entry) => entry.textContent?.trim() === 'Settings');
      if (button instanceof HTMLButtonElement) {
        button.click();
      }

      const content = document.querySelector('.settings-content');
      return {
        hasSettings: !!content,
        text: content?.innerText?.slice(0, 1600) ?? null,
      };
    })()
  `);

  console.log(`[live-debug] completed with ${handled.length} handled request(s)`);
  console.log(JSON.stringify(handled, null, 2));
  console.log(`[live-debug] thread snapshot: ${JSON.stringify(threadSnapshot)}`);
  console.log(`[live-debug] settings snapshot: ${JSON.stringify(settingsState)}`);
  await client.close();
}

main().catch((error) => {
  console.error(`[live-debug] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
