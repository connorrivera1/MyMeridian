/**
 * One-time publisher credential generator.
 *
 * The generated password, TOTP enrollment URI and keys are printed once and
 * are never written to the repository. Run in a private terminal, enroll the
 * TOTP URI immediately, and put the four values in the production secret vault.
 */
import { randomBytes } from "node:crypto";

import { hashPassword } from "../app/lib/webauth.server.js";
import {
  generateTotpSecret,
  totpProvisioningUri,
} from "../app/lib/operator-totp.js";

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new Error(
    "Usage: npm run operator:provision -- publisher@example.com",
  );
}

const password = randomBytes(24).toString("base64url");
const passwordHash = await hashPassword(password);
const totpSecret = generateTotpSecret();
const sessionKey = randomBytes(32).toString("base64url");

console.log("Store these values in the production secret vault. They will not be shown again.\n");
console.log(`MERIDIAN_OPERATOR_EMAIL=${email}`);
console.log(`MERIDIAN_OPERATOR_PASSWORD_HASH=${passwordHash}`);
console.log(`MERIDIAN_OPERATOR_TOTP_SECRET=${totpSecret}`);
console.log(`MERIDIAN_OPERATOR_SESSION_KEY=${sessionKey}`);
console.log(`\nInitial password: ${password}`);
console.log(
  `Authenticator enrollment URI: ${totpProvisioningUri({ secret: totpSecret, account: email })}`,
);
console.log("\nAfter enrollment, clear this terminal and store a recovery copy offline.");
