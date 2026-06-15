import { readFileSync } from 'fs';
import { join } from 'path';

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

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${role}.md"`);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(content);
}
