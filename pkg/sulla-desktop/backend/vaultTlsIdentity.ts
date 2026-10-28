// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// /var/lib is tmpfs in the Sulla VM; Docker containers survive on /mnt/data.
export const VAULT_TLS_DIRECTORY = '/mnt/data/var/lib/sulla/vault-tls';

export function vaultTlsBind(certificateOnly = false) {
  return {
    type:      'bind',
    source:    certificateOnly ? `${ VAULT_TLS_DIRECTORY }/tls.crt` : VAULT_TLS_DIRECTORY,
    target:    certificateOnly ? '/run/sulla-vault-ca/tls.crt' : '/run/sulla-vault-tls',
    read_only: true,
    bind:      { create_host_path: false },
  };
}
