import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, resolve, relative, dirname, extname } from 'node:path';
import type { Extension } from 'libra';

/** A named sandboxed directory. */
export interface SandboxDir {
  /** Display name the agent sees in paths (e.g. "downloads", "workspace"). */
  name: string;
  /** Absolute or relative path to the directory on disk. */
  path: string;
}

export interface FilesystemConfig {
  /**
   * Named sandboxed directories. Each is presented to the agent by its
   * display name. Paths from the agent are prefixed with the name
   * (e.g. "downloads/report.txt").
   */
  directories: SandboxDir[];
  /**
   * Max file size for read operations (bytes). Default: 1MB.
   * Files larger than this return a metadata-only response.
   */
  maxReadSize?: number;
  /**
   * Tool name prefix. Default: 'fs'.
   */
  toolPrefix?: string;
}

interface ResolvedDir {
  name: string;
  absPath: string;
}

/**
 * Create a filesystem extension that exposes controlled read/write
 * access to one or more sandboxed directories. All paths are resolved
 * relative to a sandbox directory — path traversal (../) is blocked.
 *
 * When multiple directories are configured, paths are prefixed with
 * the directory's display name (e.g. "downloads/report.txt"). The
 * agent sees the available directory names in the tool descriptions
 * and in `fs_list` output.
 *
 * Tools provided:
 * - `fs_read` — read a file's content (text or base64 for binary)
 * - `fs_write` — write text content to a file
 * - `fs_list` — list files in a directory (or list sandboxes if no path)
 * - `fs_delete` — delete a file or empty directory
 * - `fs_info` — get file metadata (size, type, modified time)
 *
 * The `fs_save_bytes` internal helper is exposed on the extension
 * object so other extensions can save binary content to the sandbox
 * without going through the LLM.
 */
