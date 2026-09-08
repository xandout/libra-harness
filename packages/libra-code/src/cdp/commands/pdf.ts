import { writeFileSync } from 'node:fs';
import { CdpClient } from '../client.js';
import { CDP_URL, fetchJson } from '../utils.js';
export async function pdfCommand(_client: CdpClient, args: string[], pageId: string) {
  const outPath = args[1] || `/tmp/cdp_page_${Date.now()}.pdf`;
  const version = await fetchJson(`${CDP_URL}/json/version`);
  const browserClient = new CdpClient(version.webSocketDebuggerUrl);
  await browserClient.connect();
  try {
    const attachRes = await browserClient.send('Target.attachToTarget', { targetId: pageId, flatten: true });
    const sessionId = attachRes.sessionId;
    const printRes = await browserClient.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, sessionId);
    const buffer = Buffer.from(printRes.data, 'base64');
    writeFileSync(outPath, buffer);
    console.log(outPath);
  } finally { await browserClient.close(); }
}