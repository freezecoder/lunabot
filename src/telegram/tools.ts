/**
 * Telegram-specific tools for sending files, images, etc.
 * These tools are only available when running in Telegram bot context.
 */

import type { Tool } from '../types.js';
import type { Context } from 'telegraf';
import { existsSync, createReadStream } from 'fs';
import { basename } from 'path';

// Store Telegram contexts per chat (avoids race conditions with concurrent messages)
const contextMap = new Map<number, Context>();
let activeChatId: number | null = null;

/**
 * Set the current Telegram context for tools to use
 */
export function setTelegramContext(ctx: Context, chatId: number): void {
  contextMap.set(chatId, ctx);
  activeChatId = chatId;
  console.log(`[TelegramTools] Context set for chat ${chatId} (total contexts: ${contextMap.size})`);
}

/**
 * Clear the Telegram context for a specific chat
 */
export function clearTelegramContext(chatId?: number): void {
  const targetId = chatId ?? activeChatId;
  if (targetId) {
    contextMap.delete(targetId);
    console.log(`[TelegramTools] Context cleared for chat ${targetId}`);
  }
  if (activeChatId === targetId) {
    activeChatId = null;
  }
}

/**
 * Check if Telegram context is available
 */
export function hasTelegramContext(): boolean {
  return activeChatId !== null && contextMap.has(activeChatId);
}

/**
 * Get current context and chat ID
 */
function getCurrentContext(): { ctx: Context; chatId: number } | null {
  if (activeChatId && contextMap.has(activeChatId)) {
    return { ctx: contextMap.get(activeChatId)!, chatId: activeChatId };
  }
  return null;
}

/**
 * Send a document/file to the user
 */
