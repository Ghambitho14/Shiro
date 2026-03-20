declare module "sql.js" {
	export interface SqlJsStatic {
		Database: typeof Database;
	}

	export class Database {
		constructor(data?: ArrayLike<number> | Buffer | null);
		run(sql: string, params?: unknown[]): void;
		exec(sql: string): QueryExecResult[];
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
	}

	export class Statement {
		bind(params?: unknown[]): boolean;
		step(): boolean;
		getAsObject(params?: unknown): Record<string, unknown>;
		free(): boolean;
		reset(): void;
	}

	export interface QueryExecResult {
		columns: string[];
		values: unknown[][];
	}

	export default function initSqlJs(config?: {
		locateFile?: (file: string) => string;
	}): Promise<SqlJsStatic>;
}