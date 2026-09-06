import { readFileSync, statSync, existsSync } from 'node:fs';
import type { Model } from '../../../model.js';
import type { Tool } from '../../../tool.js';
import { messageContentToText, type FileContentPart } from '../../../types.js';
import { makeToolName, isImageFile, imageMime } from './shared.js';

export interface ViewImageConfig {
  /** Tool name prefix (same as parent extension). */
  toolPrefix: string;
  /** Vision-capable model. Required. */
  visionModel: Model;
}

export function viewImageTool(cfg: ViewImageConfig): Tool {
  const prefix = cfg.toolPrefix;
  const visionModel = cfg.visionModel;

  return {
    name: makeToolName(prefix, 'view_image'),
    description:
      'Inspect an image or screenshot from the local filesystem using a vision model. ' +
      'Returns a detailed description or answers a specific question about the image contents. ' +
      'Use absolute paths. Supports PNG, JPG, JPEG, WEBP, GIF, and BMP.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the image file to inspect.',
        },
        prompt: {
          type: 'string',
          description: 'Question or instruction about what to look for or describe in the image. Default: "Describe this image in detail."',
        },
      },
      required: ['file_path'],
    },
    async execute(args, ctx) {
      const filePath = String(args.file_path ?? '').trim();
      if (!filePath) {
        return { toolCallId: '', content: 'Error: file_path is required', isError: true };
      }

      if (!existsSync(filePath)) {
        return { toolCallId: '', content: `File not found: ${filePath}`, isError: true };
      }

      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return { toolCallId: '', content: `Path is a directory, not an image file: ${filePath}`, isError: true };
      }

      if (!isImageFile(filePath)) {
        return {
          toolCallId: '',
          content: `Unsupported image format for "${filePath}". Supported formats: .png, .jpg, .jpeg, .webp, .gif, .bmp`,
          isError: true,
        };
      }

      const promptText = (typeof args.prompt === 'string' && args.prompt.trim())
        ? args.prompt.trim()
        : 'Describe this image in detail.';

      try {
        const mime = imageMime(filePath);
        const buffer = readFileSync(filePath);

        const filePart: FileContentPart = {
          type: 'file',
          mediaType: mime,
          data: {
            type: 'data',
            data: buffer,
          },
        };

        const response = await visionModel.generate({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                filePart,
              ],
            },
          ],
          signal: ctx.signal,
        });

        const text = messageContentToText(response.message.content);
        return {
          toolCallId: '',
          content: text || 'Vision model returned an empty response.',
        };
      } catch (err) {
        return {
          toolCallId: '',
          content: `Vision inspection failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
