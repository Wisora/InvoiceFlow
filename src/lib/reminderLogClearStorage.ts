const CLEAR_STORAGE_PREFIX = 'invoiceflow_reminder_log_cleared_at:';

export function getReminderLogClearedAt(organizationId: string): string | null {
  if (typeof window === 'undefined' || !organizationId) return null;
  try {
    return window.localStorage.getItem(`${CLEAR_STORAGE_PREFIX}${organizationId}`);
  } catch {
    return null;
  }
}

export function setReminderLogClearedAt(organizationId: string, isoTimestamp: string | null): void {
  if (typeof window === 'undefined' || !organizationId) return;
  try {
    const key = `${CLEAR_STORAGE_PREFIX}${organizationId}`;
    if (!isoTimestamp) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, isoTimestamp);
    }
  } catch {
    // Ignore storage quota or privacy-mode errors
  }
}