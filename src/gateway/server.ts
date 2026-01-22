/**
 * Gateway Server - HTTP/WebSocket server for LocalBot
 * Provides status API, real-time event streaming, and web dashboard
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFile, stat } from 'fs/promises';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getSystemStats, getOllamaStats } from '../utils/system-monitor.js';
import { readActivityLog, getRecentActivity, getActivityStats } from '../utils/activity-tracker.js';
import { cronStore } from '../cron/index.js';
import { servicesManager } from './services.js';
import { globalMetrics } from '../tracking/metrics.js';
import { getDB } from '../db/index.js';
import type { Channel, EventQueryOptions } from '../db/types.js';
import { getProjectManager } from '../project/index.js';
import { getMemoryManager } from '../memory/manager.js';
import { getMemorySyncService } from '../memory/sync-service.js';
import { loadWorkspaceBootstrapFiles, type WorkspaceFile } from '../workspace/loader.js';
import { getAgentDir, getGlobalContextDir } from '../config/paths.js';
import { Agent, type StreamEvent } from '../agent/agent.js';
import { OllamaProvider } from '../agent/providers/ollama.js';
import { ToolRegistry } from '../tools/registry.js';
import { getAllBuiltInTools } from '../tools/built-in/index.js';
import { loadContext, buildSystemPrompt } from '../context/loader.js';
import { v4 as uuid } from 'uuid';
import type { Message, Session, ToolCall } from '../types.js';
import type {
  GatewayConfig,
  GatewayHealth,
  WsRequest,
  WsResponse,
  WsEvent,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// MIME types for static files
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Connected WebSocket client
 */
interface WsClient {
  ws: WebSocket;
  id: string;
  connectedAt: number;
  subscriptions: Set<string>;
}

/**
 * Web chat session
 */
interface WebChatSession {
  id: string;
  messages: Message[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Gateway Server
 */
export class GatewayServer {
  private config: GatewayConfig;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WsClient> = new Map();
  private startedAt: number = 0;
  private eventSeq: number = 0;

  // Chat service components
  private chatAgent: Agent | null = null;
  private chatRegistry: ToolRegistry | null = null;
  private chatSessions: Map<string, WebChatSession> = new Map();

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  /**
   * Start the gateway server
   */
  async start(): Promise<void> {
    this.startedAt = Date.now();

    // Create HTTP server
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));

    // Create WebSocket server
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => this.handleWsConnection(ws));

