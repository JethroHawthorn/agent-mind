import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
/** Additive extension; existing broker/core migrations and historical records are retained. */
export function migrateBrokerSecurityAudit(db: Database.Database) {
  db.transaction(() =>
    db.exec(`CREATE TABLE IF NOT EXISTS broker_security_events(
 id TEXT PRIMARY KEY, audit_id TEXT NOT NULL UNIQUE REFERENCES broker_audit(id),
 request_id TEXT, channel TEXT NOT NULL CHECK(channel IN ('agent','operator')),
 action TEXT NOT NULL, version_id TEXT, content_digest TEXT, evaluation_id TEXT,
 review_digest TEXT, failure_code TEXT, policy_version TEXT NOT NULL, deployment_id TEXT NOT NULL
 );
 CREATE TRIGGER IF NOT EXISTS broker_security_no_update BEFORE UPDATE ON broker_security_events BEGIN SELECT RAISE(ABORT,'immutable broker security audit'); END;
 CREATE TRIGGER IF NOT EXISTS broker_security_no_delete BEFORE DELETE ON broker_security_events BEGIN SELECT RAISE(ABORT,'immutable broker security audit'); END;
 CREATE TRIGGER IF NOT EXISTS broker_security_no_replace BEFORE INSERT ON broker_security_events WHEN EXISTS(SELECT 1 FROM broker_security_events WHERE id=NEW.id OR audit_id=NEW.audit_id) BEGIN SELECT RAISE(ABORT,'immutable broker security audit'); END;`),
  ).immediate();
}
export type SecurityAuditContext = {
  deployment_id?: string;
  request_id?: string;
  channel: 'agent' | 'operator';
  action: string;
  version_id?: string;
  content_digest?: string;
  evaluation_id?: string;
  review_digest?: string;
  failure_code?: string;
};
export function persistSecurityAudit(
  db: Database.Database,
  auditId: string,
  c: SecurityAuditContext,
) {
  db.prepare('INSERT INTO broker_security_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
    randomUUID(),
    auditId,
    c.request_id ?? null,
    c.channel,
    c.action,
    c.version_id ?? null,
    c.content_digest ?? null,
    c.evaluation_id ?? null,
    c.review_digest ?? null,
    c.failure_code ?? null,
    'os-peer-operator-v2',
    c.deployment_id ?? 'unverified-unit-fixture',
  );
}
