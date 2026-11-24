# Spike: passing chatbot-generated files to teamctx by reference (#258)

Status: findings, awaiting review. No build proposed yet.
Issue: #258 (enhancement, Post-MVP, low priority). Part of the file-outputs epic
(`docs/superpowers/specs/2026-11-02-task-file-outputs-design.md`, #244–#247),
and the sibling of the upload-URL work
(`docs/superpowers/specs/2026-11-19-request-upload-url-design.md`, #257).

## The question

A person working in a chatbot may generate dozens of files. Bytes in a tool call
are tokens, so teamctx deliberately has no MCP tool that carries file bytes. #257
answered this from the *sandbox* side: `request_upload` mints a short-lived URL
and the chatbot's own code sandbox `PUT`s the bytes out of band.

#258 asks the other half: can the **chat platform itself** hand a generated or
attached file to a teamctx tool **by reference** — so the platform, not a code
sandbox, delivers the bytes, and the model still never carries them? And if so,
is a per-platform connector worth building? This is a spike: report what works,
with limits, before any build.

## What was checked

OpenAI's Actions and Apps SDK documentation and developer reports; the Model
Context Protocol resources spec (2025-03-26, 2025-06-18, 2026-07-28) and its
file-uploads working group; and how a platform delivers a referenced file to a
server. Sources are listed at the end. Platform behaviour here is moving month to
month, so each claim below should be re-checked against the live docs before any
build starts.

## Findings

### MCP has no portable, native file *input* yet

MCP can carry binary data **server → model** (as image, audio, or an embedded
resource in a tool result). It has no native way to carry a file **model →
server** as a tool argument. The only transport for that today is a base64 blob
inside the JSON arguments, which has two costs that defeat the whole point: the
model must emit the entire encoded file perfectly, and base64 adds a ~33% size
tax on bytes that are now back in the model's context.

The portable pattern the ecosystem has converged on is therefore **not** a file
argument at all: a server mints an opaque handle, hands it back as an ordinary
tool argument, and the client uploads the bytes out of band with a plain HTTP
request — neither the bytes nor the upload URL enter the model's context. The
MCP 2026-07-28 changelog describes exactly this "server-minted handle" shape, and
other vendors (e.g. Box) ship the same temporary-secured-URL approach. **That is
`request_upload` (#257).** The spike's first finding is that teamctx already
built the portable answer to #258; there is no standard file-by-reference input
to adopt instead.

A declarative native file input (working group SEP-2356) is proposed but was
**not** in the 2026-07-28 release candidate. Until it lands and hosts implement
it, there is nothing cross-platform to build against.

### ChatGPT is the one platform with semi-native by-reference paths

ChatGPT exposes two mechanisms, and both deliver the file the way #258 hopes for
— as a **short-lived download URL the server fetches**, not as bytes in the
model's context:

- **Custom GPT Actions** (`openaiFileIdRefs`): a user-uploaded, DALL·E, or Code
  Interpreter file is passed to a REST action as a reference object carrying a
  download URL, which the backend fetches.
- **Apps SDK / MCP apps** (`openai/fileParams`): a tool input is declared as a
  file parameter and ChatGPT delivers a download URL to the MCP server.

Both are real but immature. Reported rough edges: the tool call can appear in the
UI without the server ever receiving it; duplicate calls carry the same file id
with different download URLs; files uploaded from the **mobile** app arrive as
incomplete references rather than downloadable URLs; and `app.downloadFile()`
returns "Method not found" on the ChatGPT host (while working on Claude's host).
Several older forum threads describing file passing as impossible are from
2023–2024 and should be treated as outdated, but the 2026 reports above show the
current paths still have gaps.

### Other hosts

On Anthropic's host the resource/download bridge is reported to work more
completely than ChatGPT's, but there is still no declarative file-input argument
that is portable across hosts. For every host, the out-of-band upload handle
(#257) remains the lowest-common-denominator that works today without waiting on
a platform feature.

## Answers to the issue's open questions

1. **Which platforms support it today, and on which plans?** Only ChatGPT has a
   semi-native by-reference path (Custom GPT Actions and Apps SDK file params);
   both are immature and host-specific. No portable MCP file-input exists; Claude
   and other hosts rely on the out-of-band handle. Plan gating was not
   established from public docs and would need confirming with each platform.
2. **URL we fetch, or request body?** Where a platform supports it at all, the
   file arrives as a **short-lived URL the server fetches**, not as a multipart
   body and not as bytes in the model. Base64-in-arguments is technically
   possible but is the token cost the epic exists to avoid.
3. **Is a per-platform connector worth it?** **Not yet.** The cross-platform
   standard is not ready, and the one semi-native path (ChatGPT) is still buggy.
   Building a connector per platform now would mean owning a moving, host-specific
   surface for a Post-MVP, low-priority gain, against the issue's own guidance to
   lean on the platform's own file-passing rather than build a parallel service.

## Recommendation

Do not build a per-platform file connector now. Two reasons: the portable answer
(`request_upload`, #257) already covers the sandbox case and needs no platform
cooperation; and the one place by-reference is semi-native (ChatGPT) is not stable
enough to depend on.

The cheap, low-risk step — if and when one platform's path is wanted — is a thin
adapter, because **teamctx already has the server half**. The hosted transit path
from #251 fetches bytes from a URL server-side (`fetchTransitBytes`) and stores
them through the ordinary output rules. A "platform hands us a download URL"
endpoint is the same fetch-validate-store, with the URL coming from the platform's
file reference instead of a teamctx-minted transit blob — reusing the existing
size, type, name-safing and scope gates. No parallel upload service, as the issue
asks.

Concretely, when picked up:

- Track SEP-2356 and the MCP file-uploads working group; adopt the native input
  when it lands and hosts implement it, rather than a bespoke one.
- Treat ChatGPT `openai/fileParams` as the first candidate adapter, but only once
  the mobile-reference and duplicate-call issues are resolved upstream; gate it
  behind the same checks as `attachFileOutput`.
- Any fetched reference URL is untrusted input: fetch server-side with a size cap
  and a timeout, never follow it into private networks, and run the bytes through
  the existing validation before storing.

## Sources

- OpenAI, Actions — sending files: https://developers.openai.com/api/docs/actions/sending-files/index.html
- OpenAI, Actions — including files: https://developers.openai.com/api/docs/actions/getting-started/including-files
- OpenAI, Apps SDK reference: https://developers.openai.com/apps-sdk/reference.md
- OpenAI Apps SDK, build an MCP server: https://developers.openai.com/apps-sdk/build/mcp-server
- Community: MCP tool invocation issues with `openai/fileParams`: https://community.openai.com/t/mcp-tool-invocation-issues-with-openai-fileparams/1370569
- Community: files in ChatGPT Apps (MCP) — parity with GPT file Actions: https://community.openai.com/t/files-in-chatgpt-apps-mcp-parity-with-gpt-file-actions/1367683
- Community: `app.downloadFile()` returns "Method not found" in ChatGPT host: https://community.openai.com/t/app-downloadfile-returns-method-not-found-in-chatgpt-host/1378708
- Community: MCP file uploads broken on mobile app: https://community.openai.com/t/mcp-file-uploads-broken-on-mobile-app/1372060
- MCP blog, exploring file uploads and downloads in MCP: https://blog.modelcontextprotocol.io/posts/exploring-file-uploads-and-downloads-in-mcp/
- MCP spec, resources (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/server/resources.md
- MCP file-uploads working group: https://modelcontextprotocol.io/community/working-groups/file-uploads.md
- Box, upload and download binary with MCP: https://blog.box.com/upload-and-download-binary-mcp-how-box-solved-last-mile-agentic-file-editing
