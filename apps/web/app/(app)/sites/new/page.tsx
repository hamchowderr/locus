import { ClientAccessDenied, resolveActiveClient } from "@locus/auth";
import {
  DESIGN_QUESTIONS,
  FONT_PRESETS,
  MAX_SCREENSHOT_BYTES,
  PALETTE_PRESETS,
  SITE_KINDS,
  TEMPLATES,
} from "@locus/studio";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createSite } from "@/app/actions";
import { Button, Field, Notice, Page } from "@/app/ui";
import { currentSession, locus, sessionContext } from "@/lib/locus";

const KIND_LABELS: Record<(typeof SITE_KINDS)[number], string> = {
  website: "Website",
  "landing-page": "Landing page",
  funnel: "Funnel",
  app: "App",
  "internal-tool": "Internal tool",
};

/** A new site: its name, kind and template, and optional starting points. */
export default async function NewSite({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const current = await currentSession();
  if (!current) redirect("/sign-in?next=%2Fsites%2Fnew");
  if (!current.session.activeOrganizationId) redirect("/onboarding");
  const client = await resolveActiveClient(locus().db, sessionContext(current)).catch((e) => {
    if (e instanceof ClientAccessDenied) return null;
    throw e;
  });
  if (!client) redirect("/clients");
  const { error } = await searchParams;

  return (
    <Page
      title="New site"
      description="Locus starts it from a template. Then you shape it in the site's chat, with its preview beside you."
    >
      {error && <Notice tone="error">{error}</Notice>}
      {!client.location.siteBuilder ? (
        <Notice tone="info">
          The site builder is turned off for this sub-account. An owner or admin can turn it on on
          the{" "}
          <Link href="/clients" className="underline">
            Sub-accounts
          </Link>{" "}
          page.
        </Notice>
      ) : (
        <form action={createSite} className="space-y-4">
          <Field
            label="Name"
            name="name"
            placeholder="Bright Smiles Dental"
            required
            maxLength={120}
          />
          <label className="block text-sm">
            <span className="text-neutral-700">Kind</span>
            <select name="kind" defaultValue="website" className={SELECT}>
              {SITE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-neutral-700">Template</span>
            <select name="templateId" defaultValue="" className={SELECT}>
              <option value="">The one that fits the kind</option>
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}: {t.summary}
                </option>
              ))}
            </select>
          </label>
          <StartingPoints />
          <Button>Create site</Button>
        </form>
      )}
    </Page>
  );
}

const SELECT = "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base";
const options = (id: string) => DESIGN_QUESTIONS.find((q) => q.id === id)?.options ?? [];

/**
 * Optional starting points for a new site: the guided design questions, a site the person
 * likes and a screenshot. The builder asks in the chat for anything left out.
 */
function StartingPoints() {
  return (
    <details className="space-y-3 rounded-md border border-neutral-200 p-3 text-sm">
      <summary className="cursor-pointer text-neutral-700">
        Describe it, or start from a site you like (optional)
      </summary>
      <label className="block">
        <span className="text-neutral-700">What should the site do?</span>
        <textarea
          name="description"
          rows={3}
          maxLength={4000}
          placeholder="A friendly site for a family dental practice that gets people to book a cleaning."
          className={SELECT}
        />
      </label>
      <Choice name="goal" label="What should a visitor do?" choices={options("goal")} />
      <Choice name="audience" label="Who is it for?" choices={options("audience")} />
      <Choice name="palette" label="Colours" choices={Object.keys(PALETTE_PRESETS)} />
      <Choice name="fonts" label="Lettering" choices={Object.keys(FONT_PRESETS)} />
      <label className="block">
        <span className="text-neutral-700">Layout</span>
        <select name="layout" defaultValue="" className={SELECT}>
          <option value="">Let the builder decide</option>
          <option value="single-page">One page</option>
          <option value="multi-page">Several pages</option>
        </select>
      </label>
      <fieldset>
        <legend className="text-neutral-700">Pages it needs</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {options("pages").map((page) => (
            <label key={page} className="flex items-center gap-1">
              <input type="checkbox" name="pages" value={page} />
              {page}
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        label="A site you like"
        name="referenceUrl"
        placeholder="example.com"
        maxLength={2000}
        autoComplete="off"
      />
      <label className="block">
        <span className="text-neutral-700">
          A screenshot you like (PNG, JPEG or WebP, up to {MAX_SCREENSHOT_BYTES / 1024 / 1024} MB)
        </span>
        <input
          type="file"
          name="screenshot"
          accept="image/png,image/jpeg,image/webp"
          className="mt-1 block w-full text-sm"
        />
      </label>
      <p className="text-neutral-600">
        The builder takes ideas from the site and screenshot, never their words or pictures.
      </p>
    </details>
  );
}

function Choice({ name, label, choices }: { name: string; label: string; choices: string[] }) {
  return (
    <label className="block">
      <span className="text-neutral-700">{label}</span>
      <select name={name} defaultValue="" className={SELECT}>
        <option value="">Let the builder ask</option>
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}
