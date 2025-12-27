// src/lib/notificationsEvents.ts
type Listener = () => void;

const listeners = new Set<Listener>();

export function emitNotificationsChanged() {
  for (const fn of listeners) fn();
}

export function onNotificationsChanged(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
