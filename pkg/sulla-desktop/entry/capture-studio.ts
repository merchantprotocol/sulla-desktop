// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import { CaptureStudioWindow } from './capture-studio/CaptureStudioWindow';
import { ProductionCaptureContext, ProductionCaptureHost, ProductionCaptureResources } from './capture-studio/ProductionCaptureWindow';

await new CaptureStudioWindow(
  new ProductionCaptureContext(), new ProductionCaptureHost(), new ProductionCaptureResources(),
  document, window, error => console.warn('[CameraEffects]', error),
).mount();
