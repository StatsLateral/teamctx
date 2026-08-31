/**
 * A GitHub account's verified primary email.
 *
 * An email address is the one identity every surface can agree on: a clone
 * reads it from `git config`, Google hands it over verified, and GitHub knows
 * it too — but only tells you with the `user:email` scope, and `GET /user`
 * returns it only when the account has made it public. Without asking, the same
 * person is `git:<email>` on their laptop and `github:<id>` in a chat client,
 * and no gate written on one recognises the other.
 *
 * Unverified addresses are skipped: GitHub lets you add an address before
 * confirming it, so treating one as identity would let somebody claim a gate
 * pinned to an email they do not own.
 */
export async function primaryEmail(token) {
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    // 403 is the ordinary answer for a token minted before `user:email` was
    // asked for. Falling back to the numeric id keeps that session working.
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list)) return null;
    const chosen = list.find(e => e?.primary && e?.verified) || list.find(e => e?.verified);
    return chosen?.email ? String(chosen.email).toLowerCase() : null;
  } catch {
    return null;
  }
}
