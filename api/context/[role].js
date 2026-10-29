import { readFileSync } from 'fs';
import { join } from 'path';
import { contextFreshness, freshnessLine, withFreshness } from '../../src/freshness.js';
import { readConfig } from '../../src/storage.js';

export default function handler(req, res) {
  const { role } = req.query;

  // Only allow slugs: lowercase letters, digits, hyphens — prevents path traversal
  if (!role || !/^[a-z0-9-]+$/.test(role)) {
    res.status(400).send('Invalid role name.');
    return;
  }

  const filePath = join(process.cwd(), '.teamctx', 'context', 'roles', `${role}.md`);

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    res.status(404).send(`Role "${role}" not found.`);
    return;
  }

  // How fresh it is, under the title (#183). Worked out as it is served; a
  // project whose approvals cannot be read still gets its file.
  try {
    const dir = join(process.cwd(), '.teamctx');
    const found = (readConfig(dir).roles || []).find(r => r.slug === role) || null;
    content = withFreshness(content, freshnessLine(contextFreshness(dir, { role: found })));
  } catch { /* serve the file as it is */ }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${role}.md"`);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(content);
}
