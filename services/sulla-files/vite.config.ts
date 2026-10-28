// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
export default defineConfig({root:'web-src',base:'./',plugins:[vue()],build:{outDir:'../web',emptyOutDir:true,sourcemap:false}});
