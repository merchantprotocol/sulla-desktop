// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The one place the enrollment characterization specs touch production entry points. The specs
 * (Characterization/Vault/DesktopEnrollment*.spec.ts) assert only wire bytes and broker calls, so
 * a refactor swaps the entry points here and leaves every assertion unchanged.
 * Load it after `vi.resetModules()` so each test gets fresh module state.
 */
export class DesktopEnrollmentHarness {
  private constructor(
    private readonly requester: typeof import('../../../../main/cloud/enrollment/DesktopVaultEnrollmentModule'),
    private readonly approver: typeof import('../../../../main/cloud/vaultDeviceApproval'),
  ) {}

  static async load(): Promise<DesktopEnrollmentHarness> {
    return new DesktopEnrollmentHarness(
      await import('../../../../main/cloud/enrollment/DesktopVaultEnrollmentModule'),
      await import('../../../../main/cloud/vaultDeviceApproval'),
    );
  }

  gate(): Promise<string> { return this.requester.DesktopVaultEnrollment.coordinator.gate() }

  complete(masterKey: Uint8Array, cloudUserId: string): Promise<string> { return this.requester.DesktopVaultEnrollment.coordinator.complete(masterKey, cloudUserId) }

  startApprover(): void { this.approver.VaultDeviceApproval.start() }

  stopApprover(): void { this.approver.VaultDeviceApproval.stop() }
}
