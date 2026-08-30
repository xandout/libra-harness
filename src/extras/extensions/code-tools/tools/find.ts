import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeToolName, type ToolFactory } from './shared.js';

// ── Glob matching ────────────────────────────────────────────────────
// Minimal glob implementation supporting:
//   *        — match any chars except /
//   **       — match any chars including /
//   {a,b}    — brace expansion
//   ?        — match single char except /
//
// This avoids a dependency on a glob library. It's not a full glob
// implementation but covers the common patterns from HOW_TO_AGENT.md:
//   *.py, **/*.js, src/**/*.ts, **/*.{ts,tsx}, test_*.py

function globToRegex(pattern: string): RegExp {
  let i = 0;
  let regex = '';

  while (i < pattern.length) {
    const c = pattern[i];

    if (c === '*' && pattern[i + 1] === '*') {
      // ** — match anything including /
      regex += '.*';
      i += 2;
      // Consume optional trailing /
      if (pattern[i] === '/') i++;
    } else if (c === '*') {
      // * — match anything except /
      regex += '[^/]*';
      i++;
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (c === '{') {
      // Brace expansion: {a,b,c} → (a|b|c)
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

// ── Recursive directory walk with glob matching ──────────────────────
function findFiles(rootDir: string, pattern: RegExp, baseDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied or other error — skip
    }

    for (const entry of entries) {
      // Skip common noise directories.
      if (entry.isDirectory() && isNoiseDir(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(baseDir, fullPath);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        // Match against the relative path only (not basename).
        // This way "*.ts" matches top-level files but not "sub/d.ts",
        // while "**/*.ts" matches both.
        if (pattern.test(relPath)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(rootDir);
  return results.sort();
}

function isNoiseDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === '.next' || name === 'coverage';
}

// ── find_file_by_name tool ───────────────────────────────────────────
export const findFileByNameTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'find_file_by_name'),
  description:
    'Find files by glob pattern. Matches file paths, not contents. ' +
    'Supports: * (any chars except /), ** (any chars including /), ? (single char), {a,b} (brace expansion). ' +
    'Examples: "*.py" (current dir only), "**/*.js" (recursive), "src/**/*.ts", "**/*.{ts,tsx}", "test_*.py". ' +
    'Automatically skips node_modules, .git, dist, coverage directories.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match file paths against.',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Default: current working directory.',
      },
    },
    required: ['pattern'],
  },
  async execute(args) {
    const pattern = String(args.pattern ?? '');
    if (!pattern) {
      return { toolCallId: '', content: 'Error: pattern is required' };
    }

    const searchDir = String(args.path ?? process.cwd());
    if (!existsSync(searchDir)) {
      return { toolCallId: '', content: `Directory not found: ${searchDir}` };
    }

    const stat = statSync(searchDir);
    if (!stat.isDirectory()) {
      return { toolCallId: '', content: `Path is not a directory: ${searchDir}` };
    }

    let regex: RegExp;
    try {
      regex = globToRegex(pattern);
    } catch (err) {
      return { toolCallId: '', content: `Error: invalid glob pattern: ${err instanceof Error ? err.message : String(err)}` };
    }

    const files = findFiles(searchDir, regex, searchDir);

    if (files.length === 0) {
      return { toolCallId: '', content: `No files matching "${pattern}" found in ${searchDir}` };
    }

    const maxResults = 200;
    const truncated = files.length > maxResults;
    const displayed = files.slice(0, maxResults);

    const lines = displayed.map((f) => relative(searchDir, f) || f);
    const header = `Found ${files.length} file${files.length === 1 ? '' : 's'} matching "${pattern}" in ${searchDir}:`;
    const footer = truncated ? `\n\n[showing first ${maxResults} of ${files.length} results]` : '';

    return {
      toolCallId: '',
      content: `${header}\n${lines.join('\n')}${footer}`,
    };
  },
});
