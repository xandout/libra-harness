import { writeFileSync } from 'node:fs';
import { INTERACTIVE_ROLES, REFS_FILE } from './utils.js';
import type { CdpClient } from './client.js';

export function renderAxTree(nodes: any[], maxDepth = 8): string {
  const nodeMap = new Map();
  nodes.forEach((n) => nodeMap.set(n.nodeId, n));

  const root = nodes.find((n) => n.role?.value === 'RootWebArea' || n.role?.value === 'WebArea') || nodes[0];
  if (!root) return '(empty accessibility tree)';

  const lines: string[] = [];
  const refs: Record<string, any> = {};
  let refCounter = 0;

  function walk(nodeId: string, depth: number) {
    if (depth > maxDepth) return;
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value || '';
    const name = node.name?.value ? String(node.name.value).trim() : '';
    const value = node.value?.value ? String(node.value.value).trim() : '';
    const desc = node.description?.value ? String(node.description.value).trim() : '';
    const isIgnored = node.ignored === true;
    const backendDOMNodeId = node.backendDOMNodeId;
    const properties = node.properties || [];

    const urlProp = properties.find((p: any) => p.name === 'url');
    const href = urlProp?.value?.value || '';

    const childIds = node.childIds || [];

    const isGenericWrapper =
      ['generic', 'none', 'group', 'section', 'StaticText', 'paragraph'].includes(role) && !name && !value && !desc;

    if (!isIgnored && !isGenericWrapper && (name || value || !['generic', 'none'].includes(role))) {
      const indent = '  '.repeat(depth);
      let line = `${indent}- ${role}`;

      if (name) {
        line += ` "${name.replace(/\s+/g, ' ')}"`;
      }
      if (value) {
        line += ` [value: "${value.replace(/\s+/g, ' ')}"]`;
      }
      if (desc && desc !== name) {
        line += ` (${desc.replace(/\s+/g, ' ')})`;
      }
      if (href && href !== name) {
        line += ` [href: ${href}]`;
      }

      const isInteractive = INTERACTIVE_ROLES.has(role) || (name && ['button', 'link'].includes(role));
      if (isInteractive && backendDOMNodeId) {
        const refId = ++refCounter;
        line += ` [@${refId}]`;
        refs[String(refId)] = {
          ref: refId,
          role,
          name,
          value,
          backendDOMNodeId,
        };
      }

      lines.push(line);
      childIds.forEach((childId: string) => walk(childId, depth + 1));
    } else {
      childIds.forEach((childId: string) => walk(childId, depth));
    }
  }

  walk(root.nodeId, 0);

  try {
    writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2), 'utf-8');
  } catch {}

  return lines.length > 0 ? lines.join('\n') : '(no semantic elements found)';
}

export async function extractDomSemanticTree(client: CdpClient, maxDepth = 8): Promise<string> {
  const script = `(() => {
    const refs = {};
    let refCounter = 0;
    const lines = [];

    const isVisible = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const getAccessibleName = (el) => {
      const aria = el.getAttribute('aria-label');
      if (aria && aria.trim()) return aria.trim();
      if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return (el.value || '').trim();
      if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim();
      if (el.getAttribute('title')) return el.getAttribute('title').trim();
      const text = (el.innerText || el.textContent || '').trim();
      return text.replace(/\\s+/g, ' ');
    };

    const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea']);
    const HEADING = /^h[1-6]$/i;

    const walk = (node, depth) => {
      if (depth > ${maxDepth}) return;
      if (node.nodeType !== 1) return;
      if (!isVisible(node)) return;

      const tag = node.tagName.toLowerCase();
      const role = node.getAttribute('role') || (INTERACTIVE.has(tag) ? tag : HEADING.test(tag) ? 'heading' : '');
      const name = getAccessibleName(node);
      const isInteractive = INTERACTIVE.has(tag) || node.hasAttribute('onclick') || node.getAttribute('role') === 'button';

      if (role || isInteractive || name) {
        const indent = '  '.repeat(depth);
        let line = \`\${indent}- \${role || tag}\`;
        
        if (name) {
          line += \` "\${name}"\`;
        }
        if (node.value && tag === 'input' && !['submit', 'button'].includes(node.type)) {
          line += \` [value: "\${node.value}"]\`;
        }
        if (node.href) {
          let href = node.getAttribute('href');
          if (href && !href.startsWith('javascript:')) {
            line += \` [href: \${href}]\`;
          }
        }
        if (node.tagName === 'IMG' && node.getAttribute('alt')) {
          line += \` [alt: "\${node.getAttribute('alt')}"]\`;
        }
        if (node.tagName === 'IMG' && node.getAttribute('src')) {
          line += \` [src: \${node.getAttribute('src')}]\`;
        }

        if (isInteractive) {
          refCounter++;
          line += \` [@\${refCounter}]\`;
          refs[String(refCounter)] = {
            ref: refCounter,
            role: role || tag,
            name: name || '',
            selector: node.id ? '#' + node.id : (node.getAttribute('name') ? \`[name="\${node.getAttribute('name')}"]\` : null),
          };
        }
        lines.push(line);
      }

      for (let i = 0; i < node.children.length; i++) {
        walk(node.children[i], depth + 1);
      }
    };

    walk(document.body, 0);
    return { lines: lines.join('\\n'), refs };
  })()`;

  try {
    const res = await client.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    }, undefined, 8000);

    if (res && res.result && res.result.value) {
      const { lines, refs } = res.result.value;
      if (refs) {
        try {
          writeFileSync(REFS_FILE, JSON.stringify(refs, null, 2), 'utf-8');
        } catch {}
      }
      return lines || '(empty semantic tree)';
    }
  } catch {}

  return '(unable to retrieve accessibility tree)';
}
