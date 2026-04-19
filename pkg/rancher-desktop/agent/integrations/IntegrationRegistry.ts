// IntegrationRegistry.ts (keep this separate as proposed earlier)
export class IntegrationRegistry {
  private instances = new Map<string, any>();
  private factories = new Map<string, () => Promise<any>>();

  /**
   * Returns true if this id has a factory registered. Useful for ids that
   * may be credential-only (e.g. sulla-cloud) where we don't want to spam
   * "No factory registered" on every connect-event reload.
   */
  hasFactory(id: string): boolean {
    return this.factories.has(id);
  }

  register<T>(id: string, factory: () => Promise<T>): void {
    console.log('[IntegrationRegistry] register()', {
      id,
      hadFactory:         this.factories.has(id),
      instanceCount:      this.instances.size,
      factoryCountBefore: this.factories.size,
      pid:                typeof process !== 'undefined' ? process.pid : null,
      processType:        typeof process !== 'undefined' ? ((process as any).type || 'node') : 'unknown',
    });
    this.factories.set(id, factory);
  }

  async get<T>(id: string): Promise<T> {
    const hasInstance = this.instances.has(id);
    console.log('[IntegrationRegistry] get() called', {
      id,
      hasInstance,
      hasFactory:    this.factories.has(id),
      instanceCount: this.instances.size,
      factoryCount:  this.factories.size,
      pid:           typeof process !== 'undefined' ? process.pid : null,
      processType:   typeof process !== 'undefined' ? ((process as any).type || 'node') : 'unknown',
    });

    if (!this.instances.has(id)) {
      const factory = this.factories.get(id);
      if (!factory) throw new Error(`No factory registered for integration: ${ id }`);

      console.log('[IntegrationRegistry] get() cache miss -> invoking factory', { id });
      const instance = await factory();

      console.log('[IntegrationRegistry] factory resolved', {
        id,
        gotInstance:  instance !== null && instance !== undefined,
        instanceType: instance === null || instance === undefined ? 'nullish' : typeof instance,
      });
      if (instance !== null && instance !== undefined) {
        this.instances.set(id, instance);
        console.log('[IntegrationRegistry] instance cached', {
          id,
          instanceCount: this.instances.size,
        });
      }
      return instance;
    }

    console.log('[IntegrationRegistry] get() cache hit', {
      id,
      instanceCount: this.instances.size,
    });
    return this.instances.get(id) as T;
  }

  async invalidate(id: string): Promise<void> {
    console.log('[IntegrationRegistry] invalidate() called', {
      id,
      hasInstance:         this.instances.has(id),
      instanceCountBefore: this.instances.size,
    });

    if (!this.instances.has(id)) {
      console.log('[IntegrationRegistry] invalidate() no-op (missing instance)', { id });
      return;
    }

    const instance = this.instances.get(id);
    if (instance && typeof instance.close === 'function') {
      await instance.close().catch((err: unknown) => console.error(`[Registry] Close error (${ id }):`, err));
    }

    this.instances.delete(id);
    console.log('[IntegrationRegistry] invalidate() complete', {
      id,
      instanceCountAfter: this.instances.size,
    });
  }

  async closeAll(): Promise<void> {
    for (const instance of this.instances.values()) {
      if (typeof instance.close === 'function') {
        await instance.close().catch((err: unknown) => console.error('[Registry] Close error:', err));
      }
    }
  }
}
