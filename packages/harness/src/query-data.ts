/**
 * `query_data` — the read path, and the agent's ORM.
 *
 * The model asks for data sources, how they chain, and the SQL to run over them, in one call.
 * Code does the rest, so the failure modes of letting a model do it are gone:
 *
 * - it pages through every source itself — no stopping early because it has "enough";
 * - it carries IDs from one source to the next (`forEach`) — the model never sees the list,
 *   so it cannot drop anyone from it;
 * - it loads the rows into a throwaway in-memory database and runs the model's SQL — no
 *   arithmetic in the model's head;
 * - it returns only the SQL result.
 *
 * Anything it cannot do correctly fails loudly with a message the model can act on.
 */

import { createClient, type InValue } from "@libsql/client";
import { type GhlRateLimiter, type GhlRequestInput, type GhlSession, ghlRequest } from "@locus/ghl";
import { isRead, operationById, type SkillOperation } from "@locus/skills";

export interface QuerySource {
  /** Table name for this source's rows in the SQL. */
  as: string;
  /** Catalog operation id, e.g. `opportunities.search-opportunity`. Must be a read. */
  operation: string;
  params?: GhlRequestInput | undefined;
  /** Which response field holds the rows, when the response has more than one list. */
  rowsField?: string | undefined;
  /** Run once per distinct value of `column` in an earlier source, passed as `param`. */
  forEach?: { from: string; column: string; param: string } | undefined;
}

export interface QuerySpec {
  sources: QuerySource[];
  /** One SELECT (or WITH … SELECT) over the source tables. */
  sql: string;
}

export interface SourceReport {
  as: string;
  operation: string;
  rows: number;
  requests: number;
  /** False when GHL may hold more rows than were fetched; `note` says why. */
  complete: boolean;
  note?: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows the SQL produced; more than `rows.length` when the result was cut at the limit. */
  rowCount: number;
  truncated: boolean;
  sources: SourceReport[];
}

export interface QueryLimits {
  /** Rows requested per page. GHL caps most list endpoints at 100. */
  pageSize: number;
  /** Requests one source may make, pagination and fan-out included. */
  maxRequestsPerSource: number;
  /** Distinct values a `forEach` may fan out over. */
  maxFanOut: number;
  /** Rows returned to the model. */
  maxResultRows: number;
}

export const DEFAULT_LIMITS: QueryLimits = {
  pageSize: 100,
  maxRequestsPerSource: 50,
  maxFanOut: 100,
  maxResultRows: 200,
};

export interface QueryDeps {
  session: GhlSession;
  fetch?: typeof fetch;
  limits?: Partial<QueryLimits>;
  rateLimiter?: GhlRateLimiter | undefined;
}

/** A query the engine refuses or cannot answer correctly. The message is meant for the model. */
export class QueryError extends Error {
  override name = "QueryError";
}

type Row = Record<string, unknown>;

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export async function runQuery(spec: QuerySpec, deps: QueryDeps): Promise<QueryResult> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  if (spec.sources.length === 0) throw new QueryError("query_data needs at least one source");

  const tables = new Map<string, Row[]>();
  const reports: SourceReport[] = [];
  for (const source of spec.sources) {
    if (!TABLE_NAME.test(source.as)) {
      throw new QueryError(`"${source.as}" is not a valid table name (letters, digits, _)`);
    }
    if (tables.has(source.as)) throw new QueryError(`two sources are named "${source.as}"`);
    const { rows, report } = await fetchSource(source, tables, deps, limits);
    tables.set(source.as, rows);
    reports.push(report);
  }

  const result = await runSql(spec.sql, tables, limits.maxResultRows);
  return { ...result, sources: reports };
}

