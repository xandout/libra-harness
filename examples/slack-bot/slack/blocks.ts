/**
 * Slack Block Kit extraction. Converts Slack message blocks (tables,
 * rich text, sections, headers, etc.) into readable text for the agent.
 *
 * Used by the bot's message handler to extract content from incoming
 * messages that use Block Kit formatting.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

export function extractTextFromBlocks(blocks: AnyBlock[]): string {
  const parts: string[] = [];

  function extractFromBlock(block: AnyBlock): void {
    if (!block || typeof block !== 'object') return;

    // Section blocks with text
    if (block.type === 'section' && block.text) {
      const text = block.text.text || block.text.plain_text || '';
      if (text) parts.push(text);
    }

    // Header blocks
    if (block.type === 'header' && block.text) {
      parts.push(`## ${block.text.text || block.text.plain_text || ''}`);
    }

    // Table blocks (Slack 2025+ table block)
    if (block.type === 'table' && block.rows) {
      const rows: string[][] = block.rows.map((row: AnyBlock[]) =>
        row.map((cell: AnyBlock) => {
          if (cell.type === 'raw_text' || cell.type === 'raw_number') return cell.text ?? '';
          if (cell.type === 'rich_text') {
            return extractRichTextInline(cell);
          }
          return '';
        }),
      );
      for (const row of rows) {
        parts.push('| ' + row.join(' | ') + ' |');
      }
    }

    // Rich text blocks (tables, lists, etc.)
    if (block.type === 'rich_text') {
      const elements = block.elements || [];
      for (const el of elements) {
        extractFromRichTextElement(el);
      }
    }

    // Context blocks (small text under messages)
    if (block.type === 'context' && block.elements) {
      for (const el of block.elements) {
        if (el.type === 'plain_text' || el.type === 'mrkdwn') {
          const text = el.text || el.name || '';
          if (text) parts.push(text);
        }
      }
    }

    // Divider
    if (block.type === 'divider') {
      parts.push('---');
    }

    // Actions (buttons etc) — just extract labels
    if (block.type === 'actions' && block.elements) {
      for (const el of block.elements) {
        if (el.text?.text) parts.push(`[${el.text.text}]`);
      }
    }
  }

  function extractRichTextInline(el: AnyBlock): string {
    if (!el || typeof el !== 'object') return '';
    if (el.type === 'rich_text_section') {
      return (el.elements || []).map((span: AnyBlock) => {
        if (span.type === 'text') return span.text || '';
        if (span.type === 'link' && span.url) {
          // Include the URL so the agent can see and resolve it.
          // Slack may render the link as display text (e.g. channel name)
          // which hides the actual URL from the agent.
          return span.text ? `${span.text} (${span.url})` : span.url;
        }
        if (span.type === 'user' && span.user_id) return `<@${span.user_id}>`;
        if (span.type === 'channel' && span.channel_id) return `<#${span.channel_id}>`;
        if (span.type === 'emoji' && span.name) return `:${span.name}:`;
        return '';
      }).join('');
    }
    return '';
  }

  function extractFromRichTextElement(el: AnyBlock): void {
    if (!el || typeof el !== 'object') return;

    // Rich text section (paragraph)
    if (el.type === 'rich_text_section') {
      const spans = extractRichTextInline(el);
      if (spans.trim()) parts.push(spans);
    }

    // Rich text list
    if (el.type === 'rich_text_list') {
      (el.elements || []).forEach((item: AnyBlock, i: number) => {
        const prefix = el.style === 'ordered' ? `${i + 1}. ` : '• ';
        const spans = (item.elements || []).map((section: AnyBlock) => {
          if (section.type === 'rich_text_section') {
            return (section.elements || []).map((span: AnyBlock) => {
              if (span.type === 'text') return span.text || '';
              if (span.type === 'link' && span.url) {
                return span.text ? `${span.text} (${span.url})` : span.url;
              }
              if (span.type === 'user' && span.user_id) return `<@${span.user_id}>`;
              return '';
            }).join('');
          }
          return '';
        }).join('');
        if (spans.trim()) parts.push(`${prefix}${spans}`);
      });
    }

    // Rich text preformatted (code blocks)
    if (el.type === 'rich_text_preformatted') {
      const spans = (el.elements || []).map((span: AnyBlock) => {
        if (span.type === 'rich_text_section') {
          return (span.elements || []).map((s: AnyBlock) => s.text || '').join('');
        }
        return '';
      }).join('');
      if (spans.trim()) parts.push('```\n' + spans + '\n```');
    }

    // Rich text quote
    if (el.type === 'rich_text_quote') {
      const spans = (el.elements || []).map((span: AnyBlock) => {
        if (span.type === 'rich_text_section') {
          return (span.elements || []).map((s: AnyBlock) => s.text || '').join('');
        }
        return '';
      }).join('');
      if (spans.trim()) parts.push('> ' + spans);
    }
  }

  for (const block of blocks) {
    extractFromBlock(block);
  }

  return parts.join('\n');
}
