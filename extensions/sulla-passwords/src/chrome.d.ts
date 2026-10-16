declare namespace chrome {
  namespace storage { const session: { get(keys?: string[] | null): Promise<Record<string, any>>; set(values: Record<string, any>): Promise<void>; remove(keys: string | string[]): Promise<void> }; }
  namespace runtime { const onMessage: { addListener(listener: (message: any, sender: any, sendResponse: (response: any) => void) => void): void }; function sendMessage(message: any): Promise<any>; }
  namespace tabs { function query(query: any): Promise<any[]>; function sendMessage(tabId: number, message: any): Promise<any>; }
}
