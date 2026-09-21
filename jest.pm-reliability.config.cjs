// Focused runtime checks; type checking remains a separate build concern.
module.exports = {
  rootDir: __dirname,
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      diagnostics: false,
      tsconfig: {
        module: 'ESNext', moduleResolution: 'node', target: 'ES2022',
        esModuleInterop: true, isolatedModules: true,
      },
    }],
  },
  moduleNameMapper: { '^@pkg/(.*)$': '<rootDir>/pkg/rancher-desktop/$1' },
  modulePathIgnorePatterns: ['<rootDir>/node_modules/'],
  testMatch: [
    '**/PlaybookController.leases.test.ts',
    '**/WorkflowLeaseHeartbeat.test.ts',
    '**/TaskDispatcherService.test.ts',
    '**/WorkflowExecutionModel.reconcile.postgres.test.ts',
    '**/WorkLaneWorkflowBindingModel.postgres.test.ts',
    '**/TaskDispatcherCrashSoak.postgres.test.ts',
  ],
};
