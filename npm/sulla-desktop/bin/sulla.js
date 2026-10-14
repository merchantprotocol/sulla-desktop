#!/usr/bin/env node

import { spawn } from 'node:child_process';

const installerUrl = 'https://raw.githubusercontent.com/merchantprotocol/sulla-desktop/main/install.sh';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Downloads, installs, and launches the latest Sulla Desktop release.');
  console.log('Usage: npx sulla-desktop');
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log('sulla-desktop launcher 1.0.0');
  process.exit(0);
}

try {
  console.log('Fetching the official Sulla Desktop installer...');
  const response = await fetch(installerUrl, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`Installer download failed (${response.status} ${response.statusText}).`);
  }

  const installer = await response.text();
  const child = spawn('bash', ['-s', '--', '--launch'], {
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  child.on('error', (error) => {
    if (error.code === 'ENOENT') {
      console.error('Could not find bash. On Windows, install Git for Windows and run this from Git Bash.');
    } else {
      console.error(`Could not start the installer: ${error.message}`);
    }
    process.exitCode = 1;
  });

  child.on('close', (code, signal) => {
    if (signal) {
      console.error(`Installer stopped by signal ${signal}.`);
      process.exitCode = 1;
    } else if (code !== 0) {
      process.exitCode = code ?? 1;
    }
  });

  child.stdin.end(installer);
} catch (error) {
  console.error(`Unable to download the Sulla Desktop installer: ${error.message}`);
  console.error(`Installer source: ${installerUrl}`);
  process.exitCode = 1;
}
