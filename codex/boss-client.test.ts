import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as restrictedSurface from "./boss-client.ts";

test("restricted Boss clients are unavailable without a protected broker-owned factory", () => {
  assert.equal(restrictedSurface.BOSS_RESTRICTED_CLIENT_AVAILABILITY, "unavailable_without_protected_factory");
  assert.equal(Object.hasOwn(restrictedSurface, "BossParticipantClient"), false);
  assert.equal(Object.hasOwn(restrictedSurface, "BossReviewerClient"), false);
  assert.equal(Object.hasOwn(restrictedSurface, "BossRestrictedTransport"), false);
});

test("protected provider failure has a stable machine-readable code", () => {
  assert.throws(
    () => restrictedSurface.assertHardenedBossProviderAuthority("boss_reviewer"),
    (error: unknown) => error instanceof restrictedSurface.ProviderAuthorityUnavailableError
      && error.code === "PROVIDER_AUTHORITY_UNAVAILABLE"
      && /broker-owned, artifact-attested Codex provider executable/.test(error.message),
  );
  assert.doesNotThrow(() => restrictedSurface.assertHardenedBossProviderAuthority(undefined));
});

test("source/build surfaces do not advertise caller-provisionable restricted authority", () => {
  const source = readFileSync(new URL("./boss-client.ts", import.meta.url), "utf8");
  const build = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /export class Boss(?:Participant|Reviewer)Client/);
  assert.doesNotMatch(source, /interface BossRestrictedTransport/);
  assert.doesNotMatch(build, /dist\/boss-client\.mjs/);
  assert.equal(existsSync(new URL("../dist/boss-client.mjs", import.meta.url)), false);
});
