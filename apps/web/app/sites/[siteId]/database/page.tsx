import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import {
  ConnectError,
  LOGIN_SECRET_TABLES,
  type SiteBackendOverview,
  type StoredSiteFile,
  siteBackendOf,
  siteBackendOverview,
  siteFilesFolder,
  siteFilesOverview,
} from "@locus/connect";
import { provisionerFromEnv } from "@locus/db";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { configured } from "@/lib/connect";
import { currentSession, locus, NotConfigured, sessionContext } from "@/lib/locus";
import { siteNames } from "@/lib/site-builder";
import { siteBuilderDeps } from "@/lib/site-builder-host";
import { siteFileStore } from "@/lib/site-files";
import { Notice, Page } from "../../../ui";

const PAGE_SIZE = 50;

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

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function SiteDatabase({
  params,
  searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ table?: string; page?: string }>;
}) {
  const { siteId } = await params;
  const current = await currentSession();
  if (!current) redirect(`/sign-in?next=${encodeURIComponent(`/sites/${siteId}/database`)}`);
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const { table, page } = await searchParams;
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
  // The site's uploaded files, separately: storage can be missing while the database works.
  let files: { files: StoredSiteFile[]; more: boolean } | null = null;
  let filesProblem: string | null = null;
  if (backend) {
    try {
      const listed = await siteFilesOverview({ db: locus().db, store: siteFileStore() }, client, {
        siteId,
      });
      files = { files: listed.files, more: listed.cursor !== null };
    } catch (error) {
      if (error instanceof NotConfigured) {
        filesProblem = "File storage isn't set up on this deployment yet.";
      } else {
        console.error("Listing a site's files failed", error);
        filesProblem = "Locus couldn't list the site's files just now. Try again in a moment.";
      }
    }
  }
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
                      {` · ${t.rows} ${t.rows === 1 ? "row" : "rows"}`}
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
            {filesProblem && <p className="text-sm text-neutral-600">{filesProblem}</p>}
            {files && files.files.length === 0 && (
              <p className="text-sm text-neutral-600">No one has uploaded a file yet.</p>
            )}
            {files && files.files.length > 0 && (
              <ul className="space-y-1 text-sm">
                {files.files.map((f) => (
                  <li key={f.pathname} className="flex justify-between gap-4">
                    <span className="truncate">
                      {f.pathname.slice(siteFilesFolder(siteId).length).replace(/^[^/]+\//, "")}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {size(f.size)} · {when.format(f.uploadedAt)} UTC
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {files?.more && <p className="text-xs text-neutral-500">Showing the first 100.</p>}
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
    </Page>
  );
}
