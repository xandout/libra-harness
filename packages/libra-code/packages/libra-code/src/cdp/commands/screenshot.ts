import { writeFileSync } from 'node:fs';
import { CdpClient } from '../client.js';
export async function screenshotCommand(client: CdpClient, args: string[]) {
  const outPath = args[1] || `/tmp/cdp_screenshot_${Date.now()}.png`;
  let saved = false;
  try {
    await client.send('Page.enable', {}, undefined, 4000).catch(() => {});
    const res = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, undefined, 7000);
    if (res && res.data) {
      const buffer = Buffer.from(res.data, 'base64');
      writeFileSync(outPath, buffer);
      saved = true;
    }
  } catch (err) {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`import -window root "${outPath}"`, { stdio: 'ignore', timeout: 5000 });
      saved = true;
    } catch {}
  }
  if (saved) { console.log(outPath); } else { throw new Error('Failed to capture screenshot via CDP and X11 fallback'); }
}