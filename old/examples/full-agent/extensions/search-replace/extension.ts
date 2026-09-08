import type { Extension } from '@xandout/libra-harness';

/**
 * search-replace extension — registers a `search_replace` tool that
 * performs string search/replace on a body of text.
 *
 * This is a local extension — it lives in the example's
 * `./extensions/` directory and is discovered by the extension loader.
 * It demonstrates:
 * - A tool-registering extension loaded via the loader (not a direct import)
 * - The factory pattern accepting optional config
 * - A self-contained extension with no external dependencies
 */
export interface SearchReplaceConfig {
  /**
   * Whether to allow regex patterns. Default: false (literal strings only).
   * When enabled, the `search` parameter is treated as a RegExp.
   */
  allowRegex?: boolean;
}

export default function createSearchReplaceExtension(
  config?: SearchReplaceConfig,
): Extension {
  const allowRegex = config?.allowRegex ?? false;

  return {
    name: 'search-replace',
    install(agent) {
      agent.tool({
        name: 'search_replace',
        description:
          'Search for a string in text and replace all occurrences with a replacement string. ' +
          'Returns the modified text. By default, search is literal (case-sensitive). ' +
          (allowRegex ? 'Regex patterns are supported.' : 'Regex is not supported.'),
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The text to search within.',
            },
            search: {
              type: 'string',
              description: 'The string to search for.',
            },
            replacement: {
              type: 'string',
              description: 'The string to replace matches with.',
            },
          },
          required: ['text', 'search', 'replacement'],
        },
        async execute(args) {
          const text = args.text as string;
          const search = args.search as string;
          const replacement = args.replacement as string;

          if (allowRegex) {
            try {
              const regex = new RegExp(search, 'g');
              const result = text.replace(regex, replacement);
              const count = (text.match(new RegExp(search, 'g')) ?? []).length;
              return {
                toolCallId: '',
                content: `Replaced ${count} occurrence(s).\n\nResult:\n${result}`,
              };
            } catch (err) {
              return {
                toolCallId: '',
                content: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
                isError: true,
              };
            }
          }

          // Literal string replacement — escape any special regex chars.
          const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escaped, 'g');
          const count = (text.match(regex) ?? []).length;
          const result = text.replace(regex, replacement);

          return {
            toolCallId: '',
            content: `Replaced ${count} occurrence(s).\n\nResult:\n${result}`,
          };
        },
      });
    },
  };
}
