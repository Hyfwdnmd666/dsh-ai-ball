// Test-only module resolution hook.
//
// `lib/index.js` imports `@deepseek-ai/dsh-tools`, which lives in the host profile and
// cannot be linked into this folder without administrator rights (Windows needs a
// privilege for symlinks and junctions alike).
//
// Rather than drop a stub into `node_modules/` — where it would SHADOW the real package
// once the plugin is installed — we intercept the specifier at resolve time. Nothing on
// disk changes and there is nothing to remember to delete.
//
//   node --import ./test/register.mjs test/selftest.mjs

import { register } from 'node:module';

register('./stub-loader.mjs', import.meta.url);
