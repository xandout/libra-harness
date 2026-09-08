import { mkdirSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { CDP_URL, fetchJson, getActivePageTarget, DEFAULT_DOWNLOAD_DIR } from '../utils.js';
import { CdpClient } from '../client.js';
export async function downloadCommand(args: string[]) {
  const url = args[1];
  if (!url) throw new Error('download requires a URL (e.g. cdp download https://example.com/file.pdf)');
  let downloadDir = DEFAULT_DOWNLOAD_DIR;
  let timeout = 60000;
  let byAnchor = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) { downloadDir = pathResolve(args[++i]); }
    else if (args[i] === '--timeout' && args[i + 1]) { timeout = parseInt(args[++i], 10); }
    else if (args[i] === '--by-anchor') { byAnchor = true; }
  }
  try { mkdirSync(downloadDir, { recursive: true }); } catch {}
  if (process.env.CHROME_CDP_URL && !downloadDir.startsWith('/home/node/workspace')) {
    console.warn(`\nWARNING: Download directory ${downloadDir} is outside the shared /home/node/workspace volume!`);
    console.warn(`Because Chrome runs in a remote container, files downloaded here will NOT be visible to the agent.\n`);
  }
  const version = await fetchJson(`${CDP_URL}/json/version`);
  const browserClient = new CdpClient(version.webSocketDebuggerUrl);
  await browserClient.connect();
  try {
    await browserClient.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
    const downloadPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`Download timed out after ${timeout}ms`)); }, timeout);
      let activeGuid: string | null = null;
      let suggestedName: string | null = null;
      browserClient.on('Browser.downloadWillBegin', (params: any) => { activeGuid = params.guid; suggestedName = params.suggestedFilename; });
      browserClient.on('Browser.downloadProgress', (params: any) => {
        if (activeGuid && params.guid !== activeGuid) return;
        if (params.state === 'completed') {
          clearTimeout(timer);
          const finalPath = params.filePath || (suggestedName ? pathResolve(downloadDir, suggestedName) : pathResolve(downloadDir, params.guid));
          resolve(finalPath);
        } else if (params.state === 'canceled') {
          clearTimeout(timer);
          reject(new Error('Download was canceled by browser'));
        }
      });
    });
    const pageTarget = await getActivePageTarget();
    const tabClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await tabClient.connect();
    try {
      if (byAnchor) {
        await tabClient.send('Runtime.evaluate', { expression: `(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(url)}; a.setAttribute('download', ''); document.body.appendChild(a); a.click(); a.remove(); })()`, awaitPromise: true });
      } else {
        await tabClient.send('Page.navigate', { url });
      }
      const downloadedPath = await downloadPromise;
      console.log(downloadedPath);
      return;
    } finally { await tabClient.close(); }
  } finally { await browserClient.close(); }
}