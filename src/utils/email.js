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

function sendVerificationEmail(to, link) {
  return sendEmail({
    to,
    subject: 'Verify your Liston email',
    html: `<p>Welcome to Liston — confirm your email to get started.</p>
           <p><a href="${link}">Verify your email</a></p>
           <p>This link expires in 24 hours.</p>`,
  });
}

function sendPasswordResetEmail(to, link) {
  return sendEmail({
    to,
    subject: 'Reset your Liston password',
    html: `<p>Click below to choose a new password.</p>
           <p><a href="${link}">Reset your password</a></p>
           <p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>`,
  });
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// To the admin(s): someone wants in. One click either way.
function sendAccessRequestEmail(to, { applicantEmail, applicantName, note, approveLink, rejectLink, emailVerified }) {
  return sendEmail({
    to,
    subject: `Liston access request — ${applicantEmail}`,
    html: `<p><strong>${escape(applicantName || applicantEmail)}</strong> (${escape(applicantEmail)}) has asked for access to Liston.</p>
           <table style="border-collapse:collapse;font-size:14px;margin:8px 0 12px">
             <tr><td style="padding:3px 12px 3px 0;color:#888">Name</td><td>${escape(applicantName || '—')}</td></tr>
             <tr><td style="padding:3px 12px 3px 0;color:#888">Email</td><td>${escape(applicantEmail)}</td></tr>
             <tr><td style="padding:3px 12px 3px 0;color:#888">Email verified</td><td>${emailVerified ? 'yes' : 'not yet — approving will accept it'}</td></tr>
           </table>
           ${note ? `<p style="margin:0 0 4px;color:#888;font-size:13px">About their business</p><blockquote style="border-left:3px solid #ccc;margin:0 0 12px;padding:6px 12px;color:#444">${escape(note)}</blockquote>` : '<p style="color:#888;font-size:13px">No note left.</p>'}
           <p>
             <a href="${approveLink}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Approve</a>
             &nbsp;&nbsp;
             <a href="${rejectLink}" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Reject</a>
           </p>
           <p style="color:#888;font-size:12px">Links are valid for 7 days.</p>`,
  });
}

function sendAccessDecisionEmail(to, { approved, loginLink }) {
  return sendEmail({
    to,
    subject: approved ? "You're in — your Liston access is approved" : 'About your Liston access request',
    html: approved
      ? `<p>Your access request has been approved. You can log in and connect your eBay account now.</p>
         <p><a href="${loginLink}">Log in to Liston</a></p>`
      : `<p>Thanks for your interest in Liston. We're not able to open access for this account at the moment.</p>`,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendAccessRequestEmail, sendAccessDecisionEmail };
