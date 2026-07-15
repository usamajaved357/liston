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
    await resend.emails.send({ from: config.resend.fromEmail, to, subject, html });
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

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
