// Host parsing and matching.
//
// Pure, like crypto.js and transfer.js — no chrome.* here, so `node --test`
// can exercise it directly. What an entry stores must line up exactly with what
// `new URL(details.url).host` produces in background.js, which is why the
// normalisation lives next to the matching rather than inside a form handler.

// Turn whatever the user typed into the form of host that onAuthRequired sees:
// "example.com", "example.com:8443", or the wildcard "*.example.com".
//
// Pasting a whole URL is the obvious thing to do and used to save a value that
// could never match, with nothing on screen to say so.
export function normalizeHost(input) {
  let s = String(input ?? "").trim();
  if (!s) return "";

  // A full URL: let the platform pick the authority out of it.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      return new URL(s).host.toLowerCase();
    } catch {
      // Malformed despite looking like a URL — fall through and strip by hand.
    }
  }

  // Wildcards are not URLs, so keep the prefix aside while cleaning the rest.
  const wildcard = s.startsWith("*.");
  if (wildcard) s = s.slice(2);

  s = s.replace(/^[^@/]*@/, ""); // user:pass@ credentials
  s = s.split(/[/?#]/)[0]; // path, query, fragment
  s = s.replace(/\.+$/, ""); // trailing dots on a FQDN
  s = s.toLowerCase();

  return wildcard && s ? "*." + s : s;
}

// True when an entry's host pattern covers the host of an actual request.
export function hostMatches(pattern, host) {
  if (pattern === host) return true;
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    // *.example.com matches a.example.com and example.com itself.
    return host === base || host.endsWith("." + base);
  }
  return false;
}
