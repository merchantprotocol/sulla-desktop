// Sulla Cloud · Passwords (vault origin): Trusted Types default policy.
// Loaded first. The vault CSP requires Trusted Types for script sinks: no
// string may become script, and the only script URL allowed is this
// origin's crypto worker. HTML sinks pass through because the shared shell
// renders with innerHTML; CSP (script-src 'self', no inline) keeps any
// injected markup inert, and every value is escaped before rendering.
(function () {
  'use strict';
  if (!window.trustedTypes || !window.trustedTypes.createPolicy) return;
  const WORKER = new URL('/js/cloud/passwords/crypto-worker.js', location.origin).href;
  window.trustedTypes.createPolicy('default', {
    createHTML: (value) => value,
    createScript: () => { throw new TypeError('Scripts from strings are blocked on the vault page'); },
    createScriptURL: (value) => {
      const url = new URL(value, location.href).href;
      if (url !== WORKER) throw new TypeError('Only the vault crypto worker may load here');
      return url;
    },
  });
})();
