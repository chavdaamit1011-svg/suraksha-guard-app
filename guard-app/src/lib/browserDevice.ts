type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Browser identity survives closing a tab; auth tokens remain in session storage. */
export function browserDeviceId(
  persistent: StorageLike,
  tab: StorageLike,
  create: () => string,
): string {
  const key = 'sg.deviceId';
  const id = persistent.getItem(key) || tab.getItem(key) || create();
  // Migrate the ID of the already logged-in tab instead of creating another device.
  persistent.setItem(key, id);
  tab.setItem(key, id);
  return id;
}
