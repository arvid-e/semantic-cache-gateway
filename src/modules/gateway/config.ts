import { z } from 'zod';
import type { Config } from '#src/platform/config/schema.js';

/**
 * Gateway environment segment for the `gateway-provider-routing` module.
 *
 * A *separate* contract from the foundation's `Config`
 * (`src/platform/config/schema.ts`), following the same pattern auth uses: the
 * module owns and validates the settings only it needs — the provider base URLs,
 * the per-call request timeout, the default max-tokens, and the Anthropic API
 * version — with the same fail-fast, secret-safe discipline as the foundation
 * loader.
 *
 * These are the deployment-side inputs the adapters need to build a provider
 * request (Req 3.4) and to bound a single non-streaming call (Req 3.5). No
 * credential lives here: provider keys are per tenant (BYOK) and are resolved by
 * `auth-tenancy-credentials` on each request.
 *
 * Ollama is deliberately absent from this segment's environment: the foundation
 * already owns and validates `OLLAMA_URL`, so the base URL is reused from the
 * foundation config rather than re-read here.
 */

/** Public OpenAI API root. Overridable for a proxy, a gateway, or a test stub. */
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Public Anthropic API root. Overridable for a proxy or a test stub. */
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/**
 * Anthropic's `anthropic-version` header value. Pinned in code rather than
 * required from the environment: the correct value is tied to the request shape
 * the adapter builds, not to a deployment. The env var exists so a rollout can
 * move to a newer dated release without a code change.
 */
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/** Upper bound on a single provider call before it is treated as a timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Supplied where a provider requires a max-tokens value the client omitted. */
const DEFAULT_MAX_TOKENS = 1024;

/** Anthropic versions are dated releases, e.g. `2023-06-01`. */
const ANTHROPIC_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Env keys owned by this segment whose values must never reach an error message
 * or a log line. A provider base URL may carry userinfo (`https://user:pass@…`)
 * for a corporate proxy, so it is treated as potentially credential-bearing and
 * only ever named, never echoed — the same rule the foundation applies to
 * `POSTGRES_URL` and `REDIS_URL`.
 */
export const GATEWAY_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
]);

/**
 * Shape of this segment's raw environment. Every setting is optional: each has a
 * correct universal default, so a deployment only sets what it wants to change.
 * Env vars arrive as strings, so the numeric settings coerce.
 */
const gatewayConfigSchema = z.object({
  PROVIDER_TIMEOUT_MS: z.coerce
    .number('must be a number')
    .int('must be an integer')
    .positive('must be a positive integer')
    .default(DEFAULT_TIMEOUT_MS),
  PROVIDER_DEFAULT_MAX_TOKENS: z.coerce
    .number('must be a number')
    .int('must be an integer')
    .positive('must be a positive integer')
    .default(DEFAULT_MAX_TOKENS),
  OPENAI_BASE_URL: z.url().default(DEFAULT_OPENAI_BASE_URL),
  ANTHROPIC_BASE_URL: z.url().default(DEFAULT_ANTHROPIC_BASE_URL),
  ANTHROPIC_VERSION: z
    .string()
    .regex(
      ANTHROPIC_VERSION_PATTERN,
      'must be a dated release such as 2023-06-01',
    )
    .default(DEFAULT_ANTHROPIC_VERSION),
});

/**
 * The slice of the foundation `Config` this segment reuses. Narrowed to exactly
 * what is borrowed, so the dependency on the foundation is explicit and the
 * loader stays trivial to exercise.
 */
export type GatewayFoundationSettings = Pick<Config, 'ollama'>;

/**
 * Frozen, typed gateway configuration produced from a valid environment. Adapters
 * and the completion service read this rather than `process.env`.
 */
