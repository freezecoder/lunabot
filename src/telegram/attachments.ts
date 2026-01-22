/**
 * Telegram Attachment Handler
 * Downloads, stores, and logs attachments from Telegram messages
 */

import { mkdir, writeFile } from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import { join, basename } from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { Context } from 'telegraf';
import type { Message, PhotoSize, Document, Voice, Audio, Video } from 'telegraf/types';
import { logActivity } from '../utils/activity-tracker.js';

// Attachment storage directory
const ATTACHMENTS_DIR = process.env.LOCALBOT_ATTACHMENTS_DIR || join(process.cwd(), 'attachments');

// Max file size to download (50MB - Telegram's limit)
const MAX_FILE_SIZE = 50 * 1024 * 1024;

export interface AttachmentInfo {
  type: 'document' | 'photo' | 'voice' | 'audio' | 'video';
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  localPath: string;
  caption?: string;
  duration?: number; // For audio/voice/video
  width?: number;    // For photo/video
  height?: number;   // For photo/video
}

export interface AttachmentResult {
  success: boolean;
  attachment?: AttachmentInfo;
  error?: string;
}

/**
 * Ensure attachments directory exists
 */
async function ensureAttachmentsDir(): Promise<void> {
  if (!existsSync(ATTACHMENTS_DIR)) {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    console.log(`[Attachments] Created directory: ${ATTACHMENTS_DIR}`);
  }
}

/**
 * Generate a unique filename for an attachment
 */
function generateFileName(chatId: number, originalName: string, fileId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = originalName.includes('.') ? originalName.split('.').pop() : '';
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50);
  return `${chatId}_${timestamp}_${safeName}${ext ? '' : `.${fileId.slice(-8)}`}`;
}

/**
 * Download a file from Telegram
 */
async function downloadFile(ctx: Context, fileId: string, localPath: string): Promise<void> {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await writeFile(localPath, Buffer.from(buffer));
}

/**
 * Log attachment activity
 */
function logAttachment(info: AttachmentInfo, chatId: number, userId?: string): void {
  const sizeStr = info.fileSize ? ` (${(info.fileSize / 1024).toFixed(1)}KB)` : '';
  console.log(`[Attachments] ${info.type}: ${info.fileName}${sizeStr} -> ${info.localPath}`);

  logActivity({
    source: 'telegram',
    type: 'attachment',
    sessionId: `telegram-${chatId}`,
    userId: userId || String(chatId),
    content: `${info.type}: ${info.fileName}${sizeStr}`,
  });
}

/**
 * Handle document (file) uploads
 */
export async function handleDocument(
  ctx: Context,
  document: Document,
  caption?: string
): Promise<AttachmentResult> {
  try {
    await ensureAttachmentsDir();

    const chatId = ctx.chat!.id;
    const userId = ctx.from?.username;

    // Check file size
    if (document.file_size && document.file_size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `File too large (${(document.file_size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.`,
      };
    }

    const fileName = document.file_name || `document_${document.file_id.slice(-8)}`;
    const localFileName = generateFileName(chatId, fileName, document.file_id);
    const localPath = join(ATTACHMENTS_DIR, localFileName);

    await downloadFile(ctx, document.file_id, localPath);

    const info: AttachmentInfo = {
      type: 'document',
      fileId: document.file_id,
      fileName,
      mimeType: document.mime_type,
      fileSize: document.file_size,
      localPath,
      caption,
    };

    logAttachment(info, chatId, userId);

    return { success: true, attachment: info };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Attachments] Document download failed:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Handle photo uploads (gets the largest version)
 */
export async function handlePhoto(
  ctx: Context,
  photos: PhotoSize[],
  caption?: string
): Promise<AttachmentResult> {
  try {
    await ensureAttachmentsDir();

    const chatId = ctx.chat!.id;
    const userId = ctx.from?.username;

    // Get the largest photo (last in array)
    const photo = photos[photos.length - 1];

    if (photo.file_size && photo.file_size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `Photo too large (${(photo.file_size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.`,
      };
    }

    const fileName = `photo_${photo.file_id.slice(-8)}.jpg`;
    const localFileName = generateFileName(chatId, fileName, photo.file_id);
    const localPath = join(ATTACHMENTS_DIR, localFileName);

    await downloadFile(ctx, photo.file_id, localPath);

    const info: AttachmentInfo = {
      type: 'photo',
      fileId: photo.file_id,
      fileName,
      mimeType: 'image/jpeg',
      fileSize: photo.file_size,
      localPath,
      caption,
      width: photo.width,
      height: photo.height,
    };

    logAttachment(info, chatId, userId);

    return { success: true, attachment: info };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Attachments] Photo download failed:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Handle voice message uploads
 */
