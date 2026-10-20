import type { ReactNode } from "react";

/**
 * A page inside the signed-in app, next to the menu: a title bar, then the page's content.
 * `width` is how wide the content may grow; forms stay narrow, lists and tables get room.
 */
export function Page({
  title,
  description,
  width = "narrow",
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  width?: "narrow" | "wide";
  /** Buttons for the title bar, on its right. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`mx-auto w-full px-6 py-8 ${width === "wide" ? "max-w-5xl" : "max-w-2xl"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-neutral-600">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="mt-6 space-y-4">{children}</div>
    </div>
  );
}

/** A page outside the app (signing in, invites, naming the agency): one small centered card. */
export function AuthPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-start justify-center bg-neutral-50 px-6 py-20">
      <div className="w-full max-w-md rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold tracking-tight text-neutral-500">Locus</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
        <div className="mt-6 space-y-4">{children}</div>
      </div>
    </main>
  );
}

export function Field({ label, ...input }: { label: string } & React.ComponentProps<"input">) {
  return (
    <label className="block text-sm">
      <span className="text-neutral-700">{label}</span>
      <input
        {...input}
        className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-base"
      />
    </label>
  );
}

export function Button({
  children,
  name,
  value,
}: {
  children: ReactNode;
  /** For a form with several buttons: which one was pressed. */
  name?: string;
  value?: string;
}) {
  return (
    <button
      type="submit"
      name={name}
      value={value}
      className="w-full rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
    >
      {children}
    </button>
  );
}

export function Notice({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  const colors =
    tone === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-sky-200 bg-sky-50 text-sky-900";
  return <p className={`rounded-md border px-3 py-2 text-sm ${colors}`}>{children}</p>;
}
