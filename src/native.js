// Thin wrapper around Chrome native messaging to the Touch ID host.

export const NATIVE_HOST = "com.tsuchida.basic_auth_autofill";

// Send one command to the native host and resolve with its JSON response.
// Rejects if the host is missing/not registered (chrome.runtime.lastError).
export function sendNative(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message || "native host error"));
          return;
        }
        resolve(resp);
      });
    } catch (e) {
      reject(e);
    }
  });
}
