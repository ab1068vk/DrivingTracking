import { initializePrivacyAudit } from '@/lib/hashChainLog';

// Imported before App's graph. Only constant-size fresh/control initialization;
// an unknown legacy value is never acquired, parsed or converted at bootstrap.
void initializePrivacyAudit().catch(() => undefined);
