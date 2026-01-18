/**
 * Response Parser - Extract tool calls from various model output formats
 *
 * Some models output tool calls as proper structured objects, while others
 * embed them as JSON in the text response. This parser handles both.
 */

import type { ToolCall, ToolSchema } from '../types.js';

export interface ParsedResponse {
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
}

/**
 * Parse a model response and extract tool calls
 */
export function parseResponse(content: string, availableTools?: ToolSchema[]): ParsedResponse {
  // Try to extract tool calls from JSON in the response
  const { toolCalls, cleanContent, reasoning } = extractToolCalls(content, availableTools);

  return {
    content: cleanContent,
    toolCalls,
    reasoning,
  };
}

/**
 * Extract tool calls from text content
 */
function extractToolCalls(
  content: string,
  availableTools?: ToolSchema[]
): { toolCalls: ToolCall[]; cleanContent: string; reasoning?: string } {
  const toolCalls: ToolCall[] = [];
  let cleanContent = content;
  let reasoning: string | undefined;

  // Extract thinking/reasoning blocks (common in DeepSeek-R1)
  const thinkingMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkingMatch) {
    reasoning = thinkingMatch[1].trim();
    cleanContent = cleanContent.replace(thinkingMatch[0], '').trim();
  }

  // Pattern 1: JSON object with tool_calls array
  const toolCallsArrayPattern = /\{[\s\S]*?"tool_calls"\s*:\s*\[([\s\S]*?)\][\s\S]*?\}/;
  const arrayMatch = content.match(toolCallsArrayPattern);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          const normalized = normalizeToolCall(tc);
          if (normalized) {
            toolCalls.push(normalized);
          }
        }
        cleanContent = cleanContent.replace(arrayMatch[0], '').trim();
      }
    } catch {
      // Failed to parse, continue with other patterns
    }
  }

  // Pattern 2: Function call syntax (OpenAI-style)
  // {"name": "tool_name", "arguments": {...}}
  const functionCallPattern = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/g;
  let funcMatch;
  while ((funcMatch = functionCallPattern.exec(content)) !== null) {
    const name = funcMatch[1];
    const argsStr = funcMatch[2];

    // Validate tool exists if we have the list
    if (availableTools && !availableTools.some(t => t.function.name === name)) {
      continue;
    }

    try {
      JSON.parse(argsStr); // Validate JSON
      toolCalls.push({
        id: generateToolCallId(),
        type: 'function',
        function: { name, arguments: argsStr },
      });
      cleanContent = cleanContent.replace(funcMatch[0], '').trim();
    } catch {
      // Invalid JSON in arguments
    }
  }

  // Pattern 3: Code block with tool call JSON
  const codeBlockPattern = /```(?:json)?\s*(\{[\s\S]*?"(?:name|function|tool)"\s*:[\s\S]*?\})\s*```/g;
  let codeMatch;
  while ((codeMatch = codeBlockPattern.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(codeMatch[1]);
      const tc = normalizeToolCall(parsed);
      if (tc && (!availableTools || availableTools.some(t => t.function.name === tc.function.name))) {
        toolCalls.push(tc);
        cleanContent = cleanContent.replace(codeMatch[0], '').trim();
      }
    } catch {
      // Failed to parse code block
    }
  }

  // Pattern 4: Tool use XML-style (Anthropic format)
  const xmlToolPattern = /<tool_use>([\s\S]*?)<\/tool_use>/g;
  let xmlMatch;
  while ((xmlMatch = xmlToolPattern.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(xmlMatch[1]);
      const tc = normalizeToolCall(parsed);
      if (tc) {
        toolCalls.push(tc);
        cleanContent = cleanContent.replace(xmlMatch[0], '').trim();
      }
    } catch {
      // Failed to parse XML tool block
    }
  }

  // Pattern 5: Simple function call format
  // tool_name({"arg": "value"})
  const simpleFuncPattern = /([a-z_][a-z0-9_]*)\s*\(\s*(\{[^)]*\})\s*\)/gi;
  let simpleMatch;
  while ((simpleMatch = simpleFuncPattern.exec(content)) !== null) {
    const name = simpleMatch[1];
    const argsStr = simpleMatch[2];

    // Only match if it looks like a known tool
    if (availableTools && !availableTools.some(t => t.function.name === name)) {
      continue;
    }

    try {
      JSON.parse(argsStr);
      toolCalls.push({
        id: generateToolCallId(),
        type: 'function',
        function: { name, arguments: argsStr },
      });
      // Don't remove from clean content - might be part of explanation
    } catch {
      // Invalid JSON
    }
  }

  // Clean up extra whitespace
  cleanContent = cleanContent.replace(/\n{3,}/g, '\n\n').trim();

  return { toolCalls, cleanContent, reasoning };
}

