/** Tool surfaces that directly operate macOS hardware, applications, or the
 *  VM supervisor. These must fail closed with the same Administrative Access
 *  gate as exechost. App-internal Desktop services (browser, settings, Files,
 *  etc.) are deliberately not host-machine execution. */
const HOST_ACCESS_CATEGORIES = new Set(['capture', 'lima', 'secretary']);

export function toolRequiresHostAccess(category: string, name: string): boolean {
  return HOST_ACCESS_CATEGORIES.has(category) || (category === 'applescript' && name === 'applescript_execute');
}
