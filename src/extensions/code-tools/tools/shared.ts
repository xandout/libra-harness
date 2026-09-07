import { extname, basename } from 'node:path';
import type { Tool } from '../../../tool.js';

// ── Tool naming helper ───────────────────────────────────────────────
export function makeToolName(prefix: string, name: string): string {
  return prefix ? `${prefix}_${name}` : name;
}

// ── Read tracking ────────────────────────────────────────────────────
// The edit and write tools require that a file was read first in the
// current turn. We track read paths per turn via the metadata bag.
const READ_KEY = '__codeToolsReadPaths';

export function getReadSet(metadata: Record<string, unknown>): Set<string> {
  let set = metadata[READ_KEY] as Set<string> | undefined;
  if (!set) {
    set = new Set();
    metadata[READ_KEY] = set;
  }
  return set;
}

// ── Text/binary detection ────────────────────────────────────────────
const TEXT_EXTENSIONS = new Set([
  '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.md', '.markdown',
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.java', '.c',
  '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.sql', '.html',
  '.htm', '.css', '.scss', '.less', '.sh', '.bash', '.zsh', '.ini',
  '.conf', '.log', '.env', '.toml', '.graphql', '.gql', '.svg', '.srt',
  '.vtt', '.properties', '.dockerfile', '.gitignore', '.editorconfig',
  '.lock', '.map', '.d.ts', '.d.ts.map',
]);

export function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  const name = basename(path).toLowerCase();
  if (['dockerfile', '.gitignore', '.editorconfig', '.env', '.npmrc'].includes(name)) return true;
  return false;
}

// ── Image detection ──────────────────────────────────────────────────
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function isImageFile(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export function imageMime(path: string): string {
  return MIME_MAP[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

// ── Shared Utilities ──────────────────────────────────────────────────
export function getChildProcessEnv(): NodeJS.ProcessEnv {
  const defaultPaths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const currentPath = process.env.PATH || '';
  const currentParts = currentPath.split(':').filter(Boolean);
  for (const p of defaultPaths) {
    if (!currentParts.includes(p)) {
      currentParts.push(p);
    }
  }
  return {
    ...process.env,
    PATH: currentParts.join(':'),
  };
}

export function isNoiseDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === '.next' || name === 'coverage' ||
    name === '.cache' || name === '.npm' || name === '.local' || name === '.config' || name === '.libra';
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegex(pattern: string): RegExp {
  let i = 0;
  let regex = '';

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (pattern[i] === '/') i++;
    } else if (c === '*') {
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regex += '\\{';
        i++;
      } else {
        const options = pattern.slice(i + 1, end).split(',').map((s) => escapeRegex(s));
        regex += `(?:${options.join('|')})`;
        i = end + 1;
      }
    } else if (c === '.') {
      regex += '\\.';
      i++;
    } else if ('+()|^$\\'.includes(c)) {
      regex += '\\' + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }

  return new RegExp(`^${regex}$`);
}

// ── Shared config resolved from the extension config ─────────────────
export interface ResolvedConfig {
  toolPrefix: string;
  maxReadSize: number;
  maxReadLines: number;
  maxLineLength: number;
}

// ── Tool factory type ────────────────────────────────────────────────
export type ToolFactory = (cfg: ResolvedConfig) => Tool;
