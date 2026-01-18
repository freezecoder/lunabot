/**
 * Document Tools - Read, parse, and process various document formats
 * Supports PDF, Markdown, HTML, JSON, YAML, CSV, and more
 */

import { readFile, stat } from 'fs/promises';
import { extname, basename } from 'path';
import { spawn } from 'child_process';
import { defineTool } from '../registry.js';

const MAX_CONTENT_LENGTH = 50000;

/**
 * Detect document type from extension
 */
function getDocType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.pdf': 'pdf',
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.html': 'html',
    '.htm': 'html',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.csv': 'csv',
    '.tsv': 'tsv',
    '.txt': 'text',
    '.log': 'text',
    '.xml': 'xml',
    '.doc': 'doc',
    '.docx': 'docx',
  };
  return types[ext] || 'text';
}

/**
 * Extract text from PDF using pdftotext (poppler)
 */
async function extractPdfText(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('pdftotext', ['-layout', filePath, '-'], {
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(`[PDF extraction failed: ${stderr || 'pdftotext not found'}]`);
        return;
      }
      resolve(stdout.trim());
    });

    proc.on('error', () => {
      resolve('[PDF extraction requires pdftotext: brew install poppler]');
    });
  });
}

/**
 * Extract text from docx using pandoc
 */
async function extractDocxText(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('pandoc', ['-t', 'plain', filePath], {
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(`[DOCX extraction failed: ${stderr || 'pandoc not found'}]`);
        return;
      }
      resolve(stdout.trim());
    });

    proc.on('error', () => {
      resolve('[DOCX extraction requires pandoc: brew install pandoc]');
    });
  });
}

/**
 * Strip HTML tags
 */
function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse CSV to readable format
 */
function parseCsv(content: string, delimiter = ','): string {
  const lines = content.trim().split('\n');
  if (lines.length === 0) return content;

  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1, 21); // First 20 rows

  let result = `Columns: ${headers.join(', ')}\n`;
  result += `Total rows: ~${lines.length - 1}\n\n`;

  for (let i = 0; i < rows.length; i++) {
    const values = rows[i].split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
    result += `Row ${i + 1}:\n`;
    headers.forEach((h, j) => {
      if (values[j]) result += `  ${h}: ${values[j]}\n`;
    });
    result += '\n';
  }

  if (lines.length > 21) {
    result += `... and ${lines.length - 21} more rows`;
  }

  return result;
}

// ============ Document Read Tool ============

