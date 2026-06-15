import { ask } from '../prompt.js';
import { readConfig } from '../../src/storage.js';
import { contributeCommand } from './contribute.js';
import { createClient } from '@vercel/kv';

function getKvClient() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'KV_REST_API_URL and KV_REST_API_TOKEN must be set.\n' +
      'Get them from your Vercel dashboard → Storage → KV database → .env.local'
    );
  }
  return createClient({ url, token });
}

export async function pullCommand() {
  let kv;
  try { kv = getKvClient(); } catch (err) { console.error(`Error: ${err.message}`); process.exit(1); }

  const config = readConfig();
  const items = await kv.lrange('teamctx:contributions', 0, -1);

  if (!items || items.length === 0) { console.log('No pending web contributions.'); return; }

  console.log(`\n${items.length} pending web contribution${items.length !== 1 ? 's' : ''}:\n`);

  const skipped = [];
  let processed = 0;
  for (let i = 0; i < items.length; i++) {
    const item = typeof items[i] === 'string' ? JSON.parse(items[i]) : items[i];
    console.log(`[${i + 1}/${items.length}] Author: ${item.author || 'anonymous'}`);
    console.log(`  "${item.text}"\n`);

    const answer = await ask('Apply? (y/n/skip-all)', 'y');
    if (answer.toLowerCase() === 'skip-all') {
      for (let j = i; j < items.length; j++) skipped.push(items[j]);
      console.log('Skipping remaining.');
      break;
    }

    if (answer.toLowerCase() === 'y') {
      const text = item.author && item.author !== config.me
        ? `[From ${item.author}] ${item.text}`
        : item.text;
      try {
        await contributeCommand(text, { autoApprove: false, decision: false });
        processed++;
      } catch (err) {
        console.error(`  Error processing contribution: ${err.message}`);
        console.log('  Skipping — moving to next item.\n');
      }
    } else {
      skipped.push(items[i]);
      console.log('Skipped.\n');
    }
  }

  if (processed > 0 || skipped.length > 0) {
    await kv.del('teamctx:contributions');
    if (skipped.length > 0) {
      for (const item of skipped) await kv.rpush('teamctx:contributions', typeof item === 'string' ? item : JSON.stringify(item));
    }
    if (processed > 0) {
      const skippedNote = skipped.length > 0 ? `, ${skipped.length} skipped (re-queued)` : '';
      console.log(`\n✓ Processed ${processed} contribution${processed !== 1 ? 's' : ''}${skippedNote}. Queue updated.`);
    }
  }
}
