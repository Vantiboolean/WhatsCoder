import { CdpClient, fetchTargetWebSocketUrl } from './lib/cdp-client.mjs';

const wsUrl = await fetchTargetWebSocketUrl();
const client = new CdpClient(wsUrl);

await client.connect();
await client.send('Runtime.enable');
await client.send('Page.enable');

const pageState = await client.evaluate(`(() => ({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  toast: document.querySelector('.toast')?.innerText ?? null,
  hasElicitation: !!document.querySelector('.elicitation-card'),
  elicitationText: document.querySelector('.elicitation-card')?.innerText?.slice(0, 1500) ?? null,
  hasDynamicTool: !!document.querySelector('.dynamic-tool-card'),
  dynamicToolText: document.querySelector('.dynamic-tool-card')?.innerText?.slice(0, 1200) ?? null,
  hasAuthRefresh: !!document.querySelector('.auth-refresh-card'),
  authRefreshText: document.querySelector('.auth-refresh-card')?.innerText?.slice(0, 1200) ?? null,
  bodyText: document.body?.innerText?.slice(0, 2000) ?? null,
  bodyHtml: document.body?.innerHTML?.slice(0, 4000) ?? null
}))()`);

console.log(JSON.stringify(pageState, null, 2));
await client.close();