export const sendDocumentTool: Tool = {
  name: 'telegram_send_document',
  description: 'Send a file/document to the user via Telegram. Use this to share reports, CSVs, text files, PDFs, etc. The file must exist on the local filesystem.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to send',
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the file',
      },
    },
    required: ['file_path'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const caption = args.caption as string | undefined;

    console.log(`[TelegramTools] telegram_send_document called with:`, { filePath, caption });

    const current = getCurrentContext();
    console.log(`[TelegramTools] Context available: ${!!current}, activeChatId: ${activeChatId}`);

    if (!current) {
      console.log(`[TelegramTools] ERROR: No Telegram context available`);
      return 'Error: Not in a Telegram context. This tool only works in Telegram bot.';
    }

    if (!existsSync(filePath)) {
      console.log(`[TelegramTools] ERROR: File not found: ${filePath}`);
      return `Error: File not found: ${filePath}`;
    }

    try {
      const filename = basename(filePath);
      const { statSync } = await import('fs');
      const stats = statSync(filePath);
      console.log(`[TelegramTools] File stats: ${stats.size} bytes, isFile: ${stats.isFile()}`);
      console.log(`[TelegramTools] Sending document ${filename} to chat ${current.chatId}...`);

      const result = await current.ctx.telegram.sendDocument(
        current.chatId,
        { source: createReadStream(filePath), filename },
        { caption }
      );
      console.log(`[TelegramTools] Document sent successfully: ${filename}`);
      console.log(`[TelegramTools] Telegram response:`, JSON.stringify(result, null, 2));
      return `Successfully sent document: ${filename}`;
    } catch (error) {
      console.error(`[TelegramTools] ERROR sending document:`, error);
      if (error instanceof Error) {
        console.error(`[TelegramTools] Error stack:`, error.stack);
      }
      return `Error sending document: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Send an image/photo to the user
 */
export const sendPhotoTool: Tool = {
  name: 'telegram_send_photo',
  description: 'Send an image/photo to the user via Telegram. Supports PNG, JPG, GIF. The file must exist on the local filesystem or be a URL.',
  parameters: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Absolute path to the image file OR a URL to an image',
      },
      caption: {
        type: 'string',
        description: 'Optional caption for the image',
      },
    },
    required: ['source'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const source = args.source as string;
    const caption = args.caption as string | undefined;

    const current = getCurrentContext();
    if (!current) {
      return 'Error: Not in a Telegram context. This tool only works in Telegram bot.';
    }

    try {
      // Check if it's a URL or file path
      if (source.startsWith('http://') || source.startsWith('https://')) {
        await current.ctx.telegram.sendPhoto(
          current.chatId,
          { url: source },
          { caption }
        );
        return `Successfully sent photo from URL`;
      } else {
        if (!existsSync(source)) {
          return `Error: File not found: ${source}`;
        }
        await current.ctx.telegram.sendPhoto(
          current.chatId,
          { source: createReadStream(source) },
          { caption }
        );
        return `Successfully sent photo: ${basename(source)}`;
      }
    } catch (error) {
      return `Error sending photo: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Send a voice/audio message
 */
export const sendAudioTool: Tool = {
  name: 'telegram_send_audio',
  description: 'Send an audio file to the user via Telegram. Supports MP3, OGG, etc.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the audio file',
      },
      caption: {
        type: 'string',
        description: 'Optional caption for the audio',
      },
      title: {
        type: 'string',
        description: 'Optional title for the audio track',
      },
    },
    required: ['file_path'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const caption = args.caption as string | undefined;
    const title = args.title as string | undefined;

    const current = getCurrentContext();
    if (!current) {
      return 'Error: Not in a Telegram context. This tool only works in Telegram bot.';
    }

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    try {
      const filename = basename(filePath);
      await current.ctx.telegram.sendAudio(
        current.chatId,
        { source: createReadStream(filePath), filename },
        { caption, title }
      );
      return `Successfully sent audio: ${filename}`;
    } catch (error) {
      return `Error sending audio: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Send a video file
 */
export const sendVideoTool: Tool = {
  name: 'telegram_send_video',
  description: 'Send a video file to the user via Telegram. Supports MP4, etc.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the video file',
      },
      caption: {
        type: 'string',
        description: 'Optional caption for the video',
      },
    },
    required: ['file_path'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = args.file_path as string;
    const caption = args.caption as string | undefined;

    const current = getCurrentContext();
    if (!current) {
      return 'Error: Not in a Telegram context. This tool only works in Telegram bot.';
    }

    if (!existsSync(filePath)) {
      return `Error: File not found: ${filePath}`;
    }

    try {
      const filename = basename(filePath);
      await current.ctx.telegram.sendVideo(
        current.chatId,
        { source: createReadStream(filePath), filename },
        { caption }
      );
      return `Successfully sent video: ${filename}`;
    } catch (error) {
      return `Error sending video: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Send multiple photos as an album/media group
 */
export const sendMediaGroupTool: Tool = {
  name: 'telegram_send_album',
  description: 'Send multiple images as an album/media group to the user via Telegram.',
  parameters: {
    type: 'object',
    properties: {
      images: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'File path or URL' },
            caption: { type: 'string', description: 'Caption for this image' },
          },
          required: ['source'],
        },
        description: 'Array of images to send (2-10 items)',
      },
    },
    required: ['images'],
  },
  async execute(args: Record<string, unknown>): Promise<string> {
    const images = args.images as Array<{ source: string; caption?: string }>;

    const current = getCurrentContext();
    if (!current) {
      return 'Error: Not in a Telegram context. This tool only works in Telegram bot.';
    }

    if (!images || images.length < 2) {
      return 'Error: Need at least 2 images for an album';
    }

    if (images.length > 10) {
      return 'Error: Maximum 10 images per album';
    }

    try {
      const media = images.map((img, index) => {
        const isUrl = img.source.startsWith('http://') || img.source.startsWith('https://');
        return {
          type: 'photo' as const,
          media: isUrl ? img.source : { source: createReadStream(img.source) },
          caption: index === 0 ? img.caption : undefined, // Only first image gets caption
        };
      });

      await current.ctx.telegram.sendMediaGroup(current.chatId, media);
      return `Successfully sent album with ${images.length} images`;
    } catch (error) {
      return `Error sending album: ${error instanceof Error ? error.message : error}`;
    }
  },
};

/**
 * Get all Telegram-specific tools
 */
export function getTelegramTools(): Tool[] {
  return [
    sendDocumentTool,
    sendPhotoTool,
    sendAudioTool,
    sendVideoTool,
    sendMediaGroupTool,
  ];
}
