"use client";

// Chrome (and Edge) offer "Save password?" when they see a login form
// submitted — but Liston logs in without a page load, which Chrome often
// doesn't count as a submit, so it never asked. After a successful login or
// sign-up the credentials are handed to the browser's password manager
// directly (Credential Management API), which shows the save prompt, or
// quietly updates a saved password that changed. Browsers without the API
// (Safari, Firefox) still go by the form's autocomplete attributes.

type PasswordCredentialCtor = new (data: { id: string; password: string; name?: string }) => Credential;

export async function offerToSaveLogin(email: string, password: string, name?: string) {
  try {
    const Ctor = (window as unknown as { PasswordCredential?: PasswordCredentialCtor }).PasswordCredential;
    if (!Ctor || !navigator.credentials?.store || !email || !password) return;
    const credential = new Ctor({ id: email, password, ...(name ? { name } : {}) });
    // Never hold up the login: the prompt shows while the next page loads.
    await Promise.race([navigator.credentials.store(credential), new Promise((resolve) => setTimeout(resolve, 800))]);
  } catch {
    // No password manager, or the user turned saving off: nothing to do.
  }
}
