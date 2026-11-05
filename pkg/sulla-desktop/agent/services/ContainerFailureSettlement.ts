// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ContainerFailureCleaner {
  clean(): Promise<void>;
}

export interface FailedContainerRetainer<T> {
  retain(): Promise<T>;
}

export interface ContainerFailureDiagnosticLogger {
  error(message: string, error: unknown): void;
}

export interface FailureWithSecondaryErrors extends Error {
  secondaryErrors?: readonly unknown[];
}

export interface ContainerFailureSettlementResult<T> {
  retained?: T;
  secondaryErrors: readonly unknown[];
}

/**
 * Settles a failed container launch without allowing diagnostics to outrank safety.
 * Credential cleanup always runs before retention, and neither secondary operation
 * is allowed to replace the launch failure that the caller will surface.
 */
export class ContainerFailureSettlement<T> {
  constructor(
    private readonly cleaner: ContainerFailureCleaner,
    private readonly retainer: FailedContainerRetainer<T>,
    private readonly logger: ContainerFailureDiagnosticLogger,
    private readonly context: string,
  ) {}

  async settle(originalError: unknown): Promise<ContainerFailureSettlementResult<T>> {
    const secondaryErrors: unknown[] = [];
    let retained: T | undefined;

    try {
      await this.cleaner.clean();
    } catch (error) {
      secondaryErrors.push(error);
      this.logger.error(`${ this.context }: credential cleanup failed`, error);
    }

    try {
      retained = await this.retainer.retain();
    } catch (error) {
      secondaryErrors.push(error);
      this.logger.error(`${ this.context }: failed-container retention failed`, error);
    }

    if (originalError instanceof Error && secondaryErrors.length > 0) {
      const failure = originalError as FailureWithSecondaryErrors;
      failure.secondaryErrors = [...(failure.secondaryErrors ?? []), ...secondaryErrors];
    }

    return { retained, secondaryErrors };
  }
}

/** Applies the shared failure settlement when Docker failed before returning a container id. */
export class PreCreateFailureSettlement {
  constructor(private readonly logger: ContainerFailureDiagnosticLogger) {}

  async settle<T>(originalError: unknown, context: string, cleanup: () => Promise<T>): Promise<T | undefined> {
    let receipt: T | undefined;
    await new ContainerFailureSettlement(
      { clean: async() => { receipt = await cleanup() } },
      { retain: async() => undefined },
      this.logger,
      context,
    ).settle(originalError);
    return receipt;
  }
}
