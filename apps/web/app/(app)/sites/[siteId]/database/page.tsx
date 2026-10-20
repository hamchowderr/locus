import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import {
  ConnectError,
  LOGIN_SECRET_TABLES,
  type SiteBackendOverview,
  type SiteMediaFile,
  type SiteRestoreState,
  siteBackendOf,
  siteBackendOverview,
  siteFilesFolderName,
  siteFilesOverview,
  siteRestoreState,
} from "@locus/connect";
import { provisionerFromEnv } from "@locus/db";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Notice, Page } from "@/app/ui";
import { configured, connectDeps } from "@/lib/connect";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { siteNames } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { restoreDatabase, undoDatabaseRestore } from "./actions";

const PAGE_SIZE = 50;

/** Moments a restore can go back to: recent ones, then every hour back to the earliest. */
function restorePoints(earliest: Date, now: number): { value: number; label: string }[] {
  // A little slack at the far end, so a point is still there when the form is sent.
  const first = earliest.getTime() + 10 * 60_000;
  const back = [15, 30, ...Array.from({ length: 30 * 24 }, (_, i) => (i + 1) * 60)];
  const points = [];
  for (const minutes of back) {
    const value = now - minutes * 60_000;
    if (value < first) break;
    const ago =
      minutes < 60
        ? `${minutes} minutes ago`
        : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"} ago`;
    points.push({ value, label: `${ago} · ${when.format(new Date(value))} UTC` });
  }
  return points;
}

const when = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** One cell, as text: long values are cut, and binary data is only sized. */
function cell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `(${value.byteLength} bytes)`;
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

