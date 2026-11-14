/**
 * Bundles the API into one ESM file so the installer needs no node_modules.
 * `banner` gives the CJS dependencies (fastify plugins, pg, ...) a real `require`.
 */
const path = require('node:path');
const esbuild = require('esbuild');

const here = __dirname;
const root = path.resolve(here, '..');
const entry = path.join(root, '..', 'apps', 'api', 'src', 'main.ts');
const outfile = path.join(root, 'runtime', 'api.mjs');

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'warning',
    external: ['pg-native'],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
    },
  })
  .then(() => {
    const bytes = require('node:fs').statSync(outfile).size;
    console.log(`api bundle: ${outfile} (${bytes} bytes)`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
