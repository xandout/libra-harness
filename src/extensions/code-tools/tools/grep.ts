import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeToolName, type ToolFactory } from './shared.js';

// ── Grep implementation ──────────────────────────────────────────────
// Pure-JS content search. Supports:
//   - Rust regex syntax (via JS RegExp, with look-around not supported)
//   - Glob pattern filtering (e.g. "*.ts", "src/**/*.py")
//   - Output modes: content, files_with_matches, count
//   - Context lines before/after matches
//   - Case-insensitive matching
//   - Max file size (skips files > 4MB, matching ripgrep behavior)
//   - Max results limit

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB

interface GrepMatch {
  file: string;
  lineNum: number;
  line: string;
}

interface GrepFileResult {
  file: string;
  matches: GrepMatch[];
  count: number;
}

function isNoiseDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === '.next' || name === 'coverage' ||
    name === '.cache' || name === '.npm' || name === '.local' || name === '.config' || name === '.libra';
}

// Simple glob to regex (same minimal implementation as find.ts)
function globToRegex(pattern: string): RegExp {
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldSearchFile(filePath: string, globPattern?: RegExp): boolean {
  if (globPattern) {
    const base = filePath.split('/').pop() ?? filePath;
    // Try matching against full relative path and just the filename
    if (!globPattern.test(filePath) && !globPattern.test(base)) return false;
  }
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return false;
    return true;
  } catch {
    return false;
  }
}

function searchFile(
  filePath: string,
  regex: RegExp,
): GrepFileResult {
  const matches: GrepMatch[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { file: filePath, matches: [], count: 0 };
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Reset lastIndex — the regex has the global flag, so test() advances it.
    regex.lastIndex = 0;
    if (regex.test(lines[i])) {
      matches.push({ file: filePath, lineNum: i + 1, line: lines[i] });
    }
  }

  return { file: filePath, matches, count: matches.length };
}

function walkDir(dir: string, globPattern: RegExp | undefined, baseDir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && isNoiseDir(entry.name)) continue;
      const fullPath = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const relPath = relative(baseDir, fullPath);
        if (shouldSearchFile(relPath, globPattern) || shouldSearchFile(fullPath, globPattern)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

// ── grep tool ────────────────────────────────────────────────────────
export const grepTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'grep'),
  description:
    'Search file contents using regex. Uses JS RegExp syntax (no look-ahead/look-behind or backreferences). ' +
    'Files larger than 4MB are skipped. ' +
    'Output modes: "content" (matching lines with line numbers), "files_with_matches" (just file paths), "count" (match counts per file). ' +
    'Use context_lines to show lines before/after each match. ' +
    'Automatically skips node_modules, .git, dist, coverage directories.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for (JS RegExp syntax).',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in. Default: current working directory.',
      },
      glob_pattern: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g. "*.ts", "src/**/*.py"). Default: search all files.',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'How to format results. Default: "content".',
      },
      context_lines: {
        type: 'integer',
        description: 'Number of lines to show before and after each match. Default: 0.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'If true, perform case-insensitive matching. Default: false.',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of matching lines to return. Default: 100.',
      },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern ?? '');
    if (!pattern) {
      return { toolCallId: '', content: 'Error: pattern is required' };
    }

    const searchPath = String(args.path ?? process.cwd());
    const outputMode = String(args.output_mode ?? 'content') as 'content' | 'files_with_matches' | 'count';
    const contextLines = Math.max(0, Number(args.context_lines ?? 0));
    const caseInsensitive = args.case_insensitive === true;
    const maxResults = Math.min(Math.max(1, Number(args.max_results ?? 100)), 10000);
    const globPattern = args.glob_pattern ? String(args.glob_pattern) : undefined;

    // Compile the regex.
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
    } catch (err) {
      return {
        toolCallId: '',
        content: `Error: invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Compile glob filter if provided.
    let globRegex: RegExp | undefined;
    if (globPattern) {
      try {
        globRegex = globToRegex(globPattern);
      } catch (err) {
        return {
          toolCallId: '',
          content: `Error: invalid glob_pattern: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Determine search scope — single file or directory.
    if (!existsSync(searchPath)) {
      return { toolCallId: '', content: `Path not found: ${searchPath}` };
    }

    const stat = statSync(searchPath);
    let files: string[];
    if (stat.isFile()) {
      files = [searchPath];
    } else if (stat.isDirectory()) {
      files = walkDir(searchPath, globRegex, searchPath);
    } else {
      return { toolCallId: '', content: `Path is not a file or directory: ${searchPath}` };
    }

    // Search all files.
    const results: GrepFileResult[] = [];
    let totalMatches = 0;

    for (const file of files) {
      // Reset regex lastIndex between files (it has the global flag).
      regex.lastIndex = 0;
      const result = searchFile(file, regex);
      if (result.count > 0) {
        results.push(result);
        totalMatches += result.count;
      }
    }

    if (totalMatches === 0) {
      return { toolCallId: '', content: `No matches found for "${pattern}" in ${searchPath}` };
    }

    // Format output based on mode.
    const baseDir = stat.isDirectory() ? searchPath : '';

    if (outputMode === 'files_with_matches') {
      const fileList = results.map((r) => relative(baseDir, r.file) || r.file);
      const truncated = fileList.length > maxResults;
      const displayed = fileList.slice(0, maxResults);
      return {
        toolCallId: '',
        content: `${displayed.join('\n')}${truncated ? `\n\n[showing first ${maxResults} of ${fileList.length} files]` : ''}`,
      };
    }

    if (outputMode === 'count') {
      const lines = results.map((r) => {
        const rel = relative(baseDir, r.file) || r.file;
        return `${rel}:${r.count}`;
      });
      return {
        toolCallId: '',
        content: `${lines.join('\n')}\n\nTotal: ${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'}`,
      };
    }

    // content mode — show matching lines with line numbers and context.
    const allMatches: { file: string; lineNum: number; line: string }[] = [];
    for (const r of results) {
      for (const m of r.matches) {
        allMatches.push(m);
      }
    }

    const truncated = allMatches.length > maxResults;
    const displayed = allMatches.slice(0, maxResults);

    // Read context lines for each match.
    const outputLines: string[] = [];
    const fileCache = new Map<string, string[]>();

    for (const m of displayed) {
      if (contextLines > 0) {
        let fileLines = fileCache.get(m.file);
        if (!fileLines) {
          try {
            fileLines = readFileSync(m.file, 'utf-8').split('\n');
            fileCache.set(m.file, fileLines);
          } catch {
            fileLines = [];
          }
        }

        const rel = relative(baseDir, m.file) || m.file;
        const start = Math.max(0, m.lineNum - 1 - contextLines);
        const end = Math.min(fileLines.length - 1, m.lineNum - 1 + contextLines);

        for (let i = start; i <= end; i++) {
          const prefix = i === m.lineNum - 1 ? '>' : ' ';
          outputLines.push(`${rel}:${i + 1}:${prefix} ${fileLines[i]}`);
        }
        outputLines.push('');
      } else {
        const rel = relative(baseDir, m.file) || m.file;
        outputLines.push(`${rel}:${m.lineNum}: ${m.line}`);
      }
    }

    const header = `Found ${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'}:`;
    const footer = truncated ? `\n\n[showing first ${maxResults} of ${totalMatches} matches]` : '';

    return {
      toolCallId: '',
      content: `${header}\n${outputLines.join('\n')}${footer}`,
    };
  },
});
