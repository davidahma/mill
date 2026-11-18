import { DatabaseSync } from "node:sqlite";

import { ExitCode, MillError } from "../errors.js";

export const CURRENT_STATE_SCHEMA_VERSION = 4;

export interface AppliedStateMigration {
  version: number;
  name: string;
  appliedAt: string;
}

interface StateMigration {
  version: number;
  name: string;
  apply(database: DatabaseSync): void;
}

function createInitialTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_digest TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      worktree_path TEXT,
      context_digest TEXT,
      context_json TEXT,
      control_json TEXT,
      candidate_commit TEXT,
      candidate_tree TEXT,
      deadline_at TEXT NOT NULL,
      active_process_id TEXT,
      active_pid INTEGER,
      active_process_group INTEGER,
      active_process_identity TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
      repair_count INTEGER NOT NULL DEFAULT 0 CHECK(repair_count BETWEEN 0 AND 1),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2),
      block_code TEXT,
      validation_json TEXT,
      review_json TEXT,
      delivery_json TEXT,
      remote_feedback_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES runs(id),
      occurred_at TEXT NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS baseline_qualifications (
      approval_digest TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      task_digest TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS run_events_no_update
      BEFORE UPDATE ON run_events BEGIN SELECT RAISE(ABORT, 'run events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS run_events_no_delete
      BEFORE DELETE ON run_events BEGIN SELECT RAISE(ABORT, 'run events are append-only'); END;
  `);
  createWorkerInvocationTables(database);
}

function createWorkerInvocationTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS worker_invocations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      phase TEXT NOT NULL,
      envelope_digest TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS worker_invocation_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id TEXT NOT NULL REFERENCES worker_invocations(id),
      occurred_at TEXT NOT NULL,
      type TEXT NOT NULL,
      data_json TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS worker_invocations_no_update
      BEFORE UPDATE ON worker_invocations BEGIN SELECT RAISE(ABORT, 'worker invocations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS worker_invocations_no_delete
      BEFORE DELETE ON worker_invocations BEGIN SELECT RAISE(ABORT, 'worker invocations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS worker_invocation_events_no_update
      BEFORE UPDATE ON worker_invocation_events BEGIN SELECT RAISE(ABORT, 'worker invocation events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS worker_invocation_events_no_delete
      BEFORE DELETE ON worker_invocation_events BEGIN SELECT RAISE(ABORT, 'worker invocation events are append-only'); END;
  `);
}

function columnNames(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
        name: string;
      }[]
    ).map((column) => column.name),
  );
}

function addV2RunColumns(database: DatabaseSync): void {
  const columns = columnNames(database, "runs");
  for (const column of [
    "active_process_id TEXT",
    "active_process_group INTEGER",
    "active_process_identity TEXT",
    "delivery_json TEXT",
    "remote_feedback_json TEXT",
  ]) {
    const [name] = column.split(" ");
    if (name !== undefined && !columns.has(name)) {
      database.exec(`ALTER TABLE runs ADD COLUMN ${column}`);
    }
  }
  createWorkerInvocationTables(database);
}

