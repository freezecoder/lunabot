/**
 * Browser automation tool using Playwright
 */

import { defineTool } from '../registry.js';
import type { Browser, Page, BrowserContext } from 'playwright';

// Lazy load playwright to avoid startup cost
let playwright: typeof import('playwright') | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

async function getPlaywright() {
  if (!playwright) {
    playwright = await import('playwright');
  }
  return playwright;
}

async function ensureBrowser(): Promise<Page> {
  const pw = await getPlaywright();

  if (!browser || !browser.isConnected()) {
    browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  if (!context) {
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
  }

  if (!page || page.isClosed()) {
    page = await context.newPage();
  }

  return page;
}

/**
 * Browser tool - comprehensive browser automation
 */
export const browserTool = defineTool({
  name: 'browser',
  description: `Browser automation tool for web interaction. Supports navigation, clicking, typing, screenshots, and content extraction.

Actions:
- navigate: Go to a URL
- click: Click an element (by selector or text)
- type: Type text into an element
- screenshot: Take a screenshot
- content: Get page text content
- html: Get page HTML
- evaluate: Run JavaScript on the page
- close: Close the browser session`,

  parameters: {
    action: {
      type: 'string',
      description: 'The action to perform: navigate, click, type, screenshot, content, html, evaluate, close',
      isRequired: true,
      enum: ['navigate', 'click', 'type', 'screenshot', 'content', 'html', 'evaluate', 'close'],
    },
    url: {
      type: 'string',
      description: 'URL to navigate to (for navigate action)',
    },
    selector: {
      type: 'string',
      description: 'CSS selector or text to find element (for click/type actions). Use text:// prefix for text-based selection.',
    },
    text: {
      type: 'string',
      description: 'Text to type (for type action)',
    },
    script: {
      type: 'string',
      description: 'JavaScript to evaluate on the page (for evaluate action)',
    },
    wait_for: {
      type: 'string',
      description: 'Wait for selector/state before action. Can be a CSS selector or "load"/"networkidle".',
    },
    timeout: {
      type: 'number',
      description: 'Timeout in milliseconds (default: 30000)',
    },
  },
  timeout: 120000, // 2 minutes max for browser operations

  async execute(args): Promise<string> {
    const action = args.action as string;
    const timeout = (args.timeout as number) || 30000;

    try {
      switch (action) {
        case 'navigate': {
          const url = args.url as string;
          if (!url) return 'Error: url is required for navigate action';

          const p = await ensureBrowser();
          await p.goto(url, { timeout, waitUntil: 'domcontentloaded' });

          const title = await p.title();
          const currentUrl = p.url();
          return `Navigated to: ${currentUrl}\nTitle: ${title}`;
        }

        case 'click': {
          const selector = args.selector as string;
          if (!selector) return 'Error: selector is required for click action';

          const p = await ensureBrowser();

          // Handle text-based selection
          if (selector.startsWith('text://')) {
            const text = selector.slice(7);
            await p.getByText(text).click({ timeout });
          } else {
            await p.click(selector, { timeout });
          }

          return `Clicked: ${selector}`;
        }

        case 'type': {
          const selector = args.selector as string;
          const text = args.text as string;
          if (!selector) return 'Error: selector is required for type action';
          if (!text) return 'Error: text is required for type action';

          const p = await ensureBrowser();

          if (selector.startsWith('text://')) {
            const labelText = selector.slice(7);
            await p.getByLabel(labelText).fill(text);
          } else {
            await p.fill(selector, text, { timeout });
          }

          return `Typed "${text}" into ${selector}`;
        }

        case 'screenshot': {
          const p = await ensureBrowser();
          const path = `/tmp/screenshot_${Date.now()}.png`;
          await p.screenshot({ path, fullPage: false });
          return `Screenshot saved to: ${path}`;
        }

        case 'content': {
          const p = await ensureBrowser();
          const waitFor = args.wait_for as string | undefined;

          if (waitFor) {
            if (waitFor === 'load' || waitFor === 'networkidle') {
              await p.waitForLoadState(waitFor, { timeout });
            } else {
              await p.waitForSelector(waitFor, { timeout });
            }
          }

          // Get text content, cleaned up
          const content = await p.evaluate(() => {
            // Remove scripts and styles
            const scripts = document.querySelectorAll('script, style, noscript');
            scripts.forEach(s => s.remove());

            // Get text content
            return document.body?.innerText || document.documentElement?.innerText || '';
          });

          const lines = content.split('\n').filter(l => l.trim()).slice(0, 100);
          return `Page content (${lines.length} lines):\n\n${lines.join('\n')}`;
        }

        case 'html': {
          const p = await ensureBrowser();
          const selector = args.selector as string;

          let html: string;
          if (selector) {
            html = await p.locator(selector).first().innerHTML();
          } else {
            html = await p.content();
          }

          // Truncate if too long
          if (html.length > 50000) {
            html = html.slice(0, 50000) + '\n\n[Truncated...]';
          }

          return html;
        }

        case 'evaluate': {
          const script = args.script as string;
          if (!script) return 'Error: script is required for evaluate action';

          const p = await ensureBrowser();
          const result = await p.evaluate((s) => {
            try {
              return eval(s);
            } catch (e) {
              return `Error: ${e}`;
            }
          }, script);

          return `Result: ${JSON.stringify(result, null, 2)}`;
        }

        case 'close': {
          if (page) {
            await page.close();
            page = null;
          }
          if (context) {
            await context.close();
            context = null;
          }
          if (browser) {
            await browser.close();
            browser = null;
          }
          return 'Browser session closed.';
        }

        default:
          return `Error: Unknown action "${action}". Valid actions: navigate, click, type, screenshot, content, html, evaluate, close`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Browser error: ${message}`;
    }
  },
});

/**
 * All browser tools
 */
export const browserTools = [browserTool];
