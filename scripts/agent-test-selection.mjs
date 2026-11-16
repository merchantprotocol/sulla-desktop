// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

const IRRELEVANT_EXTENSIONS = /\.(md|vue|css|scss|less|svg|png|jpe?g|gif|ico|webp)$/;

const RELEVANT_WORKFLOW_FILE = '.github/workflows/agent-tests.yml';

const GUEST_DISK_ROOTS = [
  'pkg/sulla-desktop/agent/tests/Characterization/DesktopRuntime/',
  'src/runtime-agent/',
];

const GUEST_DISK_FILES = ['services/sulla-tools/Dockerfile'];

export class AgentTestChangeClassifier {
  classify(files) {
    const normalized = [...new Set(files.filter(Boolean))].sort();
    return {
      files: normalized,
      shouldRun: normalized.length > 0 && !normalized.every(file => this.isKnownIrrelevant(file)),
      needsBusyBox: normalized.some(file => this.needsGuestDiskCoverage(file)),
    };
  }

  isKnownIrrelevant(file) {
    if (IRRELEVANT_EXTENSIONS.test(file)) return true;
    if (file.startsWith('docs/')) return true;
    if (file.startsWith('.github/workflows/') && file !== RELEVANT_WORKFLOW_FILE) return true;
    return false;
  }

  needsGuestDiskCoverage(file) {
    if (/guestDisk|GuestDisk/.test(file)) return true;
    return GUEST_DISK_ROOTS.some(root => file.startsWith(root)) || GUEST_DISK_FILES.includes(file);
  }
}
