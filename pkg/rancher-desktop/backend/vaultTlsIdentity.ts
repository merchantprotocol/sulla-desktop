// /var/lib is tmpfs in Lima; Docker containers survive on /mnt/data.
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
