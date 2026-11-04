/**
 * The approval page shown once, before a client is first given access.
 *
 * The identity is known by the time this renders (the sign-in has happened),
 * so the page can name who is approving, the client asking, and where a code
 * would be sent. Everything variable is escaped: `client_name` comes from a
 * dynamic registration and is attacker-controlled.
 */

const escape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function consentPage({ clientName, redirectHost, identity, cToken }) {
  const name = clientName ? escape(clientName) : 'An application';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Approve this connection</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 30rem; margin: 10vh auto; padding: 0 1rem; }
  .card { border: 1px solid #8884; border-radius: 12px; padding: 1.5rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .25rem .75rem; margin: 1rem 0; }
  dt { color: #8a8a8a; } dd { margin: 0; word-break: break-all; }
  .row { display: flex; gap: .75rem; margin-top: 1.25rem; }
  button { font: inherit; padding: .6rem 1rem; border-radius: 8px; border: 1px solid #8884; cursor: pointer; flex: 1; }
  .approve { background: #2563eb; color: #fff; border-color: #2563eb; }
  form { display: contents; }
</style>
</head>
<body>
  <div class="card">
    <h1>Approve this connection</h1>
    <p><strong>${name}</strong> is asking to connect to teamctx on your behalf.</p>
    <dl>
      <dt>Signed in as</dt><dd>${escape(identity)}</dd>
      <dt>Sends the result to</dt><dd>${escape(redirectHost)}</dd>
    </dl>
    <p>Approve only if you started this from this application.</p>
    <div class="row">
      <form method="POST" action="/oauth/consent">
        <input type="hidden" name="c" value="${escape(cToken)}">
        <input type="hidden" name="decision" value="cancel">
        <button type="submit">Cancel</button>
      </form>
      <form method="POST" action="/oauth/consent">
        <input type="hidden" name="c" value="${escape(cToken)}">
        <input type="hidden" name="decision" value="approve">
        <button type="submit" class="approve">Approve</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}
