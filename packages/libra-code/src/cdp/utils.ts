import { existsSync, readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { resolve as pathResolve } from 'node:path';

export const CDP_PORT = process.env.CHROME_DEBUG_PORT || 18800;
export let CDP_URL = process.env.CHROME_CDP_URL || `http://127.0.0.1:${CDP_PORT}`;

export async function initCdpUrl(): Promise<void> {
  try {
    const urlObj = new URL(CDP_URL);
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(urlObj.hostname) && urlObj.hostname !== 'localhost') {
      const { address } = await lookup(urlObj.hostname);
      urlObj.hostname = address;
      CDP_URL = urlObj.toString().replace(/\/$/, '');
    }
  } catch (e) {
    // Ignore URL parsing or resolution errors
  }
}

// Call it once?
await initCdpUrl();

export const REFS_FILE = '/tmp/cdp_ax_refs.json';
export const DEFAULT_DOWNLOAD_DIR = process.env.CHROME_DOWNLOAD_DIR || (existsSync('/home/node/workspace') ? '/home/node/workspace/downloads' : pathResolve(process.cwd(), 'downloads'));

export const KEY_MAP: Record<string, { code: string; key: string; keyCode?: number; text?: string }> = {
  enter: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' },
  return: { code: 'Enter', key: 'Enter', keyCode: 13, text: '\r' },
  tab: { code: 'Tab', key: 'Tab', keyCode: 9 },
  escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
  esc: { code: 'Escape', key: 'Escape', keyCode: 27 },
  backspace: { code: 'Backspace', key: 'Backspace', keyCode: 8 },
  delete: { code: 'Delete', key: 'Delete', keyCode: 46 },
  space: { code: 'Space', key: ' ', keyCode: 32, text: ' ' },
  arrowup: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  arrowdown: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  arrowleft: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  arrowright: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  up: { code: 'ArrowUp', key: 'ArrowUp', keyCode: 38 },
  down: { code: 'ArrowDown', key: 'ArrowDown', keyCode: 40 },
  left: { code: 'ArrowLeft', key: 'ArrowLeft', keyCode: 37 },
  right: { code: 'ArrowRight', key: 'ArrowRight', keyCode: 39 },
  pageup: { code: 'PageUp', key: 'PageUp', keyCode: 33 },
  pagedown: { code: 'PageDown', key: 'PageDown', keyCode: 34 },
  home: { code: 'Home', key: 'Home', keyCode: 36 },
  end: { code: 'End', key: 'End', keyCode: 35 },
};

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch',
  'spinbutton', 'slider', 'option', 'treeitem',
]);

export async function fetchJson(url: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

export async function getPageTargets(): Promise<any[]> {
  const targets = await fetchJson(`${CDP_URL}/json/list`);
  return targets.filter((t: any) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

export async function getActivePageTarget(targetId?: string): Promise<any> {
  const targets = await getPageTargets();
  if (targets.length === 0) throw new Error('No open page targets found in Chrome.');
  let selected = targets[0];
  if (targetId) {
    const matched = targets.find((t: any) => t.id === targetId || t.id.startsWith(targetId));
    if (matched) selected = matched;
  }
  try {
    await fetchJson(`${CDP_URL}/json/activate/${selected.id}`, { method: 'PUT' });
  } catch {}
  return selected;
}

export function loadSavedRefs(): Record<string, any> {
  try {
    if (existsSync(REFS_FILE)) {
      return JSON.parse(readFileSync(REFS_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}
