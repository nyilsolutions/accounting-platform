import { Logger } from '@nestjs/common';

/**
 * Security events that aren't audit rows (ASVS 7.2.1, 7.2.2): refused access, failed sign-ins to
 * unknown accounts, rejected input. One warn line each under the "Security" context, tagged by
 * the JSON logger with the request, user and trace ids, so they can be searched and alerted on
 * (12d). Never pass values: ids, permission names and field paths only.
 */
const logger = new Logger('Security');

export function securityEvent(event: string, details: Record<string, string | null> = {}): void {
  const fields = Object.entries(details)
    .map(([k, v]) => `${k}=${v ?? '-'}`)
    .join(' ');
  logger.warn(fields ? `${event} ${fields}` : event);
}