/**
 * Normalize various tool call formats to our standard format
 */
function normalizeToolCall(obj: unknown): ToolCall | null {
  if (!obj || typeof obj !== 'object') return null;

  const o = obj as Record<string, unknown>;

  // Already in correct format
  if (o.type === 'function' && o.function) {
    const func = o.function as Record<string, unknown>;
    return {
      id: (o.id as string) || generateToolCallId(),
      type: 'function',
      function: {
        name: func.name as string,
        arguments: typeof func.arguments === 'string'
          ? func.arguments
          : JSON.stringify(func.arguments || {}),
      },
    };
  }

  // Simple format: {name, arguments}
  if (o.name && typeof o.name === 'string') {
    return {
      id: generateToolCallId(),
      type: 'function',
      function: {
        name: o.name,
        arguments: typeof o.arguments === 'string'
          ? o.arguments
          : JSON.stringify(o.arguments || {}),
      },
    };
  }

  // Tool format: {tool, input}
  if (o.tool && typeof o.tool === 'string') {
    return {
      id: generateToolCallId(),
      type: 'function',
      function: {
        name: o.tool,
        arguments: typeof o.input === 'string'
          ? o.input
          : JSON.stringify(o.input || {}),
      },
    };
  }

  return null;
}

/**
 * Generate a unique tool call ID
 */
function generateToolCallId(): string {
  return `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Validate tool call arguments against schema
 */
export function validateToolCall(
  toolCall: ToolCall,
  schema: ToolSchema
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check tool name matches
  if (toolCall.function.name !== schema.function.name) {
    errors.push(`Tool name mismatch: ${toolCall.function.name} vs ${schema.function.name}`);
    return { valid: false, errors };
  }

  // Parse and validate arguments
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    errors.push('Invalid JSON in arguments');
    return { valid: false, errors };
  }

  // Check required parameters
  const required = schema.function.parameters.required || [];
  for (const param of required) {
    if (!(param in args)) {
      errors.push(`Missing required parameter: ${param}`);
    }
  }

  // Check parameter types (basic validation)
  for (const [key, value] of Object.entries(args)) {
    const paramSchema = schema.function.parameters.properties[key];
    if (!paramSchema) {
      // Unknown parameter - could warn but allow
      continue;
    }

    const expectedType = paramSchema.type;
    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (expectedType === 'integer' || expectedType === 'number') {
      if (typeof value !== 'number') {
        errors.push(`Parameter ${key}: expected number, got ${actualType}`);
      }
    } else if (expectedType !== actualType && expectedType !== 'any') {
      errors.push(`Parameter ${key}: expected ${expectedType}, got ${actualType}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Try to fix malformed JSON in tool arguments
 */
export function tryFixJson(jsonStr: string): string | null {
  // Already valid
  try {
    JSON.parse(jsonStr);
    return jsonStr;
  } catch {
    // Continue with fixes
  }

  let fixed = jsonStr;

  // Fix single quotes to double quotes
  fixed = fixed.replace(/'/g, '"');

  // Fix unquoted keys
  fixed = fixed.replace(/(\{|,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');

  // Fix trailing commas
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // Fix missing quotes around string values
  fixed = fixed.replace(/:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*([,}])/g, ':"$1"$2');

  try {
    JSON.parse(fixed);
    return fixed;
  } catch {
    return null;
  }
}