export const readDocumentTool = defineTool({
  name: 'read_document',
  description: `Read and extract text from various document formats.

Supported formats:
- PDF (.pdf) - requires pdftotext (brew install poppler)
- Word (.docx) - requires pandoc
- Markdown (.md)
- HTML (.html)
- JSON (.json) - formatted output
- YAML (.yaml, .yml)
- CSV/TSV (.csv, .tsv) - parsed with headers
- Plain text (.txt, .log)

Returns extracted text content, ready for analysis or summarization.`,

  parameters: {
    path: {
      type: 'string',
      description: 'Path to the document file',
      isRequired: true,
    },
    max_length: {
      type: 'number',
      description: `Maximum characters to return (default: ${MAX_CONTENT_LENGTH})`,
    },
  },
  timeout: 60000,

  async execute(args): Promise<string> {
    const path = args.path as string;
    const maxLength = (args.max_length as number) || MAX_CONTENT_LENGTH;

    try {
      const stats = await stat(path);
      const docType = getDocType(path);
      const fileName = basename(path);

      let content: string;

      switch (docType) {
        case 'pdf':
          content = await extractPdfText(path);
          break;

        case 'docx':
        case 'doc':
          content = await extractDocxText(path);
          break;

        case 'html':
          const htmlRaw = await readFile(path, 'utf-8');
          content = stripHtml(htmlRaw);
          break;

        case 'json':
          const jsonRaw = await readFile(path, 'utf-8');
          try {
            const parsed = JSON.parse(jsonRaw);
            content = JSON.stringify(parsed, null, 2);
          } catch {
            content = jsonRaw;
          }
          break;

        case 'csv':
          const csvRaw = await readFile(path, 'utf-8');
          content = parseCsv(csvRaw, ',');
          break;

        case 'tsv':
          const tsvRaw = await readFile(path, 'utf-8');
          content = parseCsv(tsvRaw, '\t');
          break;

        default:
          content = await readFile(path, 'utf-8');
      }

      // Build result
      let result = `📄 ${fileName} (${docType}, ${formatSize(stats.size)})\n`;
      result += '─'.repeat(50) + '\n\n';

      if (content.length > maxLength) {
        result += content.slice(0, maxLength);
        result += `\n\n... [truncated, ${content.length - maxLength} more characters]`;
      } else {
        result += content;
      }

      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return `Error: File not found: ${path}`;
      }
      return `Error reading document: ${error instanceof Error ? error.message : error}`;
    }
  },
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ============ URL Document Tool ============

export const fetchDocumentTool = defineTool({
  name: 'fetch_document',
  description: `Fetch and extract content from a URL. Handles various content types.

Good for:
- Web pages (extracts main text)
- API responses (parses JSON)
- Documentation
- Online PDFs (if direct link)`,

  parameters: {
    url: {
      type: 'string',
      description: 'URL to fetch',
      isRequired: true,
    },
    extract_text: {
      type: 'boolean',
      description: 'Extract text from HTML (default: true)',
    },
  },
  timeout: 60000,

  async execute(args): Promise<string> {
    const url = args.url as string;
    const extractText = args.extract_text !== false;

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'LocalBot/1.0 (Document Fetcher)',
          'Accept': 'text/html,application/json,application/xml,text/plain,*/*',
        },
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        return `HTTP Error: ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') || '';
      const content = await response.text();

      let result = `📄 ${url}\n`;
      result += `Content-Type: ${contentType}\n`;
      result += '─'.repeat(50) + '\n\n';

      // Handle different content types
      if (contentType.includes('application/json')) {
        try {
          const parsed = JSON.parse(content);
          result += JSON.stringify(parsed, null, 2);
        } catch {
          result += content;
        }
      } else if (contentType.includes('text/html') && extractText) {
        result += stripHtml(content);
      } else {
        result += content;
      }

      // Truncate if needed
      if (result.length > MAX_CONTENT_LENGTH) {
        result = result.slice(0, MAX_CONTENT_LENGTH) + '\n\n... [truncated]';
      }

      return result;
    } catch (error) {
      return `Fetch Error: ${error instanceof Error ? error.message : error}`;
    }
  },
});

// ============ Summarize Instructions Tool ============

export const summarizeInstructionsTool = defineTool({
  name: 'prepare_summary',
  description: `Prepare a document for summarization by extracting key sections.

This tool extracts structure (headings, lists, key paragraphs) from a document
to help create better summaries. Use this before asking the model to summarize.`,

  parameters: {
    content: {
      type: 'string',
      description: 'Document content to prepare',
      isRequired: true,
    },
    focus: {
      type: 'string',
      description: 'What to focus on: "key_points", "action_items", "structure", "all"',
    },
  },
  timeout: 10000,

  async execute(args): Promise<string> {
    const content = args.content as string;
    const focus = (args.focus as string) || 'all';

    const lines = content.split('\n');
    const result: string[] = [];

    // Extract headings (markdown style)
    const headings = lines.filter(l => l.match(/^#{1,6}\s/));
    if (headings.length > 0 && (focus === 'all' || focus === 'structure')) {
      result.push('## Document Structure:');
      headings.forEach(h => result.push(h));
      result.push('');
    }

    // Extract bullet points / lists
    const bullets = lines.filter(l => l.match(/^\s*[-*•]\s/));
    if (bullets.length > 0 && (focus === 'all' || focus === 'key_points')) {
      result.push('## Key Points:');
      bullets.slice(0, 20).forEach(b => result.push(b));
      if (bullets.length > 20) result.push(`... and ${bullets.length - 20} more`);
      result.push('');
    }

    // Extract numbered items (potential action items)
    const numbered = lines.filter(l => l.match(/^\s*\d+[.)]\s/));
    if (numbered.length > 0 && (focus === 'all' || focus === 'action_items')) {
      result.push('## Numbered Items:');
      numbered.slice(0, 15).forEach(n => result.push(n));
      result.push('');
    }

    // Extract first paragraph (usually important)
    const firstPara = lines.find(l => l.trim().length > 100);
    if (firstPara && focus === 'all') {
      result.push('## Opening:');
      result.push(firstPara.slice(0, 500));
      result.push('');
    }

    // Stats
    result.push('## Document Stats:');
    result.push(`- Total lines: ${lines.length}`);
    result.push(`- Total characters: ${content.length}`);
    result.push(`- Headings: ${headings.length}`);
    result.push(`- Bullet points: ${bullets.length}`);

    return result.join('\n');
  },
});

// ============ All document tools ============

export const documentTools = [
  readDocumentTool,
  fetchDocumentTool,
  summarizeInstructionsTool,
];
