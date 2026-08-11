import { readDocuments } from '../../src/import.js';
import { contributeCore } from './contribute.core.js';
import { UnknownWorkstreamError } from './role.core.js';

/**
 * Import local documents as proposed contributions.
 *
 * Each document becomes one contribution, distilled by the existing pipeline
 * and left in the manager's review queue. One-per-document keeps review
 * tractable and attribution honest: the queue entry says which file it came
 * from, and a bad import is rejected file by file rather than all or nothing.
 *
 * Nothing is ever applied directly. Import is exactly the path a typed
 * `teamctx contribute` takes, so the manager gate and role regeneration
 * already cover it — there is no second way into shared context.
 */
export async function importDocuments({
  paths,
  workstreamId,
  dryRun = false,
  cwd = process.cwd(),
  teamctxDir,
  projectDir,
  onScanned,
  onProgress,
} = {}) {
  const { documents, skipped } = readDocuments(paths, { cwd });
  // Reading is done before any AI call, so callers can report what was found
  // and skipped up front rather than after several minutes of distilling.
  onScanned?.({ documents, skipped });

  if (dryRun || documents.length === 0) {
    return { documents, skipped, results: [], failures: [], dryRun };
  }

  const results = [];
  const failures = [];
  // Every document is distilled against the same unchanged record, because
  // nothing is applied until a manager approves. Two documents covering the
  // same decision would therefore both propose it. Carrying forward what has
  // already been proposed lets the distiller skip the repeat at the source,
  // rather than queueing duplicates for a human to notice and reject.
  const proposed = [];
  for (const [index, doc] of documents.entries()) {
    onProgress?.({ index, total: documents.length, document: doc });
    try {
      const r = await contributeCore({
        text: doc.text,
        workstreamId,
        // Records which file this came from, so the audit trail points back at
        // the artifact rather than just saying "import".
        source: `import:${doc.id}`,
        apply: false,
        intent: 'document',
        // A snapshot, not the live array: passing the mutable one would mean
        // each document sees whatever later documents go on to add.
        avoid: [...proposed],
        teamctxDir,
        projectDir,
      });
      results.push({
        id: doc.id,
        title: doc.title,
        contributionId: r.id,
        mode: r.mode,
        summary: r.summary,
        operations: r.operations || [],
        workstream: r.workstream,
      });
      for (const op of r.operations || []) {
        if (op.type === 'addWhy' && op.text) proposed.push(op.text);
      }
    } catch (err) {
      // A bad workstream id is a mistake about the whole run, not about this
      // document — fail immediately rather than burning an AI call per file.
      if (err instanceof UnknownWorkstreamError) throw err;
      failures.push({ id: doc.id, error: err.message?.split('\n')[0] || String(err) });
    }
  }

  return { documents, skipped, results, failures, dryRun };
}
