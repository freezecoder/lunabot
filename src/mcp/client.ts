/**
 * MCP (Model Context Protocol) Client
 * Connects to MCP servers to access their tools and resources
 *
 * MCP servers can provide:
 * - Tools (functions the model can call)
 * - Resources (data the model can access)
 * - Prompts (pre-built prompt templates)
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { Tool, ToolSchema } from '../types.js';
import { defineTool } from '../tools/registry.js';

// ============ MCP Protocol Types ============

interface McpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// ============ MCP Server Connection ============

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class McpServer extends EventEmitter {
  readonly name: string;
  private config: McpServerConfig;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = '';
  private _tools: McpTool[] = [];
  private _resources: McpResource[] = [];
  private connected = false;

  constructor(config: McpServerConfig) {
    super();
    this.name = config.name;
    this.config = config;
  }

  /**
   * Start the MCP server process
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Server already started');
    }

    return new Promise((resolve, reject) => {
      const { command, args = [], env, cwd } = this.config;

      this.process = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout?.on('data', (data) => this.handleData(data));
      this.process.stderr?.on('data', (data) => {
        console.error(`[MCP ${this.name}] stderr:`, data.toString());
      });

      this.process.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.process.on('close', (code) => {
        this.connected = false;
        this.emit('close', code);
      });

      // Initialize connection
      this.initialize()
        .then(() => {
          this.connected = true;
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * Stop the MCP server
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.connected = false;
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.process !== null;
  }

  /**
   * Get available tools
   */
  get tools(): McpTool[] {
    return this._tools;
  }

  /**
   * Get available resources
   */
  get resources(): McpResource[] {
    return this._resources;
  }

  /**
   * Handle incoming data from server
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // Process complete JSON-RPC messages (newline-delimited)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as McpResponse;
        this.handleMessage(message);
      } catch (error) {
        console.error(`[MCP ${this.name}] Parse error:`, error);
      }
    }
  }

  /**
   * Handle a parsed message
   */
  private handleMessage(message: McpResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (pending) {
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  /**
   * Send a request to the server
   */
  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.process?.stdin) {
      throw new Error('Server not started');
    }

    const id = ++this.requestId;
    const request: McpRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 30000);

      this.process!.stdin!.write(JSON.stringify(request) + '\n', (error) => {
        if (error) {
          clearTimeout(timeoutId);
          this.pendingRequests.delete(id);
          reject(error);
        }
      });
    });
  }

  /**
   * Initialize the connection
   */
  private async initialize(): Promise<void> {
    // Send initialize request
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'LocalBot',
        version: '1.0.0',
      },
    });

    // List available tools
    try {
      const toolsResult = await this.request<{ tools: McpTool[] }>('tools/list');
      this._tools = toolsResult.tools || [];
    } catch {
      this._tools = [];
    }

    // List available resources
    try {
      const resourcesResult = await this.request<{ resources: McpResource[] }>('resources/list');
      this._resources = resourcesResult.resources || [];
    } catch {
      this._resources = [];
    }

    // Send initialized notification
    this.process?.stdin?.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }) + '\n');
  }

  /**
   * Call a tool on this server
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.request<{ content: Array<{ type: string; text?: string }> }>('tools/call', {
      name,
      arguments: args,
    });

    // Extract text content
    if (result.content) {
      const textContent = result.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text)
        .join('\n');
      return textContent || result;
    }

    return result;
  }

  /**
   * Read a resource
   */
  async readResource(uri: string): Promise<string> {
    const result = await this.request<{ contents: Array<{ uri: string; text?: string }> }>('resources/read', {
      uri,
    });

    if (result.contents?.[0]?.text) {
      return result.contents[0].text;
    }

    return JSON.stringify(result);
  }
}

// ============ MCP Manager ============

export class McpManager {
  private servers = new Map<string, McpServer>();

  /**
   * Add and start an MCP server
   */
  async addServer(config: McpServerConfig): Promise<McpServer> {
    if (this.servers.has(config.name)) {
      throw new Error(`Server ${config.name} already exists`);
    }

    const server = new McpServer(config);
    await server.start();
    this.servers.set(config.name, server);

    console.log(`[MCP] Connected to ${config.name}: ${server.tools.length} tools, ${server.resources.length} resources`);

    return server;
  }

  /**
   * Remove a server
   */
  removeServer(name: string): void {
    const server = this.servers.get(name);
    if (server) {
      server.stop();
      this.servers.delete(name);
    }
  }

  /**
   * Get a server by name
   */
  getServer(name: string): McpServer | undefined {
    return this.servers.get(name);
  }

  /**
   * Get all servers
   */
  getAllServers(): McpServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Convert all MCP tools to LocalBot tools
   */
  getTools(): Tool[] {
    const tools: Tool[] = [];

    for (const server of this.servers.values()) {
      for (const mcpTool of server.tools) {
        tools.push(this.convertTool(server, mcpTool));
      }
    }

    return tools;
  }

  /**
   * Convert an MCP tool to LocalBot tool
   */
  private convertTool(server: McpServer, mcpTool: McpTool): Tool {
    const serverName = server.name;
    const toolName = `mcp_${serverName}_${mcpTool.name}`;

    return {
      name: toolName,
      description: `[MCP:${serverName}] ${mcpTool.description || mcpTool.name}`,
      parameters: {
        type: 'object',
        properties: mcpTool.inputSchema?.properties as Record<string, { type: string; description?: string }> || {},
        required: mcpTool.inputSchema?.required,
      },
      timeout: 60000,

      async execute(args): Promise<string> {
        try {
          const result = await server.callTool(mcpTool.name, args);
          if (typeof result === 'string') {
            return result;
          }
          return JSON.stringify(result, null, 2);
        } catch (error) {
          return `MCP Error: ${error instanceof Error ? error.message : error}`;
        }
      },
    };
  }

  /**
   * Stop all servers
   */
  stopAll(): void {
    for (const server of this.servers.values()) {
      server.stop();
    }
    this.servers.clear();
  }
}

// ============ MCP Configuration ============

export interface McpConfig {
  servers: McpServerConfig[];
}

/**
 * Load MCP configuration from file
 */
export async function loadMcpConfig(configPath: string): Promise<McpConfig> {
  const { readFile } = await import('fs/promises');
  const { parse } = await import('yaml');

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = parse(content) as McpConfig;
    return config;
  } catch {
    return { servers: [] };
  }
}

// ============ MCP Tool for Dynamic Access ============

export const mcpCallTool = defineTool({
  name: 'mcp_call',
  description: `Call a tool on a connected MCP server directly.

Use this when you need to call an MCP server tool that isn't exposed as a built-in tool,
or when you need more control over the call.`,

  parameters: {
    server: {
      type: 'string',
      description: 'MCP server name',
      isRequired: true,
    },
    tool: {
      type: 'string',
      description: 'Tool name to call',
      isRequired: true,
    },
    args: {
      type: 'object',
      description: 'Arguments to pass to the tool',
    },
  },
  timeout: 60000,

  async execute(args): Promise<string> {
    // This needs to be wired up to the McpManager instance
    return 'MCP call requires manager context. Use specific mcp_* tools instead.';
  },
});

// Global MCP manager instance
export const mcpManager = new McpManager();
