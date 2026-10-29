import { runDoctor } from './doctor.core.js';

const MARK = { ok: '✓', fail: '✗', skip: '–' };

/** One line per check; the failures say what to do. Exits 1 if any failed. */
export function formatDoctor(checks) {
  const lines = checks.map(c => `  ${MARK[c.status]} ${c.name}${c.fix ? ` — ${c.fix}` : ''}`);
  const failed = checks.filter(c => c.status === 'fail').length;
  lines.push('', failed ? `${failed} problem${failed === 1 ? '' : 's'} to fix.` : 'all good');
  return { text: lines.join('\n'), failed };
}

export async function doctorCommand(opts = {}) {
  const { text, failed } = formatDoctor(await runDoctor({ offline: Boolean(opts.offline) }));
  console.log(`\n${text}\n`);
  if (failed) process.exitCode = 1;
}
