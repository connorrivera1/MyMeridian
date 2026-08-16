-- Extend the standalone web-account identity set without rewriting existing
-- Google or Apple account bindings. PostgreSQL enum additions are additive and
-- preserve the provider/subject uniqueness constraint on OAuthAccount.
ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'MICROSOFT';
