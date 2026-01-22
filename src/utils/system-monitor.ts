/**
 * System Monitor - Get system resource information
 */

import { freemem, totalmem, cpus, loadavg, uptime, hostname, platform, arch } from 'os';
import { execSync } from 'child_process';

export interface SystemStats {
  // Memory
  memoryUsed: number;      // bytes
  memoryTotal: number;     // bytes
  memoryPercent: number;   // 0-100

  // CPU
  cpuLoad: number[];       // 1, 5, 15 min load averages
  cpuCount: number;
  cpuModel: string;

  // System
  uptime: number;          // seconds
  hostname: string;
  platform: string;
  arch: string;

  // Process
  processMemory: number;   // bytes (Node.js process)
  processUptime: number;   // seconds
}

export interface OllamaStats {
  running: boolean;
  models?: string[];
  activeModel?: string;
  vram?: number;           // bytes, if available
}

/**
 * Get current system statistics
 */
export function getSystemStats(): SystemStats {
  const memTotal = totalmem();
  const memFree = freemem();
  const memUsed = memTotal - memFree;

  const cpuInfo = cpus();

  return {
    memoryUsed: memUsed,
    memoryTotal: memTotal,
    memoryPercent: (memUsed / memTotal) * 100,

    cpuLoad: loadavg(),
    cpuCount: cpuInfo.length,
    cpuModel: cpuInfo[0]?.model || 'Unknown',

    uptime: uptime(),
    hostname: hostname(),
    platform: platform(),
    arch: arch(),

    processMemory: process.memoryUsage().heapUsed,
    processUptime: process.uptime(),
  };
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format uptime to human readable
 */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Get a compact one-line system status
 */
export function getCompactStatus(): string {
  const stats = getSystemStats();
  const memPct = stats.memoryPercent.toFixed(0);
  const load = stats.cpuLoad[0].toFixed(2);
  const memUsed = formatBytes(stats.memoryUsed);
  const memTotal = formatBytes(stats.memoryTotal);

  return `Mem: ${memUsed}/${memTotal} (${memPct}%) | Load: ${load} | CPUs: ${stats.cpuCount}`;
}

/**
 * Get Ollama server status
 */
export async function getOllamaStats(host: string): Promise<OllamaStats> {
  try {
    // Check if Ollama is responding
    const response = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(3000)
    });

    if (!response.ok) {
      return { running: false };
    }

    const data = await response.json() as { models?: Array<{ name: string }> };
    const models = data.models?.map(m => m.name) || [];

    // Try to get running model info
    let activeModel: string | undefined;
    let vram: number | undefined;

    try {
      const psResponse = await fetch(`${host}/api/ps`, {
        signal: AbortSignal.timeout(2000)
      });

      if (psResponse.ok) {
        const psData = await psResponse.json() as {
          models?: Array<{ name: string; size_vram?: number }>
        };
        if (psData.models && psData.models.length > 0) {
          activeModel = psData.models[0].name;
          vram = psData.models[0].size_vram;
        }
      }
    } catch {
      // ps endpoint might not be available
    }

    return {
      running: true,
      models,
      activeModel,
      vram,
    };
  } catch {
    return { running: false };
  }
}

/**
 * Get GPU info (macOS specific for now)
 */
export function getGpuInfo(): string | null {
  try {
    if (platform() === 'darwin') {
      // macOS - check for Apple Silicon GPU
      const result = execSync('system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset|VRAM|Metal"', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return result.trim() || null;
    }
    // Linux - try nvidia-smi
    if (platform() === 'linux') {
      try {
        const result = execSync('nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null', {
          encoding: 'utf-8',
          timeout: 5000,
        });
        if (result) {
          const [name, used, total] = result.trim().split(', ');
          return `${name}: ${used}MB / ${total}MB`;
        }
      } catch {
        // No nvidia-smi
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get full system report
 */
export async function getFullSystemReport(ollamaHost?: string): Promise<string> {
  const stats = getSystemStats();
  const gpu = getGpuInfo();

  const lines: string[] = [
    '## System Status',
    '',
    `**Host:** ${stats.hostname} (${stats.platform} ${stats.arch})`,
    `**Uptime:** ${formatUptime(stats.uptime)}`,
    '',
    '### Memory',
    `  Used: ${formatBytes(stats.memoryUsed)} / ${formatBytes(stats.memoryTotal)} (${stats.memoryPercent.toFixed(1)}%)`,
    `  Free: ${formatBytes(stats.memoryTotal - stats.memoryUsed)}`,
    '',
    '### CPU',
    `  Model: ${stats.cpuModel}`,
    `  Cores: ${stats.cpuCount}`,
    `  Load: ${stats.cpuLoad.map(l => l.toFixed(2)).join(', ')} (1m, 5m, 15m)`,
  ];

  if (gpu) {
    lines.push('', '### GPU', `  ${gpu}`);
  }

  if (ollamaHost) {
    const ollama = await getOllamaStats(ollamaHost);
    lines.push('', '### Ollama');
    if (ollama.running) {
      lines.push(`  Status: Running`);
      lines.push(`  Models: ${ollama.models?.length || 0} available`);
      if (ollama.activeModel) {
        lines.push(`  Active: ${ollama.activeModel}`);
      }
      if (ollama.vram) {
        lines.push(`  VRAM: ${formatBytes(ollama.vram)}`);
      }
    } else {
      lines.push(`  Status: Not responding`);
    }
  }

  lines.push(
    '',
    '### Process',
    `  Memory: ${formatBytes(stats.processMemory)}`,
    `  Uptime: ${formatUptime(stats.processUptime)}`,
  );

  return lines.join('\n');
}
