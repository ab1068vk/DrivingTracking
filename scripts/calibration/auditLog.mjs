import { appendFile, readFile } from 'node:fs/promises';
import { auditLogPath } from './paths.mjs';

export async function appendAuditEntry(entry) {
  await appendFile(auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readLastAuditEntry() {
  try {
    const raw = await readFile(auditLogPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}
