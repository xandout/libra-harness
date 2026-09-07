import { existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { makeToolName, type ToolFactory } from './shared.js';

let fdBinary: string | undefined;
function getFdCommand(): string {
  if (fdBinary) return fdBinary;
  try {
    execSync('fd --version', { stdio: 'ignore' });
    fdBinary = 'fd';
    return fdBinary;
  } catch {}
  try {
    execSync('fdfind --version', { stdio: 'ignore' });
    fdBinary = 'fdfind';
    return fdBinary;
  } catch {}
  return 'fd';
}

export const findFileByNameTool: ToolFactory = (cfg) => ({
  name: makeToolName(cfg.toolPrefix, 'find_file_by_name'),
  description:
    'Search for files and subdirectories within a specified directory using fd. ' +
    'Search uses smart case and will ignore gitignored files by default. ' +
    'Returns the relative paths of up to 200 matches.',
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


    try {
      const bin = getFdCommand();
      const output = execSync(`${bin} -g "${pattern}" -c never`, { cwd: searchDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      
      const files = output.split('\n').map(f => f.trim()).filter(Boolean);
      if (files.length === 0) {
        return { toolCallId: '', content: `No files matching "${pattern}" found in ${searchDir}` };
      }

      const maxResults = 200;
      const truncated = files.length > maxResults;
      const displayed = files.slice(0, maxResults);

      const header = `Found ${files.length} file${files.length === 1 ? '' : 's'} matching "${pattern}" in ${searchDir}:`;
      const footer = truncated ? `\n\n[showing first ${maxResults} of ${files.length} results]` : '';

      return {
        toolCallId: '',
        content: `${header}\n${displayed.join('\n')}${footer}`,
      };
    } catch (err: any) {
      // execSync throws if exit code is non-zero
      // fd exits with 1 if no files are found.
      if (err.status === 1) {
        return { toolCallId: '', content: `No files matching "${pattern}" found in ${searchDir}` };
      }
      return { toolCallId: '', content: `Error running fd: ${err.message || String(err)}` };
    }
  },
});
