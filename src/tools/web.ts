import type { Config } from '../types.js';

const MAX_CONTENT = 15_000;

export async function fetchUrl(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SecretAgent/1.0' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return `Error: HTTP ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (contentType.includes('text/html')) {
      return htmlToText(text).slice(0, MAX_CONTENT);
    }
    return text.slice(0, MAX_CONTENT);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching URL: ${msg}`;
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Web search with three strategies, best available first:
 *   1. Brave Search API (real results, needs BRAVE_API_KEY)
 *   2. DuckDuckGo HTML endpoint scrape (real results, no key)
 *   3. DuckDuckGo Instant Answer API (abstracts only — last resort)
 */
export async function webSearch(query: string, config?: Config): Promise<string> {
  if (config?.braveApiKey) {
    const brave = await braveSearch(query, config.braveApiKey);
    if (brave) return brave;
  }
  const ddg = await ddgHtmlSearch(query);
  if (ddg) return ddg;
  return ddgInstantAnswer(query);
}

async function braveSearch(query: string, apiKey: string): Promise<string | null> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    const response = await fetch(url, {
      headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    const results = data.web?.results || [];
    if (results.length === 0) return null;
    return results.slice(0, 5).map(r =>
      `${r.title || '(untitled)'}\n${r.url || ''}\n${htmlToText(r.description || '')}`
    ).join('\n\n');
  } catch {
    return null;
  }
}

async function ddgHtmlSearch(query: string): Promise<string | null> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SecretAgent/1.0)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const html = await response.text();

    const results: string[] = [];
    // Each result: <a class="result__a" href="...">Title</a> ... <a class="result__snippet" ...>Snippet</a>
    const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    const links: Array<{ url: string; title: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null && links.length < 5) {
      links.push({ url: decodeDdgUrl(m[1]), title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim() });
    }
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) !== null && snippets.length < 5) {
      snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, '')).trim());
    }
    for (let i = 0; i < links.length; i++) {
      results.push(`${links[i].title}\n${links[i].url}\n${snippets[i] || ''}`.trim());
    }
    return results.length > 0 ? results.join('\n\n') : null;
  } catch {
    return null;
  }
}

/** DDG HTML links are often redirect URLs like //duckduckgo.com/l/?uddg=<encoded>. */
function decodeDdgUrl(href: string): string {
  const match = href.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { /* fall through */ }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

async function ddgInstantAnswer(query: string): Promise<string> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'SecretAgent/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json() as Record<string, unknown>;

    const results: string[] = [];
    if (data.Abstract) results.push(`Summary: ${data.Abstract}`);
    if (data.Answer) results.push(`Answer: ${data.Answer}`);
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 5)) {
        if (topic && typeof topic === 'object' && 'Text' in topic) {
          results.push(`- ${(topic as { Text: string }).Text}`);
        }
      }
    }

    return results.length > 0 ? results.join('\n') : 'No results found.';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error searching: ${msg}`;
  }
}
