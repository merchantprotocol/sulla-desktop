// The bootstrap helper branch executes before importing any normal Desktop
// modules, IPC handlers, browser registries, agent services, or logging.
if (process.argv.includes('--sulla-vault-bootstrap-helper') || process.argv.includes('--sulla-vault-cache-update-helper')) {
  void import('@pkg/main/vaultBootstrapProcess').then(module => module.runVaultBootstrapProcess());
} else {
  void import('./background');
}