function expandRepairCount(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE runs_v4 (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_digest TEXT NOT NULL,
      config_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      worktree_path TEXT,
      context_digest TEXT,
      context_json TEXT,
      control_json TEXT,
      candidate_commit TEXT,
      candidate_tree TEXT,
      deadline_at TEXT NOT NULL,
      active_process_id TEXT,
      active_pid INTEGER,
      active_process_group INTEGER,
      active_process_identity TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
      repair_count INTEGER NOT NULL DEFAULT 0 CHECK(repair_count BETWEEN 0 AND 2),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 2),
      block_code TEXT,
      validation_json TEXT,
      review_json TEXT,
      delivery_json TEXT,
      remote_feedback_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO runs_v4 (
      id, repository_id, task_id, task_digest, config_digest, status, base_commit,
      worktree_path, context_digest, context_json, control_json, candidate_commit,
      candidate_tree, deadline_at, active_process_id, active_pid,
      active_process_group, active_process_identity, cancel_requested, repair_count,
      attempt_count, block_code, validation_json, review_json, delivery_json,
      remote_feedback_json, created_at, updated_at
    ) SELECT
      id, repository_id, task_id, task_digest, config_digest, status, base_commit,
      worktree_path, context_digest, context_json, control_json, candidate_commit,
      candidate_tree, deadline_at, active_process_id, active_pid,
      active_process_group, active_process_identity, cancel_requested, repair_count,
      attempt_count, block_code, validation_json, review_json, delivery_json,
      remote_feedback_json, created_at, updated_at
    FROM runs;
    DROP TABLE runs;
    ALTER TABLE runs_v4 RENAME TO runs;
  `);
}

const stateMigrations: readonly StateMigration[] = [
  {
    version: 1,
    name: "initial-durable-state",
    apply: createInitialTables,
  },
  {
    version: 2,
    name: "worker-and-delivery-recovery-columns",
    apply: addV2RunColumns,
  },
  {
    version: 3,
    name: "numbered-migration-ledger",
    apply: () => undefined,
  },
  {
    version: 4,
    name: "fixture-only-second-repair-capacity",
    apply: expandRepairCount,
  },
];

export function stateSchemaVersion(database: DatabaseSync): number {
  const hasOperationalTables = (): boolean =>
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name IN ('runs', 'run_events', 'worker_invocations', 'baseline_qualifications') LIMIT 1",
      )
      .get() !== undefined;
  const metadata = database
    .prepare(
      "SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'metadata'",
    )
    .get() as { present: number } | undefined;
  if (metadata?.present !== 1) {
    if (hasOperationalTables())
      throw new MillError(
        "STATE_SCHEMA_INVARIANT_FAILED",
        "Operational state has lost its schema metadata.",
        ExitCode.configuration,
      );
    return 0;
  }
  const row = database
    .prepare("SELECT value FROM metadata WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  if (row === undefined) {
    if (hasOperationalTables())
      throw new MillError(
        "STATE_SCHEMA_INVARIANT_FAILED",
        "Operational state has lost its schema version.",
        ExitCode.configuration,
      );
    return 0;
  }
  if (!/^[1-9][0-9]*$/u.test(row.value)) {
    throw new MillError(
      "UNSUPPORTED_STATE_SCHEMA",
      "Operational state uses an invalid schema version.",
      ExitCode.configuration,
    );
  }
  const version = Number(row.value);
  if (
    !Number.isSafeInteger(version) ||
    version > CURRENT_STATE_SCHEMA_VERSION
  ) {
    throw new MillError(
      "UNSUPPORTED_STATE_SCHEMA",
      "Operational state uses an unsupported schema version.",
      ExitCode.configuration,
    );
  }
  return version;
}

function recordMigration(
  database: DatabaseSync,
  migration: StateMigration,
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
       VALUES (?, ?, ?)`,
    )
    .run(migration.version, migration.name, new Date().toISOString());
  const stored = database
    .prepare("SELECT name FROM schema_migrations WHERE version = ?")
    .get(migration.version) as { name: string } | undefined;
  if (stored?.name !== migration.name) {
    throw new MillError(
      "STATE_MIGRATION_CONFLICT",
      "Operational state contains a conflicting recorded migration.",
      ExitCode.configuration,
    );
  }
}

function updateSchemaVersion(database: DatabaseSync, version: number): void {
  database
    .prepare(
      `INSERT INTO metadata(key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(version));
}

function applyMigration(
  database: DatabaseSync,
  migration: StateMigration,
): void {
  migration.apply(database);
  recordMigration(database, migration);
  updateSchemaVersion(database, migration.version);
}

function hasRecordedMigration(
  database: DatabaseSync,
  version: number,
): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM schema_migrations WHERE version = ?")
    .get(version) as { present: number } | undefined;
  return row?.present === 1;
}

function validateRecordedMigrations(
  database: DatabaseSync,
  current: number,
): void {
  const records = database
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC")
    .all() as unknown as { version: number; name: string }[];
  for (const record of records) {
    const migration = stateMigrations.find(
      (candidate) => candidate.version === record.version,
    );
    if (migration?.name !== record.name || record.version > current) {
      throw new MillError(
        "STATE_MIGRATION_CONFLICT",
        "Operational state contains an incompatible recorded migration.",
        ExitCode.configuration,
      );
    }
  }
}

export function applyStateMigrations(database: DatabaseSync): void {
  let transactionStarted = false;
  let foreignKeysDisabled = false;
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    foreignKeysDisabled = true;
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    database.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const current = stateSchemaVersion(database);
    validateRecordedMigrations(database, current);
    if (current === CURRENT_STATE_SCHEMA_VERSION) {
      assertCurrentStateMigrations(database);
    } else {
      for (const migration of stateMigrations) {
        if (migration.version <= current) {
          recordMigration(database, migration);
          continue;
        }
        applyMigration(database, migration);
      }
      // The oldest supported fixtures predate append-only run-event triggers.
      // Bring them forward; an existing same-named object is never overwritten.
      createInitialTables(database);
      assertCurrentStateMigrations(database);
    }
    const foreignKeyViolations = database
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (foreignKeyViolations.length > 0) {
      throw new MillError(
        "STATE_MIGRATION_FOREIGN_KEY_FAILURE",
        "Operational state migration produced an invalid foreign-key reference.",
        ExitCode.data,
      );
    }
    database.exec("COMMIT");
    transactionStarted = false;
    database.exec("PRAGMA foreign_keys = ON");
    foreignKeysDisabled = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original migration failure is authoritative.
      }
    }
    if (error instanceof MillError) throw error;
    throw new MillError(
      "STATE_MIGRATION_FAILED",
      "Operational state migration failed.",
      ExitCode.io,
      { cause: String(error) },
    );
  } finally {
    if (foreignKeysDisabled) database.exec("PRAGMA foreign_keys = ON");
  }
}

export function stateMigrationHistory(
  database: DatabaseSync,
): AppliedStateMigration[] {
  return database
    .prepare(
      `SELECT version, name, applied_at
       FROM schema_migrations ORDER BY version ASC`,
    )
    .all()
    .map((row) => {
      const record = row as {
        version: number;
        name: string;
        applied_at: string;
      };
      return {
        version: record.version,
        name: record.name,
        appliedAt: record.applied_at,
      };
    });
}

export function assertCurrentStateMigrations(database: DatabaseSync): void {
  assertPhysicalStateSchema(database);
  validateRecordedMigrations(database, CURRENT_STATE_SCHEMA_VERSION);
  for (const migration of stateMigrations) {
    if (!hasRecordedMigration(database, migration.version)) {
      throw new MillError(
        "STATE_MIGRATION_INCOMPLETE",
        "Operational state is missing a recorded migration.",
        ExitCode.configuration,
      );
    }
  }
}

const physicalSchemas = new Map<number, ReadonlyMap<string, string>>();

function normalizeSchemaSql(sql: string): string {
  return sql
    .replaceAll(/\bIF NOT EXISTS\b/giu, "")
    .replaceAll(/"([a-z_][a-z0-9_]*)"/giu, "$1")
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\s*([(),;])\s*/gu, "$1")
    .replace(/;$/u, "")
    .trim()
    .toLowerCase();
}

function readPhysicalSchema(database: DatabaseSync): Map<string, string> {
  const objects = database
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as unknown as { type: string; name: string; sql: string }[];
  return new Map(
    objects.map((object) => [
      `${object.type}:${object.name}`,
      normalizeSchemaSql(object.sql),
    ]),
  );
}

/** Same physical contract for current mutating/diagnostic opens and restore. */
function physicalSchema(version: number): ReadonlyMap<string, string> {
  let expected = physicalSchemas.get(version);
  if (expected === undefined) {
    const reference = new DatabaseSync(":memory:", { allowExtension: false });
    try {
      reference.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
      `);
      for (const migration of stateMigrations) {
        if (migration.version <= version) migration.apply(reference);
      }
      expected = readPhysicalSchema(reference);
      physicalSchemas.set(version, expected);
    } finally {
      reference.close();
    }
  }
  return expected;
}

