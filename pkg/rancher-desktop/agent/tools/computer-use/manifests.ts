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
    description:             'Anthropic native computer use tool — visual screenshot-based interaction with coordinate clicking, typing, scrolling, and dragging. The model sees the page as a screenshot and interacts with pixel coordinates.',
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
