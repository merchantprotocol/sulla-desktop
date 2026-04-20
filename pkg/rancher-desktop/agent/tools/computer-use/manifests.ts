import type { ToolManifest } from '../registry';

/**
 * Anthropic Computer Use tool manifest.
 *
 * This is NOT a regular function tool — it uses Anthropic's native
 * `computer_20250124` tool type. The `isAnthropicNative` flag signals
 * BaseNode to inject it in Anthropic's native format rather than
 * converting through convertToolToLLM().
 *
 * Only offered when the active LLM provider is Anthropic and
 * browser tabs are open.
 */
export const computerUseToolManifests: ToolManifest[] = [
  {
    name:                    'computer',
    description:             'Visual computer use — screenshot-based interaction with coordinate clicking, typing, scrolling, and dragging. Actions return a compact screenshot reference { assetId, path, width, height, bytes } pointing to a JPEG on disk — never inline base64. To inspect the screenshot visually, use the Read tool on the returned path; that loads the image into vision context without bloating the agent response.',
    category:                'computer-use',
    schemaDef:               {},
    operationTypes:          ['execute'],
    loader:                  () => import('./computer_tool'),
    isAnthropicNative:       true,
    anthropicToolDefinition: {
      type:              'computer_20250124',
      name:              'computer',
      display_width_px:  1280,
      display_height_px: 800,
    },
  },
];
