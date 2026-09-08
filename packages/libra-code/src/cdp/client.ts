import { loadSavedRefs } from './utils.js';

export class CdpClient {
  public ws: WebSocket;
  private id: number = 1;
  private callbacks = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private events = new Map<string, ((params: any) => void)[]>();

  constructor(webSocketDebuggerUrl: string) {
    this.ws = new WebSocket(webSocketDebuggerUrl);

    this.ws.onmessage = (msg) => {
      try {
        const raw = typeof msg.data === 'string' ? msg.data : msg.data.toString();
        const data = JSON.parse(raw);
        if (data.id && this.callbacks.has(data.id)) {
          const cb = this.callbacks.get(data.id)!;
          this.callbacks.delete(data.id);
          if (data.error) cb.reject(new Error(data.error.message));
          else cb.resolve(data.result);
        } else if (data.method) {
          if (this.events.has(data.method)) {
            this.events.get(data.method)!.forEach((cb) => cb(data.params));
          }
        }
      } catch {}
    };
  }

  async connect(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket connection to Chrome timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onerror = (err: any) => {
        clearTimeout(timer);
        reject(err.error || err);
      };
    });
  }

  async close(): Promise<void> {
    try { this.ws.close(); } catch {}
  }

  async send(method: string, params: any = {}, sessionId?: string, timeoutMs = 15000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => {
        if (this.callbacks.has(id)) {
          this.callbacks.delete(id);
          reject(new Error(`CDP command "${method}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.callbacks.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      const msg: any = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (err: any) {
        clearTimeout(timer);
        this.callbacks.delete(id);
        reject(err);
      }
    });
  }

  on(method: string, cb: (params: any) => void): void {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method)!.push(cb);
  }
}

export async function evalJs(client: CdpClient, expression: string, returnByValue = true): Promise<any> {
  const res = await client.send('Runtime.evaluate', {
    expression,
    returnByValue,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result;
}

export async function getElementPoint(client: CdpClient, target: string): Promise<any> {
  const trimmed = String(target).trim();

  // Method 1: Check if target is a Ref tag (@1 or 1) from cdp ax
  const refMatch = trimmed.match(/^@?(\d+)$/);
  if (refMatch) {
    const refId = refMatch[1];
    const refs = loadSavedRefs();
    const refEntry = refs[refId];
    if (refEntry && refEntry.backendDOMNodeId) {
      try {
        const { object } = await client.send('DOM.resolveNode', { backendNodeId: refEntry.backendDOMNodeId });
        if (object && object.objectId) {
          const callRes = await client.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: `function() {
              this.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
              if (typeof this.focus === 'function') this.focus();
              const r = this.getBoundingClientRect();
              return {
                x: r.left + r.width / 2,
                y: r.top + r.height / 2,
                tagName: this.tagName.toLowerCase(),
                id: this.id || '',
                name: this.getAttribute('name') || '',
                ref: ${refId},
                matchedRole: ${JSON.stringify(refEntry.role || '')},
                matchedName: ${JSON.stringify(refEntry.name || '')}
              };
            }`,
            returnByValue: true,
          });
          if (callRes && callRes.result && callRes.result.value) {
            return callRes.result.value;
          }
        }
      } catch (err) {
        // fallback
      }
    }
  }

  // Methods 2, 3, 4: In-page element locator
  const locatorScript = `(() => {
    let el = null;
    const raw = ${JSON.stringify(trimmed)};

    const getAccessibleText = (elem) => {
      if (!elem) return '';
      if (elem.tagName.toLowerCase() === 'input' && ['submit', 'button', 'reset'].includes(elem.type)) {
        return (elem.value || '').trim();
      }
      const ariaLabel = elem.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      const text = (elem.innerText || elem.textContent || '').trim();
      if (text) return text;
      return (elem.getAttribute('placeholder') || elem.getAttribute('title') || '').trim();
    };

    let targetRole = null;
    let targetName = null;
    const roleNameMatch = raw.match(/^role=([a-zA-Z]+)\\s+name=(.+)$/i);
    const colonMatch = raw.match(/^([a-zA-Z]+):(.+)$/);

    if (roleNameMatch) {
      targetRole = roleNameMatch[1].toLowerCase();
      targetName = roleNameMatch[2].trim().toLowerCase();
    } else if (colonMatch && colonMatch[1].toLowerCase() !== 'text') {
      targetRole = colonMatch[1].toLowerCase();
      targetName = colonMatch[2].trim().toLowerCase();
    }

    if (targetRole && targetName) {
      let candidates = [];
      if (targetRole === 'button') {
        candidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'));
      } else if (targetRole === 'link') {
        candidates = Array.from(document.querySelectorAll('a, [role="link"]'));
      } else if (targetRole === 'textbox' || targetRole === 'input') {
        candidates = Array.from(document.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, [role="textbox"]'));
      } else if (targetRole === 'checkbox') {
        candidates = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
      } else if (targetRole === 'combobox' || targetRole === 'select') {
        candidates = Array.from(document.querySelectorAll('select, [role="combobox"]'));
      } else {
        candidates = Array.from(document.querySelectorAll('[role="' + targetRole + '"], ' + targetRole));
      }

      el = candidates.find(e => getAccessibleText(e).toLowerCase() === targetName);
      if (!el) {
        el = candidates.find(e => getAccessibleText(e).toLowerCase().includes(targetName));
      }
    } else if (raw.startsWith('text=')) {
      const target = raw.slice(5).trim().toLowerCase();
      const interactives = Array.from(document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], label'
      ));

      el = interactives.find(e => getAccessibleText(e).toLowerCase() === target);

      if (!el) {
        const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, p, span, li, td, th, div'));
        el = all.find(e => getAccessibleText(e).toLowerCase() === target);
      }

      if (!el) {
        el = interactives.find(e => getAccessibleText(e).toLowerCase().includes(target));
      }

      if (!el) {
        const all = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, p, span, li, td, th, div'));
        el = all.find(e => getAccessibleText(e).toLowerCase().includes(target));
      }

      if (el && el.tagName.toLowerCase() === 'label' && el.htmlFor) {
        const inputEl = document.getElementById(el.htmlFor);
        if (inputEl) el = inputEl;
      }
    } else {
      el = document.querySelector(raw);
    }

    if (!el) {
      return { error: 'Element not found matching target: ' + raw };
    }

    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') {
      el.focus();
    }

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { error: 'Element is hidden or has 0 dimensions: ' + raw };
    }

    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      tagName: el.tagName.toLowerCase(),
      id: el.id || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '',
      text: getAccessibleText(el),
    };
  })()`;

  const res = await evalJs(client, locatorScript, true);
  if (!res || !res.value) throw new Error(`Failed to locate target: ${target}`);
  if (res.value.error) throw new Error(res.value.error);
  return res.value;
}
