// SPDX-License-Identifier: GPL-2.0-or-later

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { transformWithEsbuild, type Plugin } from 'vite';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(root, '../../pkg/sulla-desktop');
const entry = path.join(renderer, 'entry/chat-preview');

/** Small preview-only SFC transformer matching the agent Vitest compiler. */
class PreviewVueSfcPlugin implements Plugin {
  readonly name = 'sulla-chat-preview-vue-sfc';
  readonly enforce = 'pre' as const;

  async transform(source: string, id: string) {
    if (!id.endsWith('.vue')) return null;
    const { descriptor, errors } = parse(source, { filename: id });
    if (errors.length) throw errors[0];
    const scopeId = `data-v-${Buffer.from(id).toString('hex').slice(-8)}`;
    if (!descriptor.script && !descriptor.scriptSetup) {
      const template = compileTemplate({ source: descriptor.template?.content ?? '', filename: id, id: scopeId });
      if (template.errors.length) throw template.errors[0];
      return transformWithEsbuild(template.code, id, { loader: 'js' });
    }
    const compiled = compileScript(descriptor, { id: scopeId, inlineTemplate: true });
    return transformWithEsbuild(compiled.content, id, { loader: compiled.lang === 'ts' ? 'ts' : 'js' });
  }
}

export default defineConfig({
  root: renderer,
  plugins: [new PreviewVueSfcPlugin()],
  resolve: {
    alias: [
      { find: /^@pkg\/(.*)$/, replacement: `${renderer}/$1` },
      { find: 'electron', replacement: path.join(entry, 'electron.ts') },
      { find: 'electron$', replacement: path.join(entry, 'electron.ts') },
      { find: '@pkg/utils/ipcRenderer', replacement: path.join(entry, 'electron.ts') },
      { find: '@pkg/agent/database/models/SullaSettingsModel', replacement: path.join(entry, 'SullaSettingsModel.ts') },
      { find: '../../agent/ChatInterface', replacement: path.join(entry, 'ChatInterface.ts') },
      { find: '@pkg/agent/services/WebSocketClientService', replacement: path.join(entry, 'WebSocketClientService.ts') },
    ],
    extensions: ['.ts', '.js', '.vue'],
  },
  server: {
    host: process.env.CHAT_PREVIEW_HOST || '127.0.0.1',
    port: Number(process.env.CHAT_PREVIEW_PORT || 8888),
    strictPort: false,
    headers: { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'" },
  },
  define: {
    'process.client': 'true',
    'process.env.SULLA_TEST': JSON.stringify('chat-preview'),
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
});
