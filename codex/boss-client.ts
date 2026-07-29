/**
 * Restricted Boss operation clients are intentionally unavailable in this
 * adapter release. A safe client must be provisioned by the protected broker
 * from its own authenticated binding and transport; accepting either from a
 * caller would let untrusted code manufacture authority.
 */
export type HardenedBossClientKind = "boss_participant" | "boss_reviewer";

export const HARDENED_BOSS_CODEX_DEFAULTS = Object.freeze({
  boss_participant: Object.freeze({ approvalPolicy: "untrusted", sandbox: "workspace-write" }),
  boss_reviewer: Object.freeze({ approvalPolicy: "untrusted", sandbox: "read-only" }),
} as const);

export const BOSS_RESTRICTED_CLIENT_AVAILABILITY = "unavailable_without_protected_factory" as const;

export const PROVIDER_AUTHORITY_UNAVAILABLE = "PROVIDER_AUTHORITY_UNAVAILABLE" as const;

export class ProviderAuthorityUnavailableError extends Error {
  readonly code = PROVIDER_AUTHORITY_UNAVAILABLE;

  constructor(readonly bossClient: HardenedBossClientKind) {
    super(`${PROVIDER_AUTHORITY_UNAVAILABLE}: ${bossClient} requires a broker-owned, artifact-attested Codex provider executable`);
    this.name = "ProviderAuthorityUnavailableError";
  }
}

/**
 * Protected Boss launches must not resolve `codex` through caller PATH or
 * accept a caller-selected executable. No broker-owned provider attestation is
 * available in this adapter yet, so every production spawn remains dormant.
 */
export function assertHardenedBossProviderAuthority(bossClient: HardenedBossClientKind | undefined): void {
  if (bossClient !== undefined) throw new ProviderAuthorityUnavailableError(bossClient);
}
