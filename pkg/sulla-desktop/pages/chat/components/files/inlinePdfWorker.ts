/*
 * Sulla Desktop · https://sulladesktop.com
 * Copyright (c) 2025-2026 Merchant Protocol LLC.
 * SPDX-License-Identifier: GPL-2.0-or-later
 * "Sulla" is a trademark. See TRADEMARK.md.
 */

// This file is emitted as a standalone Web Worker by the renderer bundler.
// PDF parsing stays off the chat/app thread; page pixels are returned to canvas.
import 'pdfjs-dist/build/pdf.worker.mjs';