async function fetchSource(
  source: QuerySource,
  tables: Map<string, Row[]>,
  deps: QueryDeps,
  limits: QueryLimits,
): Promise<{ rows: Row[]; report: SourceReport }> {
  const op = operationById(source.operation);
  if (!op) throw new QueryError(`unknown operation "${source.operation}"`);
  if (!isRead(op)) {
    throw new QueryError(`${op.id} changes data — query_data only reads; use perform_action`);
  }
  rejectPaginationParams(op, source.params);

  const budget = { requests: 0 };
  if (!source.forEach) {
    const page = await fetchAllPages(op, source, source.params ?? {}, deps, limits, budget);
    return { rows: page.rows, report: report(source, page.rows, budget, page.incomplete) };
  }

  const { from, column, param } = source.forEach;
  const upstream = tables.get(from);
  if (!upstream) throw new QueryError(`forEach.from "${from}" is not an earlier source`);
  if (upstream.length > 0 && !upstream.some((row) => column in row)) {
    throw new QueryError(`source "${from}" has no column "${column}"`);
  }
  const where = parameterLocation(op, param);
  if (!where) {
    throw new QueryError(
      `not composable: ${op.id} takes no parameter "${param}" — ` +
        `its parameters are ${describeParams(op)}`,
    );
  }

  const keys = [...new Set(upstream.map((row) => row[column]).filter(isKey))].map(String);
  if (keys.length > limits.maxFanOut) {
    throw new QueryError(
      `forEach would call ${op.id} ${keys.length} times (limit ${limits.maxFanOut}); ` +
        `filter "${from}" first`,
    );
  }

  const rows: Row[] = [];
  let incomplete: string | undefined;
  for (const key of keys) {
    const params = withParam(source.params ?? {}, where, param, key);
    const page = await fetchAllPages(op, source, params, deps, limits, budget);
    for (const row of page.rows) rows.push({ _key: key, ...row });
    incomplete ??= page.incomplete;
  }
  return { rows, report: report(source, rows, budget, incomplete) };
}

async function fetchAllPages(
  op: SkillOperation,
  source: QuerySource,
  params: GhlRequestInput,
  deps: QueryDeps,
  limits: QueryLimits,
  budget: { requests: number },
): Promise<{ rows: Row[]; incomplete?: string }> {
  const call = async (input: GhlRequestInput): Promise<Row[]> => {
    budget.requests++;
    if (budget.requests > limits.maxRequestsPerSource) {
      throw new QueryError(
        `source "${source.as}" needs more than ${limits.maxRequestsPerSource} requests; ` +
          "narrow it with filters",
      );
    }
    const payload = await ghlRequest(op, deps.session, input, {
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      rateLimiter: deps.rateLimiter,
    });
    return extractRows(payload, source.rowsField, op.id);
  };

  const pagination = op.pagination;
  if (!pagination) {
    const rows = await call(params);
    // A POST search whose paging GHL does not document (contacts search is one) may hold more.
    return op.method === "POST" && rows.length > 0
      ? { rows, incomplete: `${op.id} has undocumented paging: first page only` }
      : { rows };
  }

  const size = limits.pageSize;
  if (pagination.style === "cursor") {
    const usesLimit = op.queryParams.includes("limit");
    const rows = await call(usesLimit ? withParam(params, "query", "limit", size) : params);
    const full = usesLimit ? rows.length >= size : rows.length > 0;
    return full
      ? { rows, incomplete: `${op.id} pages by cursor, which is not followed yet: first page only` }
      : { rows };
  }

  const rows: Row[] = [];
  let previous: string | undefined;
  for (let pageNumber = 1; ; pageNumber++) {
    const input =
      pagination.style === "offset"
        ? withParams(params, pagination.in, {
            [pagination.limit]: size,
            [pagination.offset]: rows.length,
          })
        : withParams(params, pagination.in, {
            [pagination.page]: pageNumber,
            ...(pagination.size ? { [pagination.size]: size } : {}),
          });
    const page = await call(input);

    // An endpoint that ignores its paging parameters returns the same page forever.
    const fingerprint = JSON.stringify(page);
    if (page.length === 0 || fingerprint === previous) break;
    previous = fingerprint;
    rows.push(...page);
    if (page.length < size && (pagination.style === "offset" || pagination.size)) break;
  }
  return { rows };
}

function report(
  source: QuerySource,
  rows: Row[],
  budget: { requests: number },
  incomplete: string | undefined,
): SourceReport {
  return {
    as: source.as,
    operation: source.operation,
    rows: rows.length,
    requests: budget.requests,
    complete: incomplete === undefined,
    ...(incomplete ? { note: incomplete } : {}),
  };
}

/**
 * The rows of a GHL response: the array itself, the named field, the one list in the object,
 * or — for a single-record response like `{ contact: {...} }` — that record.
 */
