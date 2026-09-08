import { CDP_URL, fetchJson } from '../utils.js';
export async function newTabCommand(args: string[]) {
  const targetUrl = args[1] || 'about:blank';
  const target = await fetchJson(`${CDP_URL}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' });
  console.log(`Opened new tab [id: ${target.id}]: ${target.url}`);
}