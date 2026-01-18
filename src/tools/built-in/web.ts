/**
 * Web tools - search and fetch content from the web
 */

import { defineTool } from '../registry.js';

const USER_AGENT = 'LocalBot/1.0 (https://github.com/localbot)';

/**
 * Web fetch tool - retrieve content from a URL
 */
export const webFetchTool = defineTool({
  name: 'web_fetch',
  description: 'Fetch content from a URL and extract the main text content. Useful for reading web pages, documentation, or API responses.',
  parameters: {
    url: {
      type: 'string',
      description: 'The URL to fetch content from',
      isRequired: true,
    },
    extract_text: {
      type: 'boolean',
      description: 'If true (default), extract and clean text content. If false, return raw response.',
    },
    max_length: {
      type: 'number',
      description: 'Maximum characters to return (default: 50000)',
    },
  },
  timeout: 60000,

  async execute(args): Promise<string> {
    const url = args.url as string;
    const extractText = args.extract_text !== false;
    const maxLength = (args.max_length as number) || 50000;

    try {
      // Validate URL
      new URL(url);
    } catch {
      return `Error: Invalid URL: ${url}`;
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') || '';
      let content = await response.text();

      // For HTML, extract text content
      if (extractText && contentType.includes('text/html')) {
        content = extractTextFromHtml(content);
      }

      // Truncate if needed
      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + '\n\n[Content truncated...]';
      }

      return `Fetched ${url}:\n\n${content}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error fetching URL: ${message}`;
    }
  },
});

/**
 * Simple HTML text extraction
 */
function extractTextFromHtml(html: string): string {
  // Remove scripts and styles
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  html = html.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

  // Remove HTML comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // Convert common elements to text
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(/<\/p>/gi, '\n\n');
  html = html.replace(/<\/div>/gi, '\n');
  html = html.replace(/<\/li>/gi, '\n');
  html = html.replace(/<\/h[1-6]>/gi, '\n\n');

  // Remove all HTML tags
  html = html.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  html = html.replace(/&nbsp;/g, ' ');
  html = html.replace(/&amp;/g, '&');
  html = html.replace(/&lt;/g, '<');
  html = html.replace(/&gt;/g, '>');
  html = html.replace(/&quot;/g, '"');
  html = html.replace(/&#39;/g, "'");

  // Clean up whitespace
  html = html.replace(/\t/g, ' ');
  html = html.replace(/ +/g, ' ');
  html = html.replace(/\n +/g, '\n');
  html = html.replace(/ +\n/g, '\n');
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

/**
 * Web search tool using DuckDuckGo
 */
export const webSearchTool = defineTool({
  name: 'web_search',
  description: 'Search the web for current/recent information. ONLY use when user explicitly asks to search the web, or needs real-time data (news, prices, weather, events). Do NOT use for general questions you can answer yourself.',
  parameters: {
    query: {
      type: 'string',
      description: 'The search query',
      isRequired: true,
    },
    max_results: {
      type: 'number',
      description: 'Maximum number of results to return (default: 5, max: 10)',
    },
  },
  timeout: 30000,

  async execute(args): Promise<string> {
    const query = args.query as string;
    const maxResults = Math.min((args.max_results as number) || 5, 10);

    try {
      // Use DuckDuckGo HTML search (no API key needed)
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': USER_AGENT,
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return `Error: Search failed with status ${response.status}`;
      }

      const html = await response.text();
      const results = parseDuckDuckGoResults(html, maxResults);

      if (results.length === 0) {
        return `No results found for: ${query}`;
      }

      let output = `Search results for "${query}":\n\n`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        output += `${i + 1}. ${r.title}\n`;
        output += `   URL: ${r.url}\n`;
        if (r.snippet) {
          output += `   ${r.snippet}\n`;
        }
        output += '\n';
      }

      return output.trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Error performing search: ${message}`;
    }
  },
});

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Parse DuckDuckGo HTML results
  // Look for result links with class "result__a"
  const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/gi;

  // Also try the simpler pattern for result blocks
  const blockRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>[\s\S]*?<\/div>/gi;

  let match;
  let snippetMatch;

  // First try direct regex
  while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
    let url = match[1];
    const title = match[2].trim();

    // DuckDuckGo uses redirect URLs, try to extract actual URL
    if (url.includes('uddg=')) {
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }
    }

    if (title && url && !url.includes('duckduckgo.com')) {
      // Try to get snippet
      snippetMatch = snippetRegex.exec(html);
      const snippet = snippetMatch ? decodeHtmlEntities(snippetMatch[1].trim()) : undefined;

      results.push({
        title: decodeHtmlEntities(title),
        url,
        snippet,
      });
    }
  }

  return results;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * All web tools
 */
export const webTools = [webFetchTool, webSearchTool];
