// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

'use strict';

class ServerUserError extends Error {}

function printServerHelp(command = 'npx sulla-desktop') {
  console.log(`${command} server — moved to the separately licensed Sulla Server package

Sulla Server is no longer bundled with Sulla Desktop.
Install from the Server release instead:
  npx sulla-server

Guide: https://github.com/merchantprotocol/sulla-server#install-transition-build`);
}

function runServer(argv, command = 'npx sulla-desktop') {
  if (argv.some(arg => arg !== '--help' && arg !== '-h')) {
    throw new ServerUserError(`Sulla Server moved to its own package. Run "npx sulla-server" instead.`);
  }
  printServerHelp(command);
}

module.exports = { ServerUserError, printServerHelp, runServer };