export async function handleVoice(
  ctx: Context,
  voice: Voice
): Promise<AttachmentResult> {
  try {
    await ensureAttachmentsDir();

    const chatId = ctx.chat!.id;
    const userId = ctx.from?.username;

    if (voice.file_size && voice.file_size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `Voice message too large.`,
      };
    }

    const fileName = `voice_${voice.file_id.slice(-8)}.ogg`;
    const localFileName = generateFileName(chatId, fileName, voice.file_id);
    const localPath = join(ATTACHMENTS_DIR, localFileName);

    await downloadFile(ctx, voice.file_id, localPath);

    const info: AttachmentInfo = {
      type: 'voice',
      fileId: voice.file_id,
      fileName,
      mimeType: voice.mime_type || 'audio/ogg',
      fileSize: voice.file_size,
      localPath,
      duration: voice.duration,
    };

    logAttachment(info, chatId, userId);

    return { success: true, attachment: info };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Attachments] Voice download failed:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Handle audio file uploads
 */
export async function handleAudio(
  ctx: Context,
  audio: Audio,
  caption?: string
): Promise<AttachmentResult> {
  try {
    await ensureAttachmentsDir();

    const chatId = ctx.chat!.id;
    const userId = ctx.from?.username;

    if (audio.file_size && audio.file_size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `Audio file too large.`,
      };
    }

    const fileName = audio.file_name || `audio_${audio.file_id.slice(-8)}.mp3`;
    const localFileName = generateFileName(chatId, fileName, audio.file_id);
    const localPath = join(ATTACHMENTS_DIR, localFileName);

    await downloadFile(ctx, audio.file_id, localPath);

    const info: AttachmentInfo = {
      type: 'audio',
      fileId: audio.file_id,
      fileName,
      mimeType: audio.mime_type || 'audio/mpeg',
      fileSize: audio.file_size,
      localPath,
      caption,
      duration: audio.duration,
    };

    logAttachment(info, chatId, userId);

    return { success: true, attachment: info };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Attachments] Audio download failed:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Handle video uploads
 */
export async function handleVideo(
  ctx: Context,
  video: Video,
  caption?: string
): Promise<AttachmentResult> {
  try {
    await ensureAttachmentsDir();

    const chatId = ctx.chat!.id;
    const userId = ctx.from?.username;

    if (video.file_size && video.file_size > MAX_FILE_SIZE) {
      return {
        success: false,
        error: `Video too large (${(video.file_size / 1024 / 1024).toFixed(1)}MB). Maximum is 50MB.`,
      };
    }

    const fileName = video.file_name || `video_${video.file_id.slice(-8)}.mp4`;
    const localFileName = generateFileName(chatId, fileName, video.file_id);
    const localPath = join(ATTACHMENTS_DIR, localFileName);

    await downloadFile(ctx, video.file_id, localPath);

    const info: AttachmentInfo = {
      type: 'video',
      fileId: video.file_id,
      fileName,
      mimeType: video.mime_type || 'video/mp4',
      fileSize: video.file_size,
      localPath,
      caption,
      duration: video.duration,
      width: video.width,
      height: video.height,
    };

    logAttachment(info, chatId, userId);

    return { success: true, attachment: info };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[Attachments] Video download failed:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Format attachment info for display to user
 */
export function formatAttachmentInfo(info: AttachmentInfo): string {
  const parts: string[] = [];

  switch (info.type) {
    case 'document':
      parts.push(`📄 File: ${info.fileName}`);
      break;
    case 'photo':
      parts.push(`🖼️ Photo: ${info.width}x${info.height}`);
      break;
    case 'voice':
      parts.push(`🎤 Voice: ${info.duration}s`);
      break;
    case 'audio':
      parts.push(`🎵 Audio: ${info.fileName}`);
      break;
    case 'video':
      parts.push(`🎬 Video: ${info.width}x${info.height}, ${info.duration}s`);
      break;
  }

  if (info.fileSize) {
    const sizeKB = info.fileSize / 1024;
    parts.push(sizeKB > 1024 ? `${(sizeKB / 1024).toFixed(1)}MB` : `${sizeKB.toFixed(1)}KB`);
  }

  if (info.mimeType) {
    parts.push(info.mimeType);
  }

  return parts.join(' | ');
}

/**
 * Get content summary for text-based files
 */
export async function getTextFilePreview(localPath: string, maxLines: number = 20): Promise<string | null> {
  const textExtensions = ['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log', '.ts', '.js', '.py', '.sh'];
  const ext = localPath.toLowerCase().slice(localPath.lastIndexOf('.'));

  if (!textExtensions.includes(ext)) {
    return null;
  }

  try {
    const { readFile } = await import('fs/promises');
    const content = await readFile(localPath, 'utf-8');
    const lines = content.split('\n').slice(0, maxLines);

    if (content.split('\n').length > maxLines) {
      lines.push(`... (${content.split('\n').length - maxLines} more lines)`);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}
