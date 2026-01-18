/**
 * API Tools - HTTP requests with intelligent JSON parsing and response handling
 */

import { defineTool } from '../registry.js';
import { spawn } from 'child_process';

/**
 * Smart JSON parser that handles various response formats
 */
function smartParse(text: string): { parsed: unknown; type: 'json' | 'xml' | 'text' } {
  const trimmed = text.trim();

  // Try JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { parsed: JSON.parse(trimmed), type: 'json' };
    } catch {
      // Not valid JSON, continue
    }
  }

  // Try XML
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<')) {
    return { parsed: trimmed, type: 'xml' };
  }

  // Plain text
  return { parsed: trimmed, type: 'text' };
}

/**
 * Format JSON for readable output
 */
function formatJson(data: unknown, maxDepth = 3, currentDepth = 0): string {
  if (currentDepth >= maxDepth) {
    return JSON.stringify(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    if (data.length > 10) {
      const preview = data.slice(0, 5).map(item => formatJson(item, maxDepth, currentDepth + 1));
      return `[\n  ${preview.join(',\n  ')}\n  ... and ${data.length - 5} more items\n]`;
    }
    return JSON.stringify(data, null, 2);
  }

  if (data && typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length > 20) {
      const preview = entries.slice(0, 10);
      const formatted = preview.map(([k, v]) => `  "${k}": ${formatJson(v, maxDepth, currentDepth + 1)}`);
      return `{\n${formatted.join(',\n')}\n  ... and ${entries.length - 10} more fields\n}`;
    }
  }

  return JSON.stringify(data, null, 2);
}

/**
 * Extract specific fields from JSON using dot notation path
 */
