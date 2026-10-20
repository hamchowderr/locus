import type { ReactNode } from "react";

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-md px-6 py-20">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-6 space-y-4">{children}</div>
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