export interface GatewayConfig {
  /** Bound on a single provider call; expiry becomes a `timeout` error (Req 3.5). */
  readonly requestTimeoutMs: number;
  /** Used where a provider requires a max-tokens the client omitted (Req 3.4). */
  readonly defaultMaxTokens: number;
  readonly providers: {
    readonly openai: { readonly baseUrl: string };
    readonly anthropic: {
      readonly baseUrl: string;
      /** Value for the `anthropic-version` request header. */
      readonly version: string;
    };
    /** Base URL reused from the foundation's `OLLAMA_URL`. */
    readonly ollama: { readonly baseUrl: string };
  };
}

/**
 * Thrown when the gateway environment fails validation. The message names each
 * offending setting and never echoes the value of a sensitive one. Mirrors the
 * foundation's `ConfigValidationError` and auth's `AuthConfigError` so a bad
 * gateway environment fails plugin registration the same, recognizable way.
 */
export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

/** Throw a {@link GatewayConfigError} listing every offending setting. */
function fail(details: readonly string[]): never {
  throw new GatewayConfigError(
    `Invalid gateway configuration for: ${details.join(', ')}`,
  );
}

/**
 * Whether a URL embeds userinfo (`https://user:pass@host`). Such a URL would make
 * the deployment itself hold a provider credential, which contradicts BYOK
 * pass-through (Req 3.2) and would put a secret into a value that gets passed
 * around as configuration.
 */
function hasEmbeddedCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    // Unparseable URLs are already rejected by the schema.
    return false;
  }
}

/**
 * Parse and validate the gateway environment segment into a frozen
 * {@link GatewayConfig}. Call during gateway-plugin registration, before the
 * module serves any request.
 *
 * Validation is fail-fast and secret-safe: an invalid setting throws a
 * {@link GatewayConfigError} naming the setting(s), and the value of a base URL
 * is never included in the message. A valid environment yields a read-only
 * config the adapters consume.
 *
 * @param foundation - Foundation config slice supplying the reused Ollama URL.
 * @param env - Environment to read; defaults to `process.env`.
 * @throws {GatewayConfigError} when any gateway setting is invalid, or when the
 * reused Ollama URL is absent.
 */
export function loadGatewayConfig(
  foundation: GatewayFoundationSettings,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const result = gatewayConfigSchema.safeParse(env);
  const issues: string[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '(unknown)');
      // For a potentially credential-bearing setting report only the name, so no
      // part of the offending value can ride out in the message.
      issues.push(
        GATEWAY_SENSITIVE_KEYS.has(key) ? key : `${key} (${issue.message})`,
      );
    }
  }

  // The foundation owns and validates OLLAMA_URL; this only asserts the reused
  // value actually arrived, so a broken hand-off names the foundation setting
  // instead of surfacing later as an unusable Ollama base URL.
  const ollamaUrl = foundation.ollama.url;
  if (ollamaUrl === '') {
    issues.push('OLLAMA_URL (required by the gateway for the Ollama provider)');
  }

  if (result.success) {
    for (const key of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'] as const) {
      if (hasEmbeddedCredentials(result.data[key])) {
        issues.push(`${key} (must not embed credentials)`);
      }
    }
  }

  if (issues.length > 0) fail(issues);

  // Unreachable: a failed parse records an issue above and `fail` throws. The
  // re-check narrows the type without a forbidden non-null assertion.
  if (!result.success) fail(['(unknown)']);

  const parsed = result.data;

  return Object.freeze({
    requestTimeoutMs: parsed.PROVIDER_TIMEOUT_MS,
    defaultMaxTokens: parsed.PROVIDER_DEFAULT_MAX_TOKENS,
    providers: Object.freeze({
      openai: Object.freeze({ baseUrl: parsed.OPENAI_BASE_URL }),
      anthropic: Object.freeze({
        baseUrl: parsed.ANTHROPIC_BASE_URL,
        version: parsed.ANTHROPIC_VERSION,
      }),
      ollama: Object.freeze({ baseUrl: ollamaUrl }),
    }),
  });
}
