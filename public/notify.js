// Notifications: native OS notifications in the desktop app (via the Electron
// preload bridge), the Web Notifications API in a browser.

export function permissionState() {
  if (window.harnessDesktop) return 'desktop';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // granted | denied | default
}

export async function requestPermission() {
  if (window.harnessDesktop || !('Notification' in window)) return permissionState();
  try { return await Notification.requestPermission(); } catch { return permissionState(); }
}

export function notify({ title, body = '', conversationId, onClick }) {
  if (window.harnessDesktop) {
    window.harnessDesktop.notify({ title, body, hash: conversationId ? `#/c/${conversationId}` : null });
    return;
  }
  if (permissionState() !== 'granted') return;
  try {
    const n = new Notification(title, { body: body.slice(0, 240), tag: conversationId || undefined });
    n.onclick = () => { window.focus(); onClick?.(); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}
