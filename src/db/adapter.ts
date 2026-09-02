import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { KiokukoError } from '../errors.js';

export type SqliteValue = null | number | bigint | string | NodeJS.ArrayBufferView;
export type SqliteRow = Record<string, unknown>;

export interface SqliteStatement {
  run(...parameters: SqliteValue[]): void;
  get<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T | undefined;
  all<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T[];
}

export interface SqliteDatabase {
  readonly filePath: string;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteSerializationDatabase {
  serializeDatabase(): Uint8Array;
}

class StatementAdapter implements SqliteStatement {
  constructor(private readonly statement: StatementSync) {}

  run(...parameters: SqliteValue[]): void {
    this.statement.run(...parameters);
  }

  get<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T | undefined {
    return this.statement.get(...parameters) as T | undefined;
  }

  all<T extends SqliteRow = SqliteRow>(...parameters: SqliteValue[]): T[] {
    return this.statement.all(...parameters) as T[];
  }
}

export class NodeSqliteAdapter implements SqliteDatabase, SqliteSerializationDatabase {
  constructor(
    readonly filePath: string,
    private readonly database: DatabaseSync,
  ) {}

  exec(sql: string): void {
    this.database.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new StatementAdapter(this.database.prepare(sql));
  }

  serializeDatabase(): Uint8Array {
    const database = this.database as DatabaseSync & { serialize?: () => Uint8Array };
    if (typeof database.serialize !== 'function') {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        'SQLite serialization requires Node.js 24.16.0 or newer; upgrade Node.js before backing up this database',
      );
    }
    return database.serialize();
  }

  close(): void {
    this.database.close();
  }
}
