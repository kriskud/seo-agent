import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadEnv } from '../lib.mjs';
import { runDiscovery, validateConfig } from './discover.mjs';
import { createVkProvider, planVkSearches, validateVkConfig } from './providers/vk.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: node seeding/discover-vk.mjs [--dry-run]'); return; }
  if (args.some(a => a !== '--dry-run')) throw new Error('Unknown argument');
  const config = JSON.parse(readFileSync(join(ROOT, 'seeding/config/cosmodesk.json'), 'utf8'));
  const vk = JSON.parse(readFileSync(join(ROOT, 'seeding/config/vk.json'), 'utf8'));
  validateConfig(config); validateVkConfig(vk);
  if (!vk.enabled || !vk.communityIds.length) {
    console.log('VK discovery disabled: enable it and specify communityIds. API requests: 0'); return;
  }
  loadEnv();
  const provider = createVkProvider({ config: vk });
  const out = await runDiscovery({ config, provider, file: join(ROOT, 'data/seeding/cosmodesk.json'),
    dryRun: args.includes('--dry-run'), rotationKey: 'vkRotation',
    makePlan: store => planVkSearches(vk, config.queries, store.vkRotation ?? 0),
    onError: message => console.error(`[seeding-vk] ${message}`),
  });
  console.log('CosmoDesk VK discovery\n' + JSON.stringify(out.summary, null, 2));
  if (args.includes('--dry-run')) console.log(JSON.stringify(out.preview, null, 2));
  if (out.summary.errors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`[seeding-vk] ${e.message}`); process.exitCode = 1; });
}
