import { extname, basename } from 'node:path';
import type { Tool } from '../../../../tool.js';

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

// ── Shared config resolved from the extension config ─────────────────
export interface ResolvedConfig {
  toolPrefix: string;
  maxReadSize: number;
  maxReadLines: number;
  maxLineLength: number;
}

// ── Tool factory type ────────────────────────────────────────────────
export type ToolFactory = (cfg: ResolvedConfig) => Tool;