export default async function SiteDatabase({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{
    table?: string;
    page?: string;
    error?: string;
    restored?: string;
    undone?: string;
  }>;
}) {
  const { siteId } = await params;
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(`/sites/${siteId}/database`)}`);
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { table, page, error: actionError, restored, undone } = await searchParams;
  const client = await resolveActiveClient(locus().db, sessionContext(current)).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");
  const names = await siteNames(siteBuilderDeps(), client, [siteId]).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!names?.has(siteId)) notFound();
  const name = names.get(siteId) ?? "Site";

  const backend = await siteBackendOf(locus().db, client, siteId);
  let problem: string | null = null;
  let overview: SiteBackendOverview | null = null;
  const asked = page && /^\d{1,5}$/.test(page) ? Math.max(Number(page), 1) : 1;
  if (backend) {
    try {
      // Only the site's database is needed here: its registry row and Turso.
      const deps = {
        db: locus().db,
        provisioner: configured(() => provisionerFromEnv(".data/tenants")),
      };
      overview = await siteBackendOverview(
        deps,
        client,
        siteId,
        table && !LOGIN_SECRET_TABLES.has(table)
          ? { table, limit: PAGE_SIZE, offset: (asked - 1) * PAGE_SIZE }
          : undefined,
      );
    } catch (error) {
      if (error instanceof NotConfigured) {
        problem = "The site's database can't be reached on this deployment yet.";
      } else if (error instanceof ConnectError) {
        problem = error.message;
      } else {
        console.error("Reading a site's database failed", error);
        problem = "Locus couldn't read the site's database just now. Try again in a moment.";
      }
    }
  }
  // The site's uploaded files, from the client's Media Library: GHL can be unreachable while
  // the database works.
  let files: { files: SiteMediaFile[]; more: boolean } | null = null;
  let filesProblem: string | null = null;
  if (backend) {
    try {
      files = await siteFilesOverview(connectDeps(), client, { siteId });
    } catch (error) {
      if (error instanceof NotConfigured) {
        filesProblem = "HighLevel isn't connected on this deployment yet.";
      } else if (error instanceof ConnectError) {
        filesProblem = error.message;
      } else {
        console.error(`Listing a site's files failed: ${(error as Error)?.name ?? "Error"}`);
        filesProblem = "Locus couldn't list the site's files just now. Try again in a moment.";
      }
    }
  }
  let restore: SiteRestoreState | null = null;
  if (backend) restore = await siteRestoreState({ db: locus().db }, client, siteId);
  const now = Date.now();
  const points = restore ? restorePoints(restore.earliest, now) : [];
  const rows = overview?.rows ?? null;
  const shown = table && overview?.tables.some((t) => t.name === table) ? table : null;
  const pages = rows ? Math.max(Math.ceil(rows.total / PAGE_SIZE), 1) : 1;
  // A page past the end (an old link) still leads back to the last one.
  const pageNumber = Math.min(asked, pages);
  const link = (params: { table?: string; page?: number }) => {
    const query = new URLSearchParams();
    if (params.table) query.set("table", params.table);
    if (params.page && params.page > 1) query.set("page", String(params.page));
    const text = query.toString();
    return `/sites/${siteId}/database${text ? `?${text}` : ""}`;
  };

  return (
    <Page title={`Database · ${name}`}>
      <p className="text-sm">
        <Link href="/sites" className="underline">
          Sites
        </Link>
        {" · "}
        <Link href={`/sites/${siteId}/versions`} className="underline">
          Versions
        </Link>
      </p>
      {!backend && (
        <p className="text-neutral-600">
          This site has no database. The site builder adds one when the site needs member logins or
          keeps its own records, such as bookings. It is made the first time the site is published.
        </p>
      )}
      {problem && <Notice tone="error">{problem}</Notice>}
      {actionError && <Notice tone="error">{actionError}</Notice>}
      {(restored || undone) && (
        <Notice tone="info">
          {restored ? "The database was restored." : "The restore was undone."}{" "}
          {(restored ?? undone) === "live"
            ? "The live site switches over once its new deployment is ready, in a minute or two."
            : "The site uses it from its next publish."}
        </Notice>
      )}
      {overview && (
        <>
          <section className="space-y-2">
            <h2 className="font-semibold">People who signed up</h2>
            {overview.users.length === 0 ? (
              <p className="text-sm text-neutral-600">No one has signed up on the site yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {overview.users.map((user) => (
                  <li key={user.id} className="rounded-md border border-neutral-200 p-2">
                    <p>
                      <strong>{user.name || user.email}</strong>
                      {user.name && ` · ${user.email}`}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {user.emailVerified ? "Email confirmed" : "Email not confirmed"}
                      {user.createdAt && ` · Signed up ${when.format(user.createdAt)} UTC`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {overview.users.length >= 100 && (
              <p className="text-xs text-neutral-500">Showing the newest 100.</p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold">Tables</h2>
            {overview.tables.length === 0 ? (
              <p className="text-sm text-neutral-600">
                The database has no tables yet. They are made when the site is published.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {overview.tables.map((t) => (
                  <li key={t.name} className="rounded-md border border-neutral-200 p-2">
                    <p>
                      {LOGIN_SECRET_TABLES.has(t.name) ? (
                        <strong>{t.name}</strong>
                      ) : (
                        <Link href={link({ table: t.name })} className="font-semibold underline">
                          {t.name}
                        </Link>
                      )}
                      {t.rows === null
                        ? " · can't be read"
                        : ` · ${t.rows} ${t.rows === 1 ? "row" : "rows"}`}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {LOGIN_SECRET_TABLES.has(t.name)
                        ? "Login details: kept private."
                        : t.columns.map((c) => c.name).join(", ")}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-semibold">Files</h2>
            <p className="text-xs text-neutral-500">
              What members upload is kept in this client's Media Library, in the folder
              {` "${siteFilesFolderName(siteId)}"`}.
            </p>
            {filesProblem && <p className="text-sm text-neutral-600">{filesProblem}</p>}
            {files && files.files.length === 0 && (
              <p className="text-sm text-neutral-600">No one has uploaded a file yet.</p>
            )}
            {files && files.files.length > 0 && (
              <ul className="space-y-1 text-sm">
                {files.files.map((f) => (
                  <li key={f.id} className="flex justify-between gap-4">
                    <a href={f.url} className="truncate underline" rel="noreferrer" target="_blank">
                      {f.name}
                    </a>
                    {f.createdAt && (
                      <span className="shrink-0 text-xs text-neutral-500">
                        {when.format(f.createdAt)} UTC
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {files?.more && <p className="text-xs text-neutral-500">Showing the newest 100.</p>}
          </section>

          {shown && rows && (
            <section className="space-y-2">
              <h2 className="font-semibold">{shown}</h2>
              {rows.rows.length === 0 ? (
                <p className="text-sm text-neutral-600">
                  {rows.total === 0 ? "This table is empty." : "There are no rows on this page."}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="text-left text-xs">
                    <thead>
                      <tr>
                        {rows.columns.map((column) => (
                          <th key={column} className="border-b border-neutral-200 px-2 py-1">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.rows.map((row, i) => (
                        // Rows have no key of their own in general: their place on the page is it.
                        // biome-ignore lint/suspicious/noArrayIndexKey: see above
                        <tr key={i}>
                          {rows.columns.map((column) => (
                            <td
                              key={column}
                              className="border-b border-neutral-100 px-2 py-1 align-top"
                            >
                              {cell(row[column])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="flex gap-4 text-sm">
                {pageNumber > 1 && (
                  <Link href={link({ table: shown, page: pageNumber - 1 })} className="underline">
                    Previous
                  </Link>
                )}
                <span className="text-neutral-500">
                  Page {pageNumber} of {pages} · {rows.total} {rows.total === 1 ? "row" : "rows"}
                </span>
                {pageNumber < pages && (
                  <Link href={link({ table: shown, page: pageNumber + 1 })} className="underline">
                    Next
                  </Link>
                )}
              </p>
            </section>
          )}
        </>
      )}
      {restore && (
        <section className="space-y-2">
          <h2 className="font-semibold">Backups</h2>
          <p className="text-xs text-neutral-500">
            The database's history is kept for the last 24 hours, so it can go back to how it was at
            any of these times. Anything added after that time leaves the live site; the database it
            has now is kept so you can undo the restore.
          </p>
          {points.length === 0 ? (
            <p className="text-sm text-neutral-600">
              There's nothing to go back to yet: the database was only just made.
            </p>
          ) : (
            <form action={restoreDatabase} className="space-y-2 text-sm">
              <input type="hidden" name="siteId" value={siteId} />
              <label className="block">
                <span className="mr-2">Restore to</span>
                <select name="to" className="rounded-md border border-neutral-300 px-2 py-1">
                  {points.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="confirm" value="yes" required />
                <span>I understand sign-ups and changes after that time leave the live site.</span>
              </label>
              <button
                type="submit"
                className="rounded-md border border-neutral-300 px-3 py-1 font-medium"
              >
                Restore
              </button>
            </form>
          )}
          {restore.undo && (
            <form action={undoDatabaseRestore} className="space-y-1 text-sm">
              <input type="hidden" name="siteId" value={siteId} />
              <p className="text-neutral-600">
                Restored to {when.format(restore.undo.restoredTo)} UTC on{" "}
                {when.format(restore.undo.restoredAt)} UTC. Undoing it brings back the database from
                before, and drops anything added since the restore.
              </p>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="confirm" value="yes" required />
                <span>
                  I understand sign-ups and changes since the restore leave the live site.
                </span>
              </label>
              <button
                type="submit"
                className="rounded-md border border-neutral-300 px-3 py-1 font-medium"
              >
                Undo the restore
              </button>
            </form>
          )}
        </section>
      )}
    </Page>
  );
}
