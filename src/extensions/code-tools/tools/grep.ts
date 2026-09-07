import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { makeToolName, type ToolFactory } from './shared.js';

export const grepTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'grep'),
  description:
    'Search file contents using ripgrep (rg). ' +
    'Automatically skips node_modules, .git, and respects .gitignore. ' +
    'Returns matching lines.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in. Default: current working directory.',
      },
      glob_pattern: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g. "*.ts", "src/**/*.py"). Default: search all files.',
      },
      context_lines: {
        type: 'integer',
        description: 'Number of lines to show before and after each match. Default: 0.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'If true, perform case-insensitive matching (-i). Default: false.',
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
    const contextLines = Math.max(0, Number(args.context_lines ?? 0));
    const caseInsensitive = args.case_insensitive === true;
    const globPattern = args.glob_pattern ? String(args.glob_pattern) : undefined;

    if (!existsSync(searchPath)) {
      return { toolCallId: '', content: `Path not found: ${searchPath}` };
    }

    const stat = statSync(searchPath);
    let target = searchPath;
    let cwd = process.cwd();
    
    if (stat.isDirectory()) {
      cwd = searchPath;
      target = '.';
    }

    // Build rg command args
    const cmdArgs = ['rg', '--line-number', '--heading', '--max-count=100'];
    if (caseInsensitive) cmdArgs.push('-i');
    if (contextLines > 0) cmdArgs.push(`-C ${contextLines}`);
    if (globPattern) {
      cmdArgs.push('-g', `"${globPattern}"`);
    }
    
    // Add pattern and target
    // Use single quotes around the pattern to prevent shell expansion
    cmdArgs.push(`'${pattern.replace(/'/g, "'\\''")}'`, target);

    try {
      const output = execSync(cmdArgs.join(' '), { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      
      const lines = output.trim();
      if (!lines) {
        return { toolCallId: '', content: `No matches found for "${pattern}" in ${searchPath}` };
      }

      // Output size safety
      const maxLen = 100000;
      const truncated = lines.length > maxLen ? lines.slice(0, maxLen) + '\n\n[...truncated]' : lines;

      return {
        toolCallId: '',
        content: `Search results for "${pattern}":\n\n${truncated}`,
      };
    } catch (err: any) {
      // rg exits with 1 if no matches are found
      if (err.status === 1) {
        return { toolCallId: '', content: `No matches found for "${pattern}" in ${searchPath}` };
      }
      return { toolCallId: '', content: `Error running ripgrep: ${err.message || String(err)}` };
    }
  },
});
