export async function fetchJson(url: string, init: RequestInit = {}, maxBytes = 1024 * 1024): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
    headers: { accept: 'application/json', ...init.headers },
  });
  if (!response.ok) throw new Error(`upstream request failed (${response.status})`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('upstream response is too large');
  if (!response.body) throw new Error('upstream response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('upstream response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
  return value as Record<string, unknown>;
}

export function string(value: unknown, name: string, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${name} is invalid`);
  return value;
}

export function stringArray(value: unknown, name: string, maxItems = 50): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || !item || item.length > 120)) {
    throw new Error(`${name} is invalid`);
  }
  return [...new Set(value as string[])];
}