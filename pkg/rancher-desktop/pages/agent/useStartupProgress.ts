import { StartupProgressController } from './StartupProgressController';

let _state: ReturnType<typeof StartupProgressController.createState> | null = null;
let _controller: StartupProgressController | null = null;
let _refCount = 0;

/**
 * Singleton composable for startup progress state.
 * Shared across AgentRouter (renders overlay) and Agent (reacts to readiness).
 *
 * Call `start()` on mount and `dispose()` on unmount — the controller is
 * ref-counted so the last consumer to unmount tears it down.
 */
export function useStartupProgress() {
  if (!_state) {
    _state = StartupProgressController.createState();
    _controller = new StartupProgressController(_state);
  }

  const start = () => {
    _refCount++;
    if (_refCount === 1) {
      _controller!.start();
    }
  };

  const dispose = () => {
    _refCount--;
    if (_refCount <= 0) {
      _controller!.dispose();
      _refCount = 0;
    }
  };

  return {
    ..._state!,
    start,
    dispose,
  };
}