/** Physical restore validation also recognizes exact supported historical layouts. */
export function assertPhysicalStateSchema(
  database: DatabaseSync,
  version = CURRENT_STATE_SCHEMA_VERSION,
): void {
  const expected = physicalSchema(version);
  const actual = readPhysicalSchema(database);
  const required = new Map(
    [...expected].filter(
      ([object]) =>
        !(version < 3 && object === "table:schema_migrations") &&
        !(version === 1 && object.includes("worker_invocation")),
    ),
  );
  const unexpected = [...actual].filter(
    ([object, sql]) =>
      !required.has(object) &&
      !(
        object.startsWith("trigger:") &&
        /\bbegin select raise\(abort,'(?:[^']|'')*'\);end$/u.test(sql)
      ),
  );
  // An additional abort-only trigger can deny a write but cannot suppress the
  // journal or weaken the required constraints. Other objects need migration.
  if (unexpected.length > 0) {
    throw new MillError(
      "STATE_SCHEMA_INVARIANT_FAILED",
      "Operational state has missing or unexpected physical schema objects.",
      ExitCode.configuration,
    );
  }
  for (const [object, sql] of required) {
    const alternatives = [sql];
    if (object === "table:runs" && version < CURRENT_STATE_SCHEMA_VERSION) {
      // The original v1 layout had no numeric CHECKs and acquired v2 columns
      // through ALTER TABLE. Admit only those recorded layouts, never an
      // arbitrary weaker definition that merely has the same object name.
      const additions = [
        "active_process_id text",
        "active_process_group integer",
        "active_process_identity text",
        "delivery_json text",
        "remote_feedback_json text",
      ];
      let legacy = physicalSchema(1).get("table:runs") ?? "";
      for (const column of additions) legacy = legacy.replace(`${column},`, "");
      legacy = legacy
        .replace(" check(cancel_requested in(0,1))", "")
        .replace(" check(repair_count between 0 and 1)", "")
        .replace(" check(attempt_count between 0 and 2)", "");
      alternatives.push(
        version === 1
          ? legacy
          : legacy.replace(")strict", `,${additions.join(",")})strict`),
      );
      // A backup may already carry the current table shape while retaining an
      // older ledger. Its exact current constraints must still match.
      alternatives.push(
        physicalSchema(CURRENT_STATE_SCHEMA_VERSION).get(object) ?? "",
      );
    }
    if (!alternatives.includes(actual.get(object) ?? "")) {
      throw new MillError(
        "STATE_SCHEMA_INVARIANT_FAILED",
        "Operational state is missing or has changed a required physical schema invariant.",
        ExitCode.configuration,
        { object },
      );
    }
  }
}
