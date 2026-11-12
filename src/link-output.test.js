/**
 * Validating a link output (#245): the link is normalised to one reference,
 * credential-bearing parameters are stripped, a bare sharing link is dropped,
 * and the version marker is recorded or marked absent.
 */
import { describe, it, expect } from 'vitest';
import { validateLinkOutput, LinkOutputError } from './link-output.js';

describe('validateLinkOutput', () => {
  it('normalises every Drive link for one file to the same reference', () => {
    const editor = validateLinkOutput({ connector: 'gdrive', url: 'https://docs.google.com/document/d/ABC123_def/edit?usp=drivesdk', title: 'Deck' });
    const shared = validateLinkOutput({ connector: 'google drive', url: 'https://drive.google.com/file/d/ABC123_def/view?usp=sharing', title: 'Deck' });
    const old = validateLinkOutput({ connector: 'drive', url: 'https://drive.google.com/open?id=ABC123_def', title: 'Deck' });
    expect(editor.url).toBe('https://drive.google.com/file/d/ABC123_def/view');
    expect(shared.url).toBe(editor.url);
    expect(old.url).toBe(editor.url);
    expect(editor.connector).toBe('gdrive');
  });

  it('strips a credential-bearing query parameter from the stored link', () => {
    const rec = validateLinkOutput({ connector: 'gdrive', url: 'https://drive.google.com/file/d/ABC123_def/view?access_token=SEKRIT', title: 'T' });
    expect(rec.url).not.toContain('SEKRIT');
    expect(rec.url).not.toContain('access_token');
  });

  it('does not store a bare sharing link (the access itself), keeping the name', () => {
    const rec = validateLinkOutput({ connector: 'dropbox', url: 'https://www.dropbox.com/scl/fi/xxx/report.pdf?rlkey=abc&dl=0', title: 'Report' });
    expect(rec.url).toBeNull();
    expect(rec.title).toBe('Report');
  });

  it('records a version marker, or null when the tool gave none', () => {
    const withV = validateLinkOutput({ connector: 'gdrive', url: 'https://drive.google.com/file/d/ID/view', title: 'T', version: 'rev-42' });
    const without = validateLinkOutput({ connector: 'gdrive', url: 'https://drive.google.com/file/d/ID/view', title: 'T' });
    expect(withV.version).toBe('rev-42');
    expect(without.version).toBeNull();
  });

  it('carries the connector for a tool it does not know as "other"', () => {
    const rec = validateLinkOutput({ connector: 'figma', url: 'https://figma.com/file/xyz/Mock', title: 'Mock' });
    expect(rec.connector).toBe('other');
    expect(rec.url).toBe('https://figma.com/file/xyz/Mock');
  });

  it('refuses a link output with neither a link nor a name', () => {
    expect(() => validateLinkOutput({ connector: 'gdrive' })).toThrow(LinkOutputError);
    expect(() => validateLinkOutput({ connector: 'gdrive', url: 'not a url' })).toThrow(LinkOutputError);
  });
});
