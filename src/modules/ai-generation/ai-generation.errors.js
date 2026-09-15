class AiGenerationError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    // Every message here is written for the seller ("that page may have been
    // removed", "AI drafting isn't configured") — masking it as "Internal
    // server error" hid the real cause of a failed draft. Confirmed live.
    this.expose = true;
  }
}

module.exports = { AiGenerationError };
