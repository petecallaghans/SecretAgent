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

export async function webSearch(query: string): Promise<string> {
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
