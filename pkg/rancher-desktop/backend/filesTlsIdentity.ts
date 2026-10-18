export const FILES_TLS_DIRECTORY = '/mnt/data/var/lib/sulla/files-tls';

export function filesTlsBind(certificateOnly = false) {
  return {
    type:      'bind',
    source:    certificateOnly ? `${ FILES_TLS_DIRECTORY }/tls.crt` : FILES_TLS_DIRECTORY,
    target:    certificateOnly ? '/run/sulla-files-ca/tls.crt' : '/run/sulla-files-tls',
    read_only: true,
    bind:      { create_host_path: false },
  };
}
