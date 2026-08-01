import { z } from 'zod';

/**
 * A *separate* contract from the foundation's `Config`
 * (`src/platform/config/schema.ts`): the auth module owns its own secret
 * material — the AES-256-GCM keyring, the gateway-key HMAC pepper, and the admin
 * token — and validates it here with the same fail-fast discipline.
 *
 * Every setting in this segment is sensitive, so a validation failure names the
 * offending setting but never echoes its value.
 */

/** AES-256 keys are exactly 32 bytes; the keyring rejects anything else. */
const AES_256_KEY_BYTES = 32;

/**
 * Matches SHA-256's block-independent security target and the key size used
 * elsewhere; a shorter pepper weakens the keyed-hash guarantee.
 */
const MIN_PEPPER_BYTES = 32;

/**
 * The admin token authorizes every provisioning call, so a trivially short value
 * is rejected at boot rather than becoming a guessable production credential.
 */
const MIN_ADMIN_TOKEN_LENGTH = 16;

/** Every auth setting is secret material, so all of them are listed here. */
export const AUTH_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'AUTH_ENCRYPTION_KEYS',
  'AUTH_ACTIVE_KEY_VERSION',
  'AUTH_GATEWAY_KEY_PEPPER',
  'AUTH_ADMIN_TOKEN',
]);

/**
 * Presence and shape only. Structural decoding of the keyring and pepper —
 * base64 validity, byte lengths, active-version membership — happens in
 * {@link loadAuthConfig}, where failures can be reported without their values.
 *
 * Messages here are deliberately value-free ("is required"), because a Zod issue
 * for a sensitive key must not carry the offending input.
 */
const authConfigSchema = z.object({
  AUTH_ENCRYPTION_KEYS: z.string().min(1, 'is required'),
  AUTH_ACTIVE_KEY_VERSION: z.coerce
    .number('is required')
    .int('must be an integer')
    .positive('must be a positive integer'),
  AUTH_GATEWAY_KEY_PEPPER: z.string().min(1, 'is required'),
  AUTH_ADMIN_TOKEN: z
    .string()
    .min(
      MIN_ADMIN_TOKEN_LENGTH,
      `must be at least ${String(MIN_ADMIN_TOKEN_LENGTH)} characters`,
    ),
});

/** Read-only so no consumer can mutate shared key material after boot. */
export interface AuthConfig {
  readonly encryption: {
    /** Version whose key new secrets are encrypted with. */
    readonly activeKeyVersion: number;
    /** Every usable key, indexed by `key_version`, for decrypting stored rows. */
    readonly keyring: ReadonlyMap<number, Buffer>;
  };
  readonly gatewayKeyPepper: Buffer;
  readonly adminToken: string;
}

/**
 * Mirrors the foundation's `ConfigValidationError` so the plugin-registration
 * path fails the same, recognizable way.
 */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

function fail(details: readonly string[]): never {
  throw new AuthConfigError(
    `Invalid auth configuration for: ${details.join(', ')}`,
  );
}

/** Strict base64: the charset only, so a malformed value is rejected rather
 * than silently truncated by `Buffer.from`'s lenient decoding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Returns bytes (never the input) so callers can length-check without ever
 * putting the value into an error.
 */
function decodeBase64(value: string): Buffer | null {
  if (!BASE64_PATTERN.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  // Reject inputs that base64-decode to nothing (e.g. only padding).
  return buf.length > 0 ? buf : null;
}

/**
 * Parse a comma-separated list of `version:base64key` entries, appending a
 * value-free issue for each malformed one. Versions are non-secret
 * (`key_version` is stored in plaintext) so they may appear in a message; key
 * material may not.
 */
function parseKeyring(raw: string, issues: string[]): Map<number, Buffer> {
  const keyring = new Map<number, Buffer>();

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      issues.push(
        'AUTH_ENCRYPTION_KEYS (expected comma-separated "<version>:<base64-key>" entries)',
      );
      continue;
    }

    const versionText = trimmed.slice(0, separator);
    const version = Number(versionText);
    if (!Number.isInteger(version) || version <= 0) {
      issues.push(
        `AUTH_ENCRYPTION_KEYS (key version "${versionText}" must be a positive integer)`,
      );
      continue;
    }
    if (keyring.has(version)) {
      issues.push(
        `AUTH_ENCRYPTION_KEYS (duplicate key version ${String(version)})`,
      );
      continue;
    }

    const key = decodeBase64(trimmed.slice(separator + 1));
    if (key === null) {
      issues.push(
        `AUTH_ENCRYPTION_KEYS (key for version ${String(version)} is not valid base64)`,
      );
      continue;
    }
    if (key.length !== AES_256_KEY_BYTES) {
      issues.push(
        `AUTH_ENCRYPTION_KEYS (key for version ${String(version)} must decode to ${String(AES_256_KEY_BYTES)} bytes)`,
      );
      continue;
    }

    keyring.set(version, key);
  }

  return keyring;
}

/**
 * Call during auth-plugin registration, before the module handles any request.
 * A missing or invalid setting throws an {@link AuthConfigError} naming the
 * setting(s) but never printing a value.
 *
 * @throws {AuthConfigError} when any auth setting is missing or invalid.
 */
export function loadAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): AuthConfig {
  const result = authConfigSchema.safeParse(env);

  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '(unknown)');
      return AUTH_SENSITIVE_KEYS.has(key) ? `${key} (${issue.message})` : key;
    });
    fail(details);
  }

  const parsed = result.data;
  const issues: string[] = [];

  const keyring = parseKeyring(parsed.AUTH_ENCRYPTION_KEYS, issues);
  if (keyring.size === 0 && issues.length === 0) {
    issues.push('AUTH_ENCRYPTION_KEYS (no keys configured)');
  }

  const activeKeyVersion = parsed.AUTH_ACTIVE_KEY_VERSION;
  // Only assert membership once the keyring parsed cleanly; otherwise the
  // "active version missing" issue would just be noise from the real cause.
  if (keyring.size > 0 && !keyring.has(activeKeyVersion)) {
    issues.push(
      `AUTH_ACTIVE_KEY_VERSION (version ${String(activeKeyVersion)} has no key in AUTH_ENCRYPTION_KEYS)`,
    );
  }

  const gatewayKeyPepper = decodeBase64(parsed.AUTH_GATEWAY_KEY_PEPPER);
  if (gatewayKeyPepper === null) {
    issues.push('AUTH_GATEWAY_KEY_PEPPER (must be valid base64)');
  } else if (gatewayKeyPepper.length < MIN_PEPPER_BYTES) {
    issues.push(
      `AUTH_GATEWAY_KEY_PEPPER (must decode to at least ${String(MIN_PEPPER_BYTES)} bytes)`,
    );
  }

  if (issues.length > 0) fail(issues);

  // Unreachable: a null/short pepper records an issue above and `fail` throws.
  // Re-checking here narrows the type without a forbidden non-null assertion.
  if (gatewayKeyPepper === null) fail(['AUTH_GATEWAY_KEY_PEPPER']);

  return Object.freeze({
    encryption: Object.freeze({
      activeKeyVersion,
      // A ReadonlyMap view; the concrete Map is not exposed elsewhere.
      keyring,
    }),
    gatewayKeyPepper,
    adminToken: parsed.AUTH_ADMIN_TOKEN,
  });
}
