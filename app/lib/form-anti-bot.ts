/** The neutral field name used by the public-form honeypot. */
export const HONEYPOT_FIELD = "website";

/**
 * Treat every non-empty or non-text duplicate as automated input.
 *
 * Reading all values prevents a bot from bypassing the control by submitting
 * a blank first value followed by a filled duplicate. A file is never valid
 * for this text-only field, so it is rejected as well.
 */
export function honeypotTriggered(form: FormData): boolean {
  return form
    .getAll(HONEYPOT_FIELD)
    .some((value) => typeof value !== "string" || value.trim().length > 0);
}
