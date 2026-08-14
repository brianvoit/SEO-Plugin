// Bundled Google OAuth client — REWRITTEN AT BUILD TIME, do not put real
// values here.
//
// This repo is public, so the shipped client's credentials cannot live in the
// source. scripts/build.mjs overwrites this file inside dist/<browser>/ using
// the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET environment variables (supplied
// by CI secrets). With those unset the build emits this file unchanged, and
// the extension behaves exactly as it always has: every user brings their own
// OAuth client via Setup → OAuth Client.
//
// The bundled client is only ever a DEFAULT. A user-entered client always
// wins — see googleOAuthCredentials() in bg-auth.js — which is both the escape
// hatch for anyone who wants their own Cloud project and the migration path
// once the shared client outgrows Google's 100-user cap for unverified apps.
//
// A note on "secret": a client secret shipped inside a distributed extension
// is extractable by anyone who installs it, and Google's own guidance treats
// installed-app secrets as non-confidential. It is here because Google's "Web
// application" client type (the only one whose redirect URI Chromium's
// launchWebAuthFlow can use) requires it — not because it protects anything.
// It gates nothing on its own: a third party holding it still cannot reach any
// user's data without that user completing a consent screen.
const BUNDLED_GOOGLE_CLIENT_ID = '';
const BUNDLED_GOOGLE_CLIENT_SECRET = '';
