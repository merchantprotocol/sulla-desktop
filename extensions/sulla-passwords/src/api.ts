export type VaultConfig = { baseUrl: string; email?: string };
const defaultConfig: VaultConfig = { baseUrl: 'http://127.0.0.1:30125' };
export async function getConfig(): Promise<VaultConfig> { const stored = await chrome.storage.session.get(['vaultConfig']); return { ...defaultConfig, ...(stored.vaultConfig ?? {}) }; }
export async function setConfig(config: VaultConfig): Promise<void> { await chrome.storage.session.set({ vaultConfig: config }); }
export async function request(path: string, init: RequestInit = {}): Promise<any> {
  const config = await getConfig(); const session = await chrome.storage.session.get(['vaultToken']); const headers = new Headers(init.headers); headers.set('content-type', 'application/json');
  if (session.vaultToken) headers.set('authorization', `Bearer ${session.vaultToken}`);
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers });
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `Vault request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
