// Adding someone to a workspace the way Liston does (invites.service): an
// invitation, then its link accepted — a new login with the password given,
// or a login already on Liston joining with its password. Answers as the
// old "add member" call did: { status: 201, data: { member, existingLogin,
// token } }, or the refusal as it came.

async function call(baseUrl, method, path, body, token, team) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(team ? { 'X-Liston-Workspace': team } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

/** The invitation link's token, from the link the Members page shows. */
const linkToken = (link) => String(link).split('/invite/')[1];

async function addMember(baseUrl, ownerToken, { email, name, password, sameAs }, { team = null } = {}) {
  const sent = await call(baseUrl, 'POST', '/api/team/invites', { email, ...(name ? { name } : {}), ...(sameAs ? { sameAs } : {}) }, ownerToken, team);
  if (sent.status >= 300) return sent;
  const accepted = await call(baseUrl, 'POST', `/api/invites/${linkToken(sent.data.invite.link)}/accept`, { ...(name ? { name } : {}), password });
  if (accepted.status !== 200) return accepted;
  const { user, token } = accepted.data;
  return { status: 201, data: { member: { id: user.id, email: user.email, name: user.name }, existingLogin: sent.data.invite.existingLogin, token } };
}

module.exports = { addMember, linkToken, call };
