import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

/**
 * The Files container owns and serves its browser UI. The shared server
 * gateway only routes /files to this middleware; it never receives a Files
 * service credential or renders Files data itself.
 */
export function serverUi(): express.Router {
  const router = express.Router();
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../web');

  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; frame-src blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'");
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.use(express.static(webRoot, { index: 'index.html', fallthrough: false }));

  return router;
}