export default function createFilesystemExtension(
  config: FilesystemConfig,
): Extension & {
  /** Save raw bytes to a sandbox. Used by other extensions. */
  saveBytes(path: string, data: Buffer, mimetype?: string): string;
  /** Resolve a sandbox-relative path to an absolute path. */
  resolvePath(path: string): string;
} {
  const maxReadSize = config?.maxReadSize ?? 1_048_576; // 1MB
  const prefix = config?.toolPrefix ?? 'fs';

  // ── Resolve sandbox directories ────────────────────────────────
  const dirs: ResolvedDir[] = config.directories.map((d) => {
    const absPath = resolve(d.path);
    if (!existsSync(absPath)) {
      mkdirSync(absPath, { recursive: true });
    }
    return { name: d.name, absPath };
  });

  const dirMap = new Map(dirs.map((d) => [d.name, d]));

  /**
   * Parse a user-provided path into a directory name and a
   * within-directory relative path.
   *
   * "downloads/report.txt" → { dir: "downloads", relPath: "report.txt" }
   *
   * Throws if the path doesn't start with a known directory name.
   */
  function parsePath(userPath: string): { dir: ResolvedDir; relPath: string } {
    // Exact match on a directory name (e.g. "documents").
    const exact = dirMap.get(userPath);
    if (exact) {
      return { dir: exact, relPath: '.' };
    }
    const sep = userPath.indexOf('/');
    if (sep !== -1) {
      const dirName = userPath.slice(0, sep);
      const rest = userPath.slice(sep + 1);
      const dir = dirMap.get(dirName);
      if (dir) {
        return { dir, relPath: rest };
      }
    }
    const valid = dirs.map((d) => `"${d.name}"`).join(', ');
    throw new Error(`Path "${userPath}" must start with a sandbox name (${valid})`);
  }

  /**
   * Resolve a user-provided path to an absolute path within a sandbox.
   * Throws if the path escapes the sandbox (path traversal).
   */
  function resolvePath(userPath: string): string {
    const { dir, relPath } = parsePath(userPath);
    const absolute = resolve(dir.absPath, relPath);
    const rel = relative(dir.absPath, absolute);
    // If the relative path starts with '..' or is absolute, it escapes
    // the sandbox.
    if (rel.startsWith('..') || resolve(rel) === rel) {
      throw new Error(`Path "${userPath}" escapes the filesystem sandbox "${dir.name}"`);
    }
    return absolute;
  }

  /**
   * Save raw bytes to a sandbox. Creates parent directories as needed.
   * Returns the full path including the directory name prefix.
   */
  function saveBytes(userPath: string, data: Buffer, mimetype?: string): string {
    const { dir, relPath } = parsePath(userPath);
    const abs = resolvePath(userPath);
    const dir_ = dirname(abs);
    if (!existsSync(dir_)) {
      mkdirSync(dir_, { recursive: true });
    }
    writeFileSync(abs, data);
    const fullPath = `${dir.name}/${relPath}`;
    console.log(`[fs] saved ${data.length}b to ${fullPath} (${mimetype ?? 'unknown'})`);
    return fullPath;
  }

  // Determine if a file is text or binary based on extension.
  const textExtensions = new Set([
    '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.md', '.markdown',
    '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h',
    '.go', '.rs', '.rb', '.php', '.sql', '.html', '.css', '.scss',
    '.sh', '.bash', '.ini', '.conf', '.log', '.env', '.toml', '.graphql',
    '.svg', '.srt', '.vtt', '.properties',
  ]);

  function isTextFile(path: string): boolean {
    return textExtensions.has(extname(path).toLowerCase());
  }

  // Build the directory list string for tool descriptions.
  const dirListStr = dirs.map((d) => `"${d.name}"`).join(', ');

  return {
    name: 'filesystem',
    priority: 50,
    saveBytes,
    resolvePath,

    install(agent) {
      // ── fs_read ──────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_read`,
        description:
          `Read a file from the sandboxed filesystem. ` +
          `Available directories: ${dirListStr}. ` +
          'Paths are prefixed with the directory name (e.g. "downloads/report.txt"). ' +
          'Text files are returned as text. Binary files are returned as base64.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Path within a sandbox (e.g. "${dirs[0]?.name}/report.txt")` },
          },
          required: ['path'],
        },
        async execute(args) {
          const userPath = String(args.path ?? '');
          let abs: string;
          try {
            abs = resolvePath(userPath);
          } catch (err) {
            return { toolCallId: '', content: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }

          if (!existsSync(abs)) {
            return { toolCallId: '', content: `File not found: ${userPath}` };
          }

          const stat = statSync(abs);
          if (stat.isDirectory()) {
            return { toolCallId: '', content: `Path is a directory, not a file: ${userPath}. Use ${prefix}_list to list contents.` };
          }

          if (stat.size > maxReadSize) {
            return {
              toolCallId: '',
              content: `File is too large (${stat.size} bytes, max ${maxReadSize}). Path: ${userPath}`,
            };
          }

          const buf = readFileSync(abs);

          if (isTextFile(userPath)) {
            const text = buf.toString('utf-8');
            const truncated = text.length > 50000
              ? text.slice(0, 50000) + `\n\n[truncated — ${text.length} chars total, showing first 50000]`
              : text;
            return {
              toolCallId: '',
              content: `File: ${userPath} (${stat.size}b)\n\n${truncated}`,
            };
          }

          // Binary: return base64
          const base64 = buf.toString('base64');
          return {
            toolCallId: '',
            content: `File: ${userPath} (${stat.size}b, binary)\nbase64: ${base64}`,
          };
        },
      });

      // ── fs_write ─────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_write`,
        description:
          `Write text content to a file in the sandboxed filesystem. ` +
          `Available directories: ${dirListStr}. ` +
          'Paths are prefixed with the directory name. ' +
          'Creates parent directories as needed. Overwrites if the file exists.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: `Path within a sandbox (e.g. "${dirs[0]?.name}/notes.txt")` },
            content: { type: 'string', description: 'Text content to write' },
          },
          required: ['path', 'content'],
        },
        async execute(args) {
          const userPath = String(args.path ?? '');
          const content = String(args.content ?? '');

          let abs: string;
          try {
            abs = resolvePath(userPath);
          } catch (err) {
            return { toolCallId: '', content: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }

          const dir = dirname(abs);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }

          writeFileSync(abs, content, 'utf-8');
          console.log(`[fs] wrote ${content.length} chars to ${userPath}`);
          return {
            toolCallId: '',
            content: `Wrote ${content.length} chars to ${userPath}`,
          };
        },
      });

      // ── fs_list ──────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_list`,
        description:
          `List files and directories in the sandboxed filesystem. ` +
          `Available directories: ${dirListStr}. ` +
          'With no path, lists the available sandbox directories. ' +
          'With a path, lists the contents of that directory.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (e.g. "downloads" or "downloads/subdir"). Default: list all sandboxes.' },
          },
        },
        async execute(args) {
          const userPath = String(args.path ?? '');

          // No path: list the available sandbox directories.
          if (!userPath || userPath === '/' || userPath === '.') {
            const lines = dirs.map((d) => {
              const entries = readdirSync(d.absPath, { withFileTypes: true });
              const count = entries.length;
              return `  [dir]  ${d.name}/ (${count} item${count === 1 ? '' : 's'})`;
            });
            return { toolCallId: '', content: `Sandbox directories:\n${lines.join('\n')}` };
          }

          let abs: string;
          try {
            abs = resolvePath(userPath);
          } catch (err) {
            return { toolCallId: '', content: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }

          if (!existsSync(abs)) {
            return { toolCallId: '', content: `Directory not found: ${userPath}` };
          }

          if (!statSync(abs).isDirectory()) {
            return { toolCallId: '', content: `Path is a file, not a directory: ${userPath}` };
          }

          const entries = readdirSync(abs, { withFileTypes: true });
          if (entries.length === 0) {
            return { toolCallId: '', content: `Directory is empty: ${userPath}` };
          }

          const lines = entries.map((e) => {
            if (e.isDirectory()) {
              return `  [dir]  ${e.name}/`;
            }
            const size = statSync(join(abs, e.name)).size;
            return `  [file] ${e.name} (${size}b)`;
          });

          return {
            toolCallId: '',
            content: `Contents of ${userPath}:\n${lines.join('\n')}`,
          };
        },
      });

      // ── fs_delete ────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_delete`,
        description:
          `Delete a file from the sandboxed filesystem. ` +
          `Available directories: ${dirListStr}. ` +
          'Can also delete an empty directory. Refuses to delete a sandbox root.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path within a sandbox (e.g. "downloads/old-report.txt")' },
          },
          required: ['path'],
        },
        async execute(args) {
          const userPath = String(args.path ?? '');

          if (!userPath || userPath === '/' || userPath === '.') {
            return { toolCallId: '', content: 'Refusing to delete a sandbox root' };
          }

          // Check if the path is a sandbox root (e.g. "downloads").
          const sep = userPath.indexOf('/');
          const dirName = sep === -1 ? userPath : userPath.slice(0, sep);
          if (dirMap.has(dirName) && (sep === -1 || userPath.slice(sep + 1) === '' || userPath.slice(sep + 1) === '.')) {
            return { toolCallId: '', content: `Refusing to delete sandbox root: ${userPath}` };
          }

          let abs: string;
          try {
            abs = resolvePath(userPath);
          } catch (err) {
            return { toolCallId: '', content: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }

          if (!existsSync(abs)) {
            return { toolCallId: '', content: `File not found: ${userPath}` };
          }

          const stat = statSync(abs);
          if (stat.isDirectory()) {
            // Only delete empty directories.
            const entries = readdirSync(abs);
            if (entries.length > 0) {
              return { toolCallId: '', content: `Directory is not empty: ${userPath} (${entries.length} items). Remove contents first.` };
            }
            rmdirSync(abs);
          } else {
            unlinkSync(abs);
          }

          console.log(`[fs] deleted ${userPath}`);
          return { toolCallId: '', content: `Deleted: ${userPath}` };
        },
      });

      // ── fs_info ──────────────────────────────────────────────────
      agent.tool({
        name: `${prefix}_info`,
        description:
          `Get metadata about a file or directory in the sandbox. ` +
          `Available directories: ${dirListStr}. ` +
          'Returns size, type, and modification time.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path within a sandbox (e.g. "downloads/report.txt")' },
          },
          required: ['path'],
        },
        async execute(args) {
          const userPath = String(args.path ?? '');
          let abs: string;
          try {
            abs = resolvePath(userPath);
          } catch (err) {
            return { toolCallId: '', content: `Error: ${err instanceof Error ? err.message : String(err)}` };
          }

          if (!existsSync(abs)) {
            return { toolCallId: '', content: `Not found: ${userPath}` };
          }

          const stat = statSync(abs);
          const lines = [
            `Path: ${userPath}`,
            `Type: ${stat.isDirectory() ? 'directory' : 'file'}`,
            `Size: ${stat.size} bytes`,
            `Modified: ${stat.mtime.toISOString()}`,
          ];
          if (!stat.isDirectory()) {
            lines.push(`Extension: ${extname(userPath) || 'none'}`);
            lines.push(`Text file: ${isTextFile(userPath)}`);
          }

          return { toolCallId: '', content: lines.join('\n') };
        },
      });
    },
  };
}