export function extractRows(payload: unknown, rowsField: string | undefined, opId: string): Row[] {
  if (Array.isArray(payload)) return payload.map(asRow);
  if (!payload || typeof payload !== "object") return payload === undefined ? [] : [asRow(payload)];
  const record = payload as Row;

  if (rowsField !== undefined) {
    const value = record[rowsField];
    if (Array.isArray(value)) return value.map(asRow);
    if (value && typeof value === "object") return [value as Row];
    throw new QueryError(
      `${opId} has no list "${rowsField}" — its fields are ${Object.keys(record).join(", ")}`,
    );
  }

  const lists = Object.entries(record).filter((entry): entry is [string, unknown[]] =>
    Array.isArray(entry[1]),
  );
  const [only] = lists;
  if (only && lists.length === 1) return only[1].map(asRow);
  if (lists.length > 1) {
    throw new QueryError(
      `${opId} returns several lists (${lists.map(([key]) => key).join(", ")}); set rowsField`,
    );
  }
  const objects = Object.entries(record).filter(
    ([key, value]) => key !== "meta" && value !== null && typeof value === "object",
  );
  if (objects.length === 1 && Object.keys(record).length <= 2) return [objects[0]?.[1] as Row];
  return [record];
}

function asRow(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : { value };
}

async function runSql(
  sql: string,
  tables: Map<string, Row[]>,
  maxRows: number,
): Promise<Omit<QueryResult, "sources">> {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (statement.includes(";")) throw new QueryError("sql must be a single statement");
  if (!/^(select|with)\b/i.test(statement)) throw new QueryError("sql must be a SELECT");

  const db = createClient({ url: ":memory:" });
  try {
    for (const [name, rows] of tables) await loadTable(db, name, rows);
    let result: Awaited<ReturnType<typeof db.execute>>;
    try {
      result = await db.execute(statement);
    } catch (error) {
      throw new QueryError(`sql failed: ${(error as Error).message}`);
    }
    const rows = result.rows.map((row) =>
      Object.fromEntries(result.columns.map((column, i) => [column, normalise(row[i])])),
    );
    return {
      columns: result.columns,
      rows: rows.slice(0, maxRows),
      rowCount: rows.length,
      truncated: rows.length > maxRows,
    };
  } finally {
    db.close();
  }
}

async function loadTable(
  db: ReturnType<typeof createClient>,
  name: string,
  rows: Row[],
): Promise<void> {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (columns.length === 0) columns.push("_empty");
  const quote = (id: string) => `"${id.replace(/"/g, '""')}"`;
  await db.execute(`CREATE TABLE ${quote(name)} (${columns.map(quote).join(", ")})`);
  if (rows.length === 0) return;

  const insert = `INSERT INTO ${quote(name)} (${columns.map(quote).join(", ")}) VALUES (${columns
    .map(() => "?")
    .join(", ")})`;
  await db.batch(
    rows.map((row) => ({ sql: insert, args: columns.map((column) => toSql(row[column])) })),
    "write",
  );
}

function toSql(value: unknown): InValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") {
    return value;
  }
  return JSON.stringify(value);
}

function normalise(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer) return "<binary>";
  return value;
}

function rejectPaginationParams(op: SkillOperation, params: GhlRequestInput | undefined): void {
  const p = op.pagination;
  if (!p || !params) return;
  const owned =
    p.style === "offset"
      ? [p.limit, p.offset]
      : p.style === "page"
        ? [p.page, ...(p.size ? [p.size] : [])]
        : p.params;
  const given = p.in === "query" ? params.query : params.body;
  const clash = owned.filter((name) => given && name in given);
  if (clash.length > 0) {
    throw new QueryError(`query_data pages ${op.id} itself; remove ${clash.join(", ")}`);
  }
}

function parameterLocation(op: SkillOperation, param: string): "path" | "query" | undefined {
  if ((op.sessionParams ?? []).some((p) => p.name === param)) return undefined;
  if (op.path.includes(`{${param}}`)) return "path";
  if (op.queryParams.includes(param)) return "query";
  return undefined;
}

function describeParams(op: SkillOperation): string {
  const session = new Set((op.sessionParams ?? []).map((p) => p.name));
  const path = [...op.path.matchAll(/\{([^}]+)\}/g)]
    .map((m) => m[1] as string)
    .filter((name) => !session.has(name));
  const all = [...path, ...op.queryParams];
  return all.length > 0 ? all.join(", ") : "none";
}

function withParam(
  params: GhlRequestInput,
  where: "path" | "query",
  name: string,
  value: string | number,
): GhlRequestInput {
  return where === "path"
    ? { ...params, path: { ...params.path, [name]: String(value) } }
    : { ...params, query: { ...params.query, [name]: value } };
}

function withParams(
  params: GhlRequestInput,
  where: "query" | "body",
  values: Record<string, number>,
): GhlRequestInput {
  return where === "query"
    ? { ...params, query: { ...params.query, ...values } }
    : { ...params, body: { ...params.body, ...values } };
}

function isKey(value: unknown): value is string | number {
  return (typeof value === "string" && value !== "") || typeof value === "number";
}