    // Start listening
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`[Gateway] Port ${this.config.port} is already in use.`);
          console.error(`[Gateway] Try: lsof -ti:${this.config.port} | xargs kill -9`);
          console.error(`[Gateway] Or set LOCALBOT_GATEWAY_PORT to a different port.`);
        }
        reject(err);
      });
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        console.log(`[Gateway] Server listening on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the gateway server
   */
  async stop(): Promise<void> {
    // Close all WebSocket clients
    for (const client of this.clients.values()) {
      client.ws.close(1000, 'Gateway shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    console.log('[Gateway] Server stopped');
  }

  /**
   * Handle HTTP requests
   */
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Route handling
    if (url.pathname === '/' || url.pathname === '/dashboard') {
      // Redirect to dashboard
      res.writeHead(302, { 'Location': '/dashboard/' });
      res.end();
      return;
    }

    if (url.pathname.startsWith('/dashboard/') || url.pathname === '/dashboard') {
      this.handleStaticFile(req, res, url.pathname);
      return;
    }

    // Handle parameterized routes
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (sessionMatch) {
      this.handleSessionMessagesRequest(res, sessionMatch[1]);
      return;
    }

    switch (url.pathname) {
      case '/health':
        this.handleHealthRequest(res);
        break;
      case '/status':
        this.handleStatusRequest(res);
        break;
      case '/services':
        this.handleServicesRequest(res);
        break;
      case '/cron':
        this.handleCronRequest(req, res);
        break;
      case '/api/sessions':
        this.handleSessionsRequest(res);
        break;
      case '/api/tools':
        this.handleToolsRequest(res);
        break;
      case '/api/activity':
        this.handleActivityRequest(req, res, url);
        break;
      case '/api/metrics':
        this.handleMetricsRequest(res);
        break;
      case '/api/ollama':
        this.handleOllamaRequest(res);
        break;
      // New SQLite-backed endpoints
      case '/api/events':
        this.handleEventsRequest(req, res, url);
        break;
      case '/api/events/stats':
        this.handleEventStatsRequest(res);
        break;
      case '/api/startup/latest':
        this.handleStartupLatestRequest(req, res, url);
        break;
      case '/api/startup':
        this.handleStartupManifestsRequest(res);
        break;
      case '/api/db/sessions':
        this.handleDbSessionsRequest(req, res, url);
        break;
      case '/api/db/sessions/stats':
        this.handleDbSessionStatsRequest(res);
        break;
      // Project management endpoints
      case '/api/projects':
        this.handleProjectsRequest(req, res);
        break;
      case '/api/projects/active':
        this.handleActiveProjectRequest(req, res);
        break;
      case '/api/projects/config':
        this.handleProjectsConfigRequest(req, res);
        break;
      // Memory endpoints
      case '/api/memory/status':
        this.handleMemoryStatusRequest(res);
        break;
      case '/api/memory/sync':
        this.handleMemorySyncRequest(req, res);
        break;
      case '/api/memory/history':
        this.handleMemorySyncHistoryRequest(req, res, url);
        break;
      case '/api/events/types':
        this.handleEventTypesRequest(res);
        break;
      // Workspace endpoints
      case '/api/workspace':
        this.handleWorkspaceRequest(res);
        break;
      default:
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  /**
   * Handle /health endpoint
   */
  private handleHealthRequest(res: ServerResponse): void {
    const sysStats = getSystemStats();
    const health: GatewayHealth = {
      uptime: Date.now() - this.startedAt,
      startedAt: this.startedAt,
      services: servicesManager.getAll(),
      system: {
        memory: {
          used: sysStats.memoryUsed,
          total: sysStats.memoryTotal,
          percent: sysStats.memoryPercent,
        },
        cpu: sysStats.cpuLoad,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
  }

  /**
   * Handle /status endpoint
   */
  private handleStatusRequest(res: ServerResponse): void {
    const status = {
      gateway: {
        uptime: Date.now() - this.startedAt,
        clients: this.clients.size,
        port: this.config.port,
      },
      services: servicesManager.getAll(),
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  }

  /**
   * Handle /services endpoint
   */
  private handleServicesRequest(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(servicesManager.getAll(), null, 2));
  }

  /**
   * Handle /cron endpoint
   */
  private async handleCronRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const jobs = await cronStore.getAll(true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jobs, null, 2));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  }

  /**
   * Handle static file serving for dashboard
   */
  private async handleStaticFile(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    try {
      // Remove /dashboard prefix and default to index.html
      let filePath = pathname.replace(/^\/dashboard\/?/, '') || 'index.html';
      if (filePath === '' || filePath.endsWith('/')) {
        filePath += 'index.html';
      }

      const webDir = join(__dirname, 'web');
      const fullPath = join(webDir, filePath);

      // Security: ensure path is within web directory
      if (!fullPath.startsWith(webDir)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }

      const fileStats = await stat(fullPath);
      if (!fileStats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const ext = extname(fullPath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await readFile(fullPath);

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  }

  /**
   * Handle /api/sessions endpoint
   */
  private handleSessionsRequest(res: ServerResponse): void {
    // Import session data from activity tracker stats
    const stats = getActivityStats();
    const sessions = {
      terminal: {
        messages: stats.terminal.messages,
        toolCalls: stats.terminal.toolCalls,
        errors: stats.terminal.errors,
      },
      telegram: {
        messages: stats.telegram.messages,
        toolCalls: stats.telegram.toolCalls,
        errors: stats.telegram.errors,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions, null, 2));
  }

  /**
   * Handle /api/tools endpoint
   */
  private handleToolsRequest(res: ServerResponse): void {
    // Tools are registered globally, we can get them from the registry
    // For now return placeholder - tools would need to be passed from bot
    const tools = {
      count: 0,
      tools: [] as Array<{ name: string; description: string }>,
      note: 'Tool list available when bot is running',
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tools, null, 2));
  }

  /**
   * Handle /api/activity endpoint
   */
  private handleActivityRequest(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const source = url.searchParams.get('source') as 'terminal' | 'telegram' | undefined;

    const entries = getRecentActivity(limit, source);
    const stats = getActivityStats();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entries, stats }, null, 2));
  }

  /**
   * Handle /api/metrics endpoint
   */
  private handleMetricsRequest(res: ServerResponse): void {
    const metrics = globalMetrics.export();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics, null, 2));
  }

  /**
   * Handle /api/ollama endpoint
   */
  private async handleOllamaRequest(res: ServerResponse): Promise<void> {
    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const stats = await getOllamaStats(ollamaHost);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
  }

  /**
   * Handle new WebSocket connection
   */
  private handleWsConnection(ws: WebSocket): void {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const client: WsClient = {
      ws,
      id: clientId,
      connectedAt: Date.now(),
      subscriptions: new Set(['*']), // Subscribe to all by default
    };

    this.clients.set(clientId, client);
    console.log(`[Gateway] WebSocket client connected: ${clientId}`);

    // Send welcome event
    this.sendEvent(client, 'connected', {
      clientId,
      services: servicesManager.getAll(),
    });

    // Handle messages
    ws.on('message', (data) => this.handleWsMessage(client, data.toString()));

    // Handle close
    ws.on('close', () => {
      this.clients.delete(clientId);
      console.log(`[Gateway] WebSocket client disconnected: ${clientId}`);
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error(`[Gateway] WebSocket error for ${clientId}:`, error);
    });
  }

  /**
   * Handle WebSocket message
   */
  private async handleWsMessage(client: WsClient, data: string): Promise<void> {
    try {
      const message = JSON.parse(data) as WsRequest;

      if (message.type !== 'request') {
        return;
      }

      const response = await this.handleWsRequest(message);
      client.ws.send(JSON.stringify(response));
    } catch (error) {
      console.error('[Gateway] Failed to handle WS message:', error);
    }
  }

  /**
   * Handle WebSocket request
   */
  private async handleWsRequest(req: WsRequest): Promise<WsResponse> {
    try {
      let payload: unknown;

      switch (req.method) {
        case 'health':
          payload = {
            uptime: Date.now() - this.startedAt,
            services: servicesManager.getAll(),
          };
          break;

        case 'services.list':
          payload = servicesManager.getAll();
          break;

        case 'services.start':
          if (req.params?.name) {
            await servicesManager.start(req.params.name as string);
            payload = servicesManager.get(req.params.name as string);
          }
          break;

        case 'services.stop':
          if (req.params?.name) {
            await servicesManager.stop(req.params.name as string);
            payload = servicesManager.get(req.params.name as string);
          }
          break;

        case 'services.restart':
          if (req.params?.name) {
            await servicesManager.restart(req.params.name as string);
            payload = servicesManager.get(req.params.name as string);
          }
          break;

        case 'cron.list':
          payload = await cronStore.getAll(true);
          break;

        case 'memory.status':
          try {
            const memManager = await getMemoryManager();
            const memStatus = await memManager.getStatus();
            const db = getDB();
            payload = {
              memory: memStatus,
              sync: db.getMemorySyncStats(),
            };
          } catch (e) {
            payload = { error: e instanceof Error ? e.message : 'Failed to get memory status' };
          }
          break;

        case 'memory.sync':
          try {
            const syncSvc = getMemorySyncService();
            const { synced, errors } = await syncSvc.runSync();
            payload = { synced, errors };
          } catch (e) {
            payload = { error: e instanceof Error ? e.message : 'Sync failed' };
          }
          break;

        // ============ Chat methods ============
        case 'chat.start':
          try {
            const chatSession = await this.createChatSession(req.params?.model as string | undefined);
            payload = {
              sessionId: chatSession.id,
              model: chatSession.model,
            };
          } catch (e) {
            return {
              type: 'response',
              id: req.id,
              ok: false,
              error: e instanceof Error ? e.message : 'Failed to start chat session',
            };
          }
          break;

        case 'chat.load':
          try {
            const sessionId = req.params?.sessionId as string;
            if (!sessionId) {
              throw new Error('Session ID required');
            }
            const session = await this.loadChatSession(sessionId);
            payload = {
              sessionId: session.id,
              model: session.model,
              messages: session.messages,
            };
          } catch (e) {
            return {
              type: 'response',
              id: req.id,
              ok: false,
              error: e instanceof Error ? e.message : 'Failed to load session',
            };
          }
          break;

        case 'chat.send':
          // This is handled specially - don't return immediately
          // The response will be streamed via events
          this.handleChatSend(req, req.params as { sessionId: string; content: string });
          return {
            type: 'response',
            id: req.id,
            ok: true,
            payload: { status: 'processing' },
          };

        default:
          return {
            type: 'response',
            id: req.id,
            ok: false,
            error: `Unknown method: ${req.method}`,
          };
      }

      return {
        type: 'response',
        id: req.id,
        ok: true,
        payload,
      };
    } catch (error) {
      return {
        type: 'response',
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send event to a client
   */
  private sendEvent(client: WsClient, event: string, payload?: unknown): void {
    const msg: WsEvent = {
      type: 'event',
      event,
      payload,
      timestamp: Date.now(),
    };

    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast event to all clients
   */
  broadcast(event: string, payload?: unknown): void {
    this.eventSeq++;
    const msg: WsEvent = {
      type: 'event',
      event,
      payload,
      timestamp: Date.now(),
    };
    const data = JSON.stringify(msg);

    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        // Check subscription
        if (client.subscriptions.has('*') || client.subscriptions.has(event)) {
          client.ws.send(data);
        }
      }
    }
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  // ============ New SQLite-backed endpoints ============

  /**
   * Handle /api/events endpoint - list events from database
   */
  private handleEventsRequest(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const db = getDB();

    const options: EventQueryOptions = {
      limit: parseInt(url.searchParams.get('limit') || '100', 10),
      offset: parseInt(url.searchParams.get('offset') || '0', 10),
    };

    const channel = url.searchParams.get('channel');
    if (channel) {
      options.channel = channel as Channel;
    }

    const eventType = url.searchParams.get('type');
    if (eventType) {
      options.eventType = eventType as any;
    }

    const sessionId = url.searchParams.get('session_id');
    if (sessionId) {
      options.sessionId = sessionId;
    }

    const level = url.searchParams.get('level');
    if (level) {
      options.level = level as any;
    }

    const since = url.searchParams.get('since');
    if (since) {
      options.since = parseInt(since, 10);
    }

    const events = db.getEvents(options);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events, count: events.length }, null, 2));
  }

  /**
   * Handle /api/events/stats endpoint
   */
  private handleEventStatsRequest(res: ServerResponse): void {
    const db = getDB();
    const stats = db.getEventStats();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
  }

  /**
   * Handle /api/sessions/:id/messages endpoint
   */
  private handleSessionMessagesRequest(res: ServerResponse, sessionId: string): void {
    const db = getDB();
    const session = db.getSessionWithMessages(sessionId);

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(session, null, 2));
  }

  /**
   * Handle /api/startup/latest endpoint
   */
  private handleStartupLatestRequest(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const db = getDB();
    const channel = url.searchParams.get('channel') as Channel | undefined;
    const manifest = db.getLatestStartupManifest(channel || undefined);

    if (!manifest) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No startup manifest found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(manifest, null, 2));
  }

  /**
   * Handle /api/startup endpoint - list all startup manifests
   */
  private handleStartupManifestsRequest(res: ServerResponse): void {
    const db = getDB();
    const manifests = db.getStartupManifests(20);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ manifests, count: manifests.length }, null, 2));
  }

  /**
   * Handle /api/db/sessions endpoint - list sessions from database
   */
  private handleDbSessionsRequest(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const db = getDB();

    const options: any = {
      limit: parseInt(url.searchParams.get('limit') || '50', 10),
      offset: parseInt(url.searchParams.get('offset') || '0', 10),
    };

    const channel = url.searchParams.get('channel');
    if (channel) {
      options.channel = channel as Channel;
    }

    const userId = url.searchParams.get('user_id');
    if (userId) {
      options.userId = userId;
    }

    const sessions = db.getSessions(options);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions, count: sessions.length }, null, 2));
  }

  /**
   * Handle /api/db/sessions/stats endpoint
   */
  private handleDbSessionStatsRequest(res: ServerResponse): void {
    const db = getDB();
    const stats = db.getSessionStats();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats, null, 2));
  }

  // ============ Project management endpoints ============

  /**
   * Handle /api/projects endpoint - list projects or switch project
   */
  private async handleProjectsRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const projectManager = getProjectManager('gateway');

    if (req.method === 'GET') {
      // List all projects
      try {
        const projects = await projectManager.listProjects();
        const active = projectManager.getActiveProject();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          projects,
          activeProject: active ? {
            name: active.config.name,
            displayName: active.config.displayName,
            path: active.rootPath,
          } : null,
          projectsRoot: projectManager.getProjectsRoot(),
        }, null, 2));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
      }
      return;
    }

    if (req.method === 'POST') {
      // Switch to a project
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { name, clear } = JSON.parse(body);

          if (clear) {
            projectManager.clearActiveProject();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Cleared active project' }));
            return;
          }

          if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Project name required' }));
            return;
          }

          const project = await projectManager.setActiveProject(name);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            project: {
              name: project.config.name,
              displayName: project.config.displayName,
              path: project.rootPath,
              workingDir: project.workingDirPath,
            },
          }));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
        }
      });
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  /**
   * Handle /api/projects/active endpoint - get/set active project
   */
  private handleActiveProjectRequest(req: IncomingMessage, res: ServerResponse): void {
    const projectManager = getProjectManager('gateway');

    if (req.method === 'GET') {
      const active = projectManager.getActiveProject();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        active: active ? {
          name: active.config.name,
          displayName: active.config.displayName,
          description: active.config.description,
          path: active.rootPath,
          workingDir: active.workingDirPath,
          memoryDir: active.memoryDirPath,
          skillsDir: active.skillsDirPath,
          hasLocalIdentity: active.hasLocalIdentity,
          hasLocalSkills: active.hasLocalSkills,
        } : null,
        contextDir: projectManager.getContextDir(),
        workingDir: projectManager.getWorkingDir(),
      }, null, 2));
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  }

  /**
   * Handle /api/projects/config endpoint - get/update projects configuration
   */
  private handleProjectsConfigRequest(req: IncomingMessage, res: ServerResponse): void {
    const projectManager = getProjectManager('gateway');

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        projectsRoot: projectManager.getProjectsRoot(),
        globalContextDir: projectManager.getGlobalContextDir(),
        envVar: 'LOCALBOT_PROJECTS_DIR',
        help: 'Set LOCALBOT_PROJECTS_DIR in .env to change projects root directory',
      }, null, 2));
      return;
    }

    // Note: Changing the projects root at runtime would require restart
    // For now, just return the current config and how to change it
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Runtime config changes not supported',
      help: 'Set LOCALBOT_PROJECTS_DIR in .env and restart the gateway',
    }));
  }

  // ============ Memory endpoints ============

  /**
   * Handle /api/memory/status endpoint - get memory system status
   */
  private async handleMemoryStatusRequest(res: ServerResponse): Promise<void> {
    try {
      const memoryManager = await getMemoryManager();
      const memoryStatus = await memoryManager.getStatus();
      const files = await memoryManager.listFiles();

      const db = getDB();
      const syncStats = db.getMemorySyncStats();
      const lastSync = db.getLastSyncTime();

      // Get sync service stats if available
      let syncServiceStats = {};
      try {
        const syncService = getMemorySyncService();
        syncServiceStats = syncService.getStats();
      } catch {
        // Service might not be initialized
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        memory: {
          ...memoryStatus,
          files: files.slice(0, 20), // Last 20 files
        },
        sync: {
          ...syncStats,
          lastSync: lastSync?.toISOString() || null,
          service: syncServiceStats,
        },
      }, null, 2));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
    }
  }

  /**
   * Handle /api/memory/sync endpoint - trigger manual memory sync
   */
  private async handleMemorySyncRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
      return;
    }

    try {
      const syncService = getMemorySyncService();

      // Check if a specific session was requested
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          let result;

          if (body) {
            const { sessionId } = JSON.parse(body);
            if (sessionId) {
              // Sync specific session
              const summary = await syncService.syncSession(sessionId);
              result = {
                ok: true,
                mode: 'session',
                sessionId,
                summary: summary ? {
                  messageCount: summary.messageCount,
                  highlights: summary.highlights,
                } : null,
              };
            }
          }

          if (!result) {
            // Run full sync cycle
            const { synced, errors } = await syncService.runSync();
            result = {
              ok: true,
              mode: 'full',
              synced,
              errors,
            };
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result, null, 2));
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
        }
      });
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
    }
  }

  /**
   * Handle /api/memory/history endpoint - get memory sync history
   */
  private handleMemorySyncHistoryRequest(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const db = getDB();

    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const channel = url.searchParams.get('channel') as Channel | undefined;

    const history = db.getMemorySyncHistory({ channel, limit });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ history, count: history.length }, null, 2));
  }

  /**
   * Handle /api/events/types endpoint - get distinct event types for filtering
   */
  private handleEventTypesRequest(res: ServerResponse): void {
    // Return the list of event types that are actually used
    const db = getDB();
    const stats = db.getEventStats();

    const types = Object.keys(stats.byType).sort();
    const channels = Object.keys(stats.byChannel).sort();
    const levels = Object.keys(stats.byLevel).sort();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      eventTypes: types,
      channels,
      levels,
    }, null, 2));
  }

  // ============ Workspace endpoints ============

  /**
   * Handle /api/workspace endpoint - get workspace files (SOUL, MEMORY, etc.)
   */
  private async handleWorkspaceRequest(res: ServerResponse): Promise<void> {
    try {
      const workspaceDir = getAgentDir();
      const context = await loadWorkspaceBootstrapFiles();
      const files = context.files.filter((f: WorkspaceFile) => !f.missing);

      // Format for dashboard display
      const formattedFiles = files.map((file: WorkspaceFile) => ({
        name: file.name,
        path: file.path,
        priority: file.priority,
        category: this.categorizeWorkspaceFile(file.name),
        contentPreview: file.content.slice(0, 500) + (file.content.length > 500 ? '...' : ''),
        contentLength: file.content.length,
        fullContent: file.content,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        workspaceDir,
        files: formattedFiles,
        count: formattedFiles.length,
      }, null, 2));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
    }
  }

  /**
   * Categorize workspace file by name
   */
  private categorizeWorkspaceFile(name: string): string {
    const upper = name.toUpperCase();
    if (upper.includes('SOUL') || upper.includes('IDENTITY')) return 'Identity';
    if (upper.includes('MEMORY')) return 'Memory';
    if (upper.includes('TOOL')) return 'Tools';
    if (upper.includes('USER')) return 'User';
    if (upper.includes('AGENT')) return 'Agent';
    if (upper.includes('HEARTBEAT')) return 'Heartbeat';
    if (upper.includes('BOOTSTRAP')) return 'Bootstrap';
    return 'Other';
  }

  // ============ Chat Service Methods ============

  /**
   * Initialize the chat agent (lazy initialization)
   */
  private async initializeChatAgent(): Promise<Agent> {
    if (this.chatAgent) {
      return this.chatAgent;
    }

    const ollamaHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const defaultModel = process.env.DEFAULT_MODEL || 'llama3.1:8b';

    // Create provider and registry
    const provider = new OllamaProvider({ host: ollamaHost });
    this.chatRegistry = new ToolRegistry();
    this.chatRegistry.registerAll(getAllBuiltInTools());

    // Load context and build system prompt
    const contextDir = getGlobalContextDir();
    const agentDir = getAgentDir();
    const context = await loadContext(contextDir, agentDir);
    const systemPrompt = buildSystemPrompt(context, this.chatRegistry.getSummary());

    // Create agent
    this.chatAgent = new Agent({
      provider,
      registry: this.chatRegistry,
      systemPrompt,
      defaultModel,
      maxTurns: 10,
    });

    console.log('[Chat] Agent initialized for web chat');
    return this.chatAgent;
  }

  /**
   * Create a new chat session
   */
  private async createChatSession(model?: string): Promise<WebChatSession> {
    await this.initializeChatAgent();

    const sessionId = uuid();
    const defaultModel = process.env.DEFAULT_MODEL || 'llama3.1:8b';

    const session: WebChatSession = {
      id: sessionId,
      messages: [],
      model: model || defaultModel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.chatSessions.set(sessionId, session);
    console.log(`[Chat] Created session: ${sessionId}`);

    return session;
  }

  /**
   * Load an existing chat session
   */
  private async loadChatSession(sessionId: string): Promise<WebChatSession> {
    // First check in-memory sessions
    let session = this.chatSessions.get(sessionId);
    if (session) {
      return session;
    }

    // Try to load from database
    const db = getDB();
    const dbSession = db.getSessionWithMessages(sessionId);

    if (!dbSession) {
      throw new Error('Session not found');
    }

    // Convert DB messages to chat messages
    const messages: Message[] = dbSession.messages.map(m => {
      const msg: Message = {
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content,
      };
      if (m.toolCalls && Array.isArray(m.toolCalls)) {
        msg.tool_calls = m.toolCalls as ToolCall[];
      }
      return msg;
    });

    session = {
      id: sessionId,
      messages,
      model: dbSession.model || process.env.DEFAULT_MODEL || 'llama3.1:8b',
      createdAt: dbSession.createdAt.getTime(),
      updatedAt: dbSession.updatedAt.getTime(),
    };

    this.chatSessions.set(sessionId, session);
    return session;
  }

  /**
   * Handle chat.send - process message and stream response
   */
  private async handleChatSend(
    req: WsRequest,
    params: { sessionId: string; content: string }
  ): Promise<void> {
    const { sessionId, content } = params;

    try {
      const session = this.chatSessions.get(sessionId);
      if (!session) {
        this.broadcast('chat.error', { error: 'Session not found' });
        return;
      }

      const agent = await this.initializeChatAgent();

      // Add user message to session
      session.messages.push({ role: 'user', content });
      session.updatedAt = Date.now();

      // Stream the response using runStream
      let fullContent = '';
      const toolCalls: unknown[] = [];

      try {
        for await (const event of agent.runStream(content, sessionId, 'web-user')) {
          switch (event.type) {
            case 'content':
              if (event.content) {
                fullContent += event.content;
                this.broadcast('chat.chunk', { content: event.content });
              }
              break;

            case 'tool_start':
              if (event.toolCall) {
                this.broadcast('chat.tool', {
                  name: event.toolCall.function?.name,
                  status: 'started',
                });
              }
              break;

            case 'tool_end':
              if (event.toolCall && event.toolResult) {
                toolCalls.push(event.toolCall);
                this.broadcast('chat.tool', {
                  name: event.toolCall.function?.name,
                  result: event.toolResult,
                  status: 'completed',
                });
              }
              break;

            case 'error':
              this.broadcast('chat.error', { error: event.error });
              return;

            case 'done':
              // Add assistant message to session
              const assistantMsg: Message = {
                role: 'assistant',
                content: fullContent,
              };
              session.messages.push(assistantMsg);
              session.updatedAt = Date.now();

              this.broadcast('chat.done', {
                content: fullContent,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
              });
              break;
          }
        }
      } catch (streamError) {
        console.error('[Chat] Stream error:', streamError);
        this.broadcast('chat.error', {
          error: streamError instanceof Error ? streamError.message : 'Stream failed',
        });
      }
    } catch (error) {
      console.error('[Chat] Error processing message:', error);
      this.broadcast('chat.error', {
        error: error instanceof Error ? error.message : 'Failed to process message',
      });
    }
  }
}
