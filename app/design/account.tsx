/**
 * Shared furniture for the signed-out account screens.
 *
 * Login and signup are the same panel with different verbs, so the shell,
 * the provider buttons and the field styling live here rather than being
 * written twice and drifting.
 */

import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import { BrandMark } from "~/design/components";
import { APP_NAME } from "~/lib/brand";

export function AccountShell({
  title,
  tagline,
  children,
  footer,
}: {
  title: string;
  tagline: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="auth-hero">
      <div className="auth-panel account-panel">
        <div className="account-mark">
          <BrandMark size={72} orbit />
        </div>
        <h1 className="auth-word">{title}</h1>
        <p className="auth-tag">{tagline}</p>
        {children}
        {footer ? <div className="account-footer">{footer}</div> : null}
      </div>
    </main>
  );
}

/** Apple and Google, always both. */
export function ProviderButtons({
  returnTo,
  verb,
  from,
}: {
  returnTo: string;
  verb: string;
  /** Path to return to when a provider turns out to be unavailable. */
  from: string;
}) {
  /*
   * Both providers are always offered, and the buttons say nothing about
   * whether their credentials exist yet.
   *
   * Hiding an unconfigured one made the finished page render as email-only,
   * which reads as a product that does not support Apple. Labelling one as
   * unavailable was the same information in a quieter form, and it is not the
   * merchant's problem to read. If a provider cannot run, pressing it says so
   * — see `oauth.$provider.tsx`.
   */
  return (
    <>
      <div className="account-providers">
        {PROVIDERS.map(({ id, label, Mark }) => (
          <Form key={id} method="post" action={`/oauth/${id}`}>
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="from" value={from} />
            <button type="submit" className="account-provider">
              <Mark />
              <span>
                {verb} With {label}
              </span>
            </button>
          </Form>
        ))}
      </div>
      <div className="account-divider">
        <span>Or</span>
      </div>
    </>
  );
}

const PROVIDERS = [
  { id: "google", label: "Google", Mark: GoogleMark },
  { id: "apple", label: "Apple", Mark: AppleMark },
] as const;

export function Field({
  label,
  name,
  type,
  autoComplete,
  defaultValue,
  required = true,
  hint,
  inputMode,
}: {
  label: string;
  name: string;
  type: string;
  autoComplete: string;
  defaultValue?: string;
  required?: boolean;
  hint?: string;
  inputMode?:
    | "none"
    | "text"
    | "tel"
    | "url"
    | "email"
    | "numeric"
    | "decimal"
    | "search";
}) {
  return (
    <label className="account-field">
      <span className="account-label">{label}</span>
      <input
        className="account-input"
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        required={required}
        inputMode={inputMode}
      />
      {hint ? <span className="account-hint">{hint}</span> : null}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="account-error" role="alert">
      {message}
    </p>
  );
}

export function AccountFooterLink({
  prompt,
  to,
  label,
}: {
  prompt: string;
  to: string;
  label: string;
}) {
  return (
    <p className="account-alt">
      {prompt} <Link to={to}>{label}</Link>
    </p>
  );
}

export function brandName(): string {
  return APP_NAME;
}

/* Marks are inline so the page has no external image dependency and both
   follow the theme's ink colour. */

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.1z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 11-2 14.6-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.7-3.9-12.4-9.1H4.3v5.7C7.9 41 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.6 28.1c-.4-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1v-5.7H4.3C2.8 17.1 2 20.4 2 24s.8 6.9 2.3 9.8l7.3-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.8c3.3 0 6.2 1.1 8.5 3.3l6.3-6.3C34.9 4.2 30 2 24 2 15.4 2 7.9 7 4.3 14.2l7.3 5.7c1.7-5.2 6.6-9.1 12.4-9.1z"
      />
    </svg>
  );
}

function AppleMark() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.18-1.72-1.35-.14-2.64.8-3.33.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.54 2.67-.39 6.62 1.1 8.79.73 1.06 1.6 2.25 2.74 2.21 1.1-.04 1.52-.71 2.85-.71 1.33 0 1.71.71 2.87.69 1.19-.02 1.94-1.08 2.66-2.15.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.34-3.54zM14.88 5.9c.61-.74 1.02-1.77.91-2.8-.88.04-1.94.59-2.57 1.32-.56.65-1.05 1.7-.92 2.7.98.08 1.98-.5 2.58-1.22z" />
    </svg>
  );
}
