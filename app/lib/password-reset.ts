/**
 * Client-safe constants for the password-reset screens.
 *
 * Split out for the same reason `plans.ts` is split from `shopify.server.ts`:
 * the code-entry field renders in the browser and needs to know how long a code
 * is, but reaching into `password-reset.server` for that drags node's crypto
 * and the Prisma client into the client bundle. React Router only strips
 * server-only imports from `loader`, `action`, `headers` and `middleware` — a
 * component that imports one fails the build rather than being cleaned up.
 */

/** Six digits: long enough with rate limiting, short enough to retype. */
export const CODE_LENGTH = 6;
