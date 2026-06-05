import { registerPlugin } from '@capacitor/core';

const AUTO_CLEAR_DELAY_MS = 60_000;

const SecureClipboard = registerPlugin('SecureClipboard', {
  web: {
    copyWithAutoClear: async ({ text }) => {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(text || '');
      window.setTimeout(() => {
        navigator.clipboard.writeText('').catch(() => {});
      }, AUTO_CLEAR_DELAY_MS);
    },
  },
});

export async function secureClipboardCopy(text, label = 'Road Sage') {
  return SecureClipboard.copyWithAutoClear({
    text: text == null ? '' : String(text),
    label,
  });
}