function extractPath(data: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // Handle array indexing: items[0]
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, key, index] = arrayMatch;
      current = (current as Record<string, unknown>)[key];
      if (Array.isArray(current)) {
        current = current[parseInt(index, 10)];
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

// ============ API Tool ============

export const apiRequestTool = defineTool({
  name: 'api_request',
  description: `Make HTTP API requests with intelligent response parsing.

Features:
- Automatic JSON/XML detection and parsing
- Header management
- Request body (JSON or form data)
- Response field extraction with dot notation
- Timeout handling

Use this for REST APIs, webhooks, and any HTTP endpoint.`,

  parameters: {
    url: {
      type: 'string',
      description: 'The URL to request',
      isRequired: true,
    },
    method: {
      type: 'string',
      description: 'HTTP method: GET, POST, PUT, PATCH, DELETE (default: GET)',
    },
    headers: {
      type: 'object',
      description: 'Request headers as key-value object (e.g., {"Authorization": "Bearer token"})',
    },
    body: {
      type: 'string',
      description: 'Request body (JSON string or form data)',
    },
    extract: {
      type: 'string',
      description: 'Dot-notation path to extract from response (e.g., "data.items[0].name")',
    },
    timeout: {
      type: 'number',
      description: 'Timeout in seconds (default: 30)',
    },
  },
  timeout: 60000,

  async execute(args): Promise<string> {
    const url = args.url as string;
    const method = ((args.method as string) || 'GET').toUpperCase();
    const headers = (args.headers as Record<string, string>) || {};
    const body = args.body as string | undefined;
    const extract = args.extract as string | undefined;
    const timeout = ((args.timeout as number) || 30) * 1000;

    try {
      // Build fetch options
      const options: RequestInit = {
        method,
        headers: {
          'User-Agent': 'LocalBot/1.0',
          ...headers,
        },
        signal: AbortSignal.timeout(timeout),
      };

      // Add body for non-GET requests
      if (body && method !== 'GET') {
        options.body = body;
        // Auto-detect content type
        if (!headers['Content-Type'] && !headers['content-type']) {
          try {
            JSON.parse(body);
            (options.headers as Record<string, string>)['Content-Type'] = 'application/json';
          } catch {
            // Not JSON, might be form data
          }
        }
      }

      const response = await fetch(url, options);
      const responseText = await response.text();

      // Build result
      let result = `${method} ${url}\nStatus: ${response.status} ${response.statusText}\n\n`;

      // Parse response
      const { parsed, type } = smartParse(responseText);

      if (type === 'json' && typeof parsed === 'object') {
        // Extract specific field if requested
        if (extract) {
          const extracted = extractPath(parsed, extract);
          if (extracted !== undefined) {
            result += `Extracted (${extract}):\n${formatJson(extracted)}`;
          } else {
            result += `Path "${extract}" not found in response.\n\nFull response:\n${formatJson(parsed)}`;
          }
        } else {
          result += formatJson(parsed);
        }
      } else {
        // Non-JSON response
        const preview = responseText.slice(0, 2000);
        result += preview;
        if (responseText.length > 2000) {
          result += `\n\n... [${responseText.length - 2000} more characters]`;
        }
      }

      return result;
    } catch (error) {
      return `API Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// ============ curl Tool ============

export const curlTool = defineTool({
  name: 'curl',
  description: `Execute curl commands for complex HTTP requests.

Use this when you need:
- Complex authentication (OAuth, digest, etc.)
- File uploads
- Following redirects
- Custom curl flags

For simple API calls, prefer api_request tool.`,

  parameters: {
    command: {
      type: 'string',
      description: 'The curl command arguments (without "curl" prefix). E.g., "-X POST -H \'Content-Type: application/json\' https://api.example.com"',
      isRequired: true,
    },
    parse_json: {
      type: 'boolean',
      description: 'Parse and format JSON response (default: true)',
    },
  },
  timeout: 60000,

  async execute(args): Promise<string> {
    const command = args.command as string;
    const parseJson = args.parse_json !== false;

    return new Promise((resolve) => {
      // Add common flags for better output
      const fullCommand = `-s -S ${command}`;

      const proc = spawn('curl', fullCommand.split(/\s+/), {
        timeout: 55000,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(`curl failed (exit ${code}): ${stderr || stdout}`);
          return;
        }

        if (parseJson) {
          const { parsed, type } = smartParse(stdout);
          if (type === 'json') {
            resolve(formatJson(parsed));
            return;
          }
        }

        resolve(stdout.trim());
      });

      proc.on('error', (error) => {
        resolve(`curl error: ${error.message}`);
      });
    });
  },
});

// ============ jq Tool ============

export const jqTool = defineTool({
  name: 'jq',
  description: `Process JSON with jq queries. Powerful for extracting and transforming data.

Examples:
- ".items[].name" - extract all names from items array
- ".data | keys" - get all keys
- ".users[] | select(.active)" - filter active users
- ".[] | {name, email}" - extract specific fields`,

  parameters: {
    json: {
      type: 'string',
      description: 'JSON string to process',
      isRequired: true,
    },
    query: {
      type: 'string',
      description: 'jq query/filter',
      isRequired: true,
    },
  },
  timeout: 10000,

  async execute(args): Promise<string> {
    const json = args.json as string;
    const query = args.query as string;

    return new Promise((resolve) => {
      const proc = spawn('jq', ['-r', query], {
        timeout: 9000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdin.write(json);
      proc.stdin.end();

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(`jq error: ${stderr || 'Invalid query or JSON'}`);
          return;
        }
        resolve(stdout.trim());
      });

      proc.on('error', (error) => {
        resolve(`jq error: ${error.message}`);
      });
    });
  },
});

// ============ GraphQL Tool ============

export const graphqlTool = defineTool({
  name: 'graphql',
  description: 'Execute GraphQL queries and mutations.',

  parameters: {
    endpoint: {
      type: 'string',
      description: 'GraphQL endpoint URL',
      isRequired: true,
    },
    query: {
      type: 'string',
      description: 'GraphQL query or mutation',
      isRequired: true,
    },
    variables: {
      type: 'object',
      description: 'Query variables as JSON object',
    },
    headers: {
      type: 'object',
      description: 'Request headers (e.g., for auth)',
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const endpoint = args.endpoint as string;
    const query = args.query as string;
    const variables = args.variables as Record<string, unknown> | undefined;
    const headers = (args.headers as Record<string, string>) || {};

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          query,
          variables,
        }),
        signal: AbortSignal.timeout(25000),
      });

      const data = await response.json();

      if (data.errors) {
        return `GraphQL Errors:\n${JSON.stringify(data.errors, null, 2)}`;
      }

      return formatJson(data.data || data);
    } catch (error) {
      return `GraphQL Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
});

// ============ All API tools ============

export const apiTools = [
  apiRequestTool,
  curlTool,
  jqTool,
  graphqlTool,
];
