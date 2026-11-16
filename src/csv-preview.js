/**
 * Parse CSV text into a bounded grid for the task drawer's preview (#249).
 *
 * This runs in two places from one source: it is unit-tested here as a normal
 * import, and its source is injected into the project page's browser script via
 * `parseCsvPreview.toString()` (as `assistantPlan` is). So it must be
 * self-contained — no imports, no closure over module scope, nothing the
 * browser would not have.
 *
 * It is a preview, not an exact reader: it handles quoted fields, escaped
 * quotes ("") and commas or newlines inside quotes, and caps the grid at
 * `maxRows` × `maxCols`, reporting whether more was left out.
 *
 * @param {string} text
 * @param {number} maxRows
 * @param {number} maxCols
 * @returns {{ rows: string[][], totalRows: number, rowsTruncated: boolean, colsTruncated: boolean }}
 */
export function parseCsvPreview(text, maxRows, maxCols) {
  var all = [];
  var row = [];
  var field = '';
  var inQuotes = false;
  var started = false; // whether the current row has any content yet
  var s = String(text == null ? '' : text);
  for (var i = 0; i < s.length; i += 1) {
    var c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true; started = true;
    } else if (c === ',') {
      row.push(field); field = ''; started = true;
    } else if (c === '\n' || c === '\r') {
      // End the row on a newline; swallow the \n of a \r\n pair.
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      all.push(row); row = []; started = false;
    } else {
      field += c; started = true;
    }
  }
  // A trailing field or row with no closing newline still counts.
  if (started || field !== '' || row.length) { row.push(field); all.push(row); }

  var totalRows = all.length;
  var rowsTruncated = totalRows > maxRows;
  var colsTruncated = false;
  for (var r = 0; r < all.length; r += 1) {
    if (all[r].length > maxCols) { colsTruncated = true; break; }
  }
  var rows = [];
  var keep = Math.min(all.length, maxRows);
  for (var k = 0; k < keep; k += 1) rows.push(all[k].slice(0, maxCols));
  return { rows: rows, totalRows: totalRows, rowsTruncated: rowsTruncated, colsTruncated: colsTruncated };
}
