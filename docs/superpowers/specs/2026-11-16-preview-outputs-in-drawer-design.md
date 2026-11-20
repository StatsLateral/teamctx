# Preview images and CSVs in the task drawer (#249)

## The moment

A file output shows in the drawer as one line — "File: chart.png (image/png,
120 KB)" — and a Download button. To see a screenshot a teammate attached, or
to glance at a small table, a person has to download the file and open it. For a
deliverable that is meant to be looked at, that is a step too many.

## What exists now

- The drawer's Working outputs section (`showWork` in `src/views/project.js`)
  renders each output; for a file it shows `outputText(o)` (name, type, size) and,
  when `o.dl` is set, a "Download file" link.
- `src/views/project-work.js` already hands the client everything needed:
  `o.file` (`{ name, type, size, sha256 }`) and `o.dl`, a same-origin download
  URL (`withDownloads`).
- The download route (`/project/:owner/:repo/task/:taskId/file/:outputId`) serves
  the bytes with the sniffed `Content-Type`, `Content-Disposition: attachment`
  and `X-Content-Type-Options: nosniff` — deliberately a download, never opened
  in the page.
- At upload, `svg`, `html` and scripts are already refused, and an image's real
  type is sniffed from its bytes, so a stored image is a real raster image.

## Proposal

Render a **safe inline preview** for the types where it is both valuable and
safe, keeping the download link in every case. This is a change to `showWork`
only — no new route, no new dependency, no change to what is stored or served.

1. **Images** (`png`, `jpg`, `gif`, `webp`) — add an `<img>` whose `src` is the
   existing `o.dl`. A browser renders an image in an `<img>` tag regardless of
   the attachment disposition, so no route change is needed, and `nosniff` with
   the correct image content-type keeps it an image. The preview is bounded by
   CSS (a max height, scaled down, never the page's full width) and
   `loading="lazy"` so a drawer with several images is cheap.

2. **CSV** — fetch `o.dl` (same-origin, credentials carried) and render the first
   rows and columns as a plain table, each cell set with `textContent` so a
   value can never become markup. The table is **bounded** (for example the
   first ~50 rows × ~20 columns), with a note of how many rows there are and the
   download link for the whole file. The fetch is skipped for a CSV above a small
   size cap, which falls back to download-only.

3. **PDF is deferred, on purpose.** An inline PDF can carry and run script, and
   the download route is attachment-only for exactly that reason. v1 does not
   render PDFs inline; a PDF keeps its current line and Download button. (The
   issue lists images and CSV as the first types; PDF is named as "then".)

4. **Everything else unchanged.** Any other type, and any image or CSV whose
   preview fails or is too large, shows the existing name/size line and the
   Download button. A preview is an addition, never a replacement for the
   download.

5. **No inline html or svg, ever.** Those are refused at upload and are not
   previewed here; nothing from a file is inserted as markup. The only embedding
   is an `<img>` of a sniffed raster image and a table built from text nodes.

## Alternatives considered

- **papaparse for CSV (named in the issue).** A robust parser, but it adds a
  dependency to the page bundle for a bounded, best-effort preview. A small
  dependency-free parse (quoted fields, embedded commas and newlines) is enough
  for a preview and keeps the page lean; papaparse stays the fallback if the
  preview ever needs to be exact.
- **A dedicated inline route that serves images with `Content-Disposition:
  inline`.** Not needed — `<img>` already renders the attachment response, and
  adding an inline route would widen what can be opened in the page.
- **Render PDFs with pdf.js.** Heavy, and it reintroduces the inline-document
  risk the download route avoids. Deferred.

## New dependencies

None. Image preview reuses the download URL; CSV preview uses a small
dependency-free parser.

## What changes for the end user

- **An image output shows in the drawer**, scaled to fit, with the download link
  still there.
- **A small CSV shows as a table**, the first rows and columns, with a note and
  the download link for the rest.
- A PDF or any other type is unchanged — the name, size and Download button.
- Nothing changes about what is uploaded, stored or served.

## Not in this issue

Inline PDF rendering; spreadsheet (`xlsx`) preview; previewing a linked cloud
file; diffing versions (#253); any change to the download route or stored bytes.

## Acceptance

- An image file output renders inline in the drawer, bounded in size, and still
  offers Download.
- A CSV file output renders as a bounded table (first rows/columns) with a note
  and Download; a CSV over the size cap falls back to download-only.
- A PDF and every other type are unchanged (name/size line + Download), and PDF
  is explicitly not rendered inline.
- No file content is ever inserted as markup; no inline html/svg is previewed.
- No new server route, no change to stored or served bytes, and no new
  dependency.
