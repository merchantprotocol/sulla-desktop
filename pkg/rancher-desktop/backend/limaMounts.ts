export interface ReconciledLimaMount {
  location: string;
  writable?: boolean;
  '9p'?: Record<string, string>;
}

export function replaceLimaMounts<M extends ReconciledLimaMount>(config:{ mounts?:M[] }, desired:readonly M[]):void {
  config.mounts = desired.map(mount => ({ ...mount, ...(mount['9p'] ? { '9p': { ...mount['9p'] } } : {}) })) as M[];
}
