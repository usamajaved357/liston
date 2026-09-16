const { Resend } = require('resend');
const config = require('../config');
const logger = require('./logger');

// Real sends are skipped in tests — no network dependency for the test suite,
// and no risk of burning through Resend's free-tier quota on every test run.
const resend =
  config.resend.apiKey && config.env !== 'test' ? new Resend(config.resend.apiKey) : null;

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    return { sent: false };
  }
  try {
    // The SDK reports failures in the response rather than throwing —
    // Resend's sandbox refusing a non-owner recipient was being counted as
    // a successful send. Confirmed live.
    const { error } = await resend.emails.send({ from: config.resend.fromEmail, to, subject, html });
    if (error) {
      logger.error('Email provider refused the send', { to, subject, error: error.message });
      return { sent: false, reason: error.message };
    }
    return { sent: true };
  } catch (err) {
    // Never throw from here — a failed email must not break signup/login flows.
    logger.error('Failed to send email', { to, subject, error: err.message });
    return { sent: false };
  }
}

// One layout for every email: brand header, a card with the message and a
// single clear action, muted footer. Table-based and inline-styled because
// that's what email clients actually render; no external images so nothing
// is blocked or "loads" late.
const BRAND = { primary: '#4f46e5', ink: '#0f172a', muted: '#64748b', line: '#e2e8f0', paper: '#f4f6fb', danger: '#e11d48', accent: '#0d9488' };

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function button(label, href, color = BRAND.primary) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0"><tr><td style="border-radius:999px;background:${color}">
    <a href="${href}" style="display:inline-block;padding:12px 26px;font:600 15px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:999px">${label}</a>
  </td></tr></table>`;
}

function layout({ preheader, title, intro, body = '', action, afterAction = '', footnote }) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.paper};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.ink}">
  <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${escape(preheader || title)}</span>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${BRAND.paper}">
    <tr><td align="center" style="padding:40px 16px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px">
        <tr><td style="padding:0 4px 18px">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            <td style="width:34px;height:34px;border-radius:10px;background:${BRAND.primary};text-align:center;vertical-align:middle;font:800 18px Helvetica,Arial,sans-serif;color:#ffffff">L</td>
            <td style="padding-left:10px;font:700 17px -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.ink}">Liston</td>
          </tr></table>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:16px;padding:32px 32px 28px">
          <h1 style="margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:700;color:${BRAND.ink}">${title}</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${BRAND.muted}">${intro}</p>
          ${body}
          ${action ? `<div style="margin:24px 0 8px">${action}</div>` : ''}
          ${afterAction}
        </td></tr>
        <tr><td style="padding:18px 8px 0;font-size:12px;line-height:1.6;color:${BRAND.muted}">
          ${footnote || ''}
          <p style="margin:8px 0 0">© ${new Date().getFullYear()} Liston · Listing automation for eBay sellers</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function linkFallback(link) {
  return `<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${BRAND.muted}">If the button doesn't work, copy this link into your browser:<br><a href="${link}" style="color:${BRAND.primary};word-break:break-all">${link}</a></p>`;
}

function sendVerificationEmail(to, link) {
  return sendEmail({
    to,
    subject: 'Confirm your email for Liston',
    html: layout({
      title: 'Confirm your email',
      intro: 'Thanks for requesting access to Liston. Confirm this address so we can reach you about your account.',
      action: button('Confirm email', link),
      afterAction: linkFallback(link),
      footnote: `This link expires in 24 hours. If you didn't sign up for Liston, you can ignore this email.`,
    }),
  });
}

function sendPasswordResetEmail(to, link) {
  return sendEmail({
    to,
    subject: 'Reset your Liston password',
    html: layout({
      title: 'Reset your password',
      intro: 'We received a request to reset the password on your Liston account. Choose a new one below.',
      action: button('Choose a new password', link),
      afterAction: linkFallback(link),
      footnote: `This link expires in 1 hour. If you didn't request a reset, no action is needed — your password stays as it is.`,
    }),
  });
}

// To the admin(s): someone wants in. One click either way.
function sendAccessRequestEmail(to, { applicantEmail, applicantName, note, approveLink, rejectLink, emailVerified }) {
  const row = (label, value) =>
    `<tr><td style="padding:8px 12px;font-size:13px;color:${BRAND.muted};border-bottom:1px solid ${BRAND.line};white-space:nowrap">${label}</td><td style="padding:8px 12px;font-size:14px;color:${BRAND.ink};border-bottom:1px solid ${BRAND.line}">${value}</td></tr>`;
  const details = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${BRAND.line};border-radius:12px;border-collapse:separate;overflow:hidden">
      ${row('Name', escape(applicantName || '—'))}
      ${row('Email', `<a href="mailto:${escape(applicantEmail)}" style="color:${BRAND.primary};text-decoration:none">${escape(applicantEmail)}</a>`)}
      ${row('Email verified', emailVerified ? '<span style="color:' + BRAND.accent + ';font-weight:600">Yes</span>' : 'Not yet — approving accepts it')}
      <tr><td style="padding:8px 12px;font-size:13px;color:${BRAND.muted};vertical-align:top;white-space:nowrap">About their business</td><td style="padding:8px 12px;font-size:14px;line-height:1.5;color:${BRAND.ink}">${note ? escape(note) : '<span style="color:' + BRAND.muted + '">No note left</span>'}</td></tr>
    </table>`;
  const actions = `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
      <td>${button('Approve', approveLink)}</td>
      <td style="padding-left:10px">${button('Reject', rejectLink, BRAND.danger)}</td>
    </tr></table>`;
  return sendEmail({
    to,
    subject: `Access request from ${applicantName || applicantEmail}`,
    html: layout({
      preheader: `${applicantName || applicantEmail} has asked for access to Liston.`,
      title: 'New access request',
      intro: `<strong style="color:${BRAND.ink}">${escape(applicantName || applicantEmail)}</strong> has asked for access to Liston. Review the details and decide with one click.`,
      body: details,
      action: actions,
      footnote: 'These links are valid for 7 days and can be used once. You can also decide from the Access requests page in Liston.',
    }),
  });
}

function sendAccessDecisionEmail(to, { approved, loginLink }) {
  return sendEmail({
    to,
    subject: approved ? 'Your Liston access is approved' : 'About your Liston access request',
    html: approved
      ? layout({
          title: "You're in",
          intro: 'Your access request has been approved. Log in, connect your eBay account, and draft your first listing.',
          action: button('Log in to Liston', loginLink),
          footnote: 'Questions? Just reply to this email.',
        })
      : layout({
          title: 'About your access request',
          intro: "Thanks for your interest in Liston. We're not able to open access for this account at the moment.",
          footnote: 'If you think this is a mistake, reply to this email and we\'ll take another look.',
        }),
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendAccessRequestEmail, sendAccessDecisionEmail };
