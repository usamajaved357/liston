// Turns a failed Zod check into one sentence a seller can act on: which
// field, and what to do ("Variation 3's price is empty. Enter a price.")
// rather than Zod's own wording ("String must contain at least 1
// character(s)"). `label(path, body)` names the field from its path; the
// request body is only read to name things (an option being renamed),
// never echoed wholesale.

function describeIssue(issue, name) {
  switch (issue.code) {
    case 'too_small':
      if (issue.type === 'string') return `${name} is empty. Fill it in to save.`;
      if (issue.type === 'array') return `${name} needs at least ${issue.minimum}.`;
      return `${name} must be at least ${issue.minimum}.`;
    case 'too_big':
      // Custom limits already read well ("eBay titles are limited to 80 characters").
      if (!/^(String|Array|Number) must/.test(issue.message)) return issue.message;
      if (issue.type === 'string') return `${name} is too long (at most ${issue.maximum} characters).`;
      return `${name} can have at most ${issue.maximum}.`;
    case 'invalid_type':
      return issue.received === 'undefined' ? `${name} is missing.` : `${name} isn't in the right format.`;
    case 'invalid_string':
      return issue.validation === 'url' ? `${name} isn't a working image link. Remove it or upload the photo again.` : `${name} isn't valid.`;
    case 'invalid_enum_value':
      return `${name} must be one of: ${issue.options.join(', ')}.`;
    default:
      return issue.message && !/^(String|Array|Number|Invalid|Required)/.test(issue.message) ? issue.message : `${name} isn't valid.`;
  }
}

/** The first issue as a sentence, plus its path (for logs: no values). */
function validationMessage(error, body, label) {
  const issue = error.issues[0];
  const path = issue.path;
  if (!path.length) return { message: issue.message, path: '' };
  return { message: describeIssue(issue, label(path, body || {})), path: path.join('.') };
}

module.exports = { validationMessage };
