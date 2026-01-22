/**
 * Gateway Types - Shared types for the LocalBot gateway system
 * Inspired by clawdbot's gateway architecture but simplified
 */

/**
 * Service status
 */
export type ServiceStatus = 'stopped' | 'starting' | 'running' | 'error';

/**
 * Service info
 */
export interface ServiceInfo {
  name: string;
  status: ServiceStatus;
  error?: string;
  startedAt?: number;
  stats?: Record<string, unknown>;
}

/**
 * Gateway health snapshot
 */
export interface GatewayHealth {
  uptime: number;
  startedAt: number;
  services: ServiceInfo[];
  system: {
    memory: { used: number; total: number; percent: number };
    cpu: number[];
  };
}

/**
 * WebSocket message types
 */
export type WsMessageType = 'request' | 'response' | 'event';

/**
 * WebSocket request
 */
export interface WsRequest {
  type: 'request';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * WebSocket response
 */
export interface WsResponse {
  type: 'response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/**
 * WebSocket event
 */
export interface WsEvent {
  type: 'event';
  event: string;
  payload?: unknown;
  timestamp: number;
}

/**
 * Gateway configuration
 */
export interface GatewayConfig {
  port: number;
  host: string;
  telegram: {
    enabled: boolean;
    token?: string;
  };
  cron: {
    enabled: boolean;
    checkIntervalMs: number;
  };
  tui: {
    enabled: boolean;
  };
  memorySync?: {
    enabled: boolean;
    intervalMs?: number;     // How often to sync (default: 30 min)
    minIdleMs?: number;      // Min time since last message (default: 5 min)
    batchSize?: number;      // Max sessions per sync (default: 10)
    channels?: ('terminal' | 'telegram')[];
  };
}

/**
 * Default gateway config
 */
export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  port: parseInt(process.env.LOCALBOT_GATEWAY_PORT || '18800', 10),
  host: process.env.LOCALBOT_GATEWAY_HOST || '127.0.0.1',
  telegram: {
    enabled: !!process.env.TELEGRAM_BOT_TOKEN,
    token: process.env.TELEGRAM_BOT_TOKEN,
  },
  cron: {
    enabled: true,
    checkIntervalMs: 60000,
  },
  tui: {
    enabled: false,
  },
  memorySync: {
    enabled: process.env.LOCALBOT_MEMORY_SYNC_ENABLED !== 'false',
    intervalMs: parseInt(process.env.LOCALBOT_MEMORY_SYNC_INTERVAL || '1800000', 10),
    minIdleMs: parseInt(process.env.LOCALBOT_MEMORY_SYNC_MIN_AGE || '300000', 10),
    batchSize: 10,
    channels: ['telegram', 'terminal'],
  },
};

/**
 * Gateway methods
 */
export const GATEWAY_METHODS = [
  'health',
  'status',
  'services.list',
  'services.start',
  'services.stop',
  'services.restart',
  'cron.list',
  'cron.add',
  'cron.remove',
  'chat.send',
  'chat.history',
] as const;

export type GatewayMethod = typeof GATEWAY_METHODS[number];
