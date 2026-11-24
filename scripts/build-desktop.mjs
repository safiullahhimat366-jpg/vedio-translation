import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

async function buildDesktop() {
  console.log('[1/2] Building SadaVox Studio frontend (dist/)...');
  execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });

  const outDir = path.join(ROOT, 'dist-desktop');
  fs.mkdirSync(outDir, { recursive: true });

  // Clean legacy ESM bundle if present so only self-contained server.cjs is shipped
  const legacyMjs = path.join(outDir, 'server.mjs');
  if (fs.existsSync(legacyMjs)) {
    fs.rmSync(legacyMjs, { force: true });
  }

  console.log('[2/2] Bundling self-contained desktop server (dist-desktop/server.cjs)...');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'server.ts')],
    outfile: path.join(outDir, 'server.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: [
      'vite',
      '@huggingface/transformers',
      'onnxruntime-node',
      'sharp',
      'ffmpeg-static',
      'ffprobe-static',
    ],
  });

  console.log('Desktop bundle ready at dist/ and dist-desktop/server.cjs');
}

buildDesktop().catch((err) => {
  console.error(err);
  process.exit(1);
});
