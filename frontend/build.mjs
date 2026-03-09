// frontend/build.mjs
import esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [resolve(__dirname, 'src/main.js')],
  absWorkingDir: __dirname,
  bundle: true,
  outfile: resolve(__dirname, 'dist/bundle.js'),
  format: 'iife',
  globalName: 'LendBTCSDK',
  platform: 'browser',
  target: ['chrome90', 'firefox90', 'safari14'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
    'process.version': '"v18.0.0"',
  },
  // Don't bundle Node.js built-ins — they aren't used with our direct fetch approach
  external: [],
  mainFields: ['browser', 'module', 'main'],
  conditions: ['browser', 'import', 'default'],
  banner: {
    js: '// LendBTC Frontend SDK — auto-generated, do not edit\n',
  },
  logLevel: 'info',
});

console.log('Bundle built at frontend/dist/bundle.js');
