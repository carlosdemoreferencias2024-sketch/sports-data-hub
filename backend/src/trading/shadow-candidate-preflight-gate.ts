export type ShadowCandidateSnapshot = {
  verdict?: unknown;
  hash_valid?: unknown;
} | null | undefined;

export function shadowCandidatePreflightPassed(snapshot: ShadowCandidateSnapshot) {
  return snapshot?.verdict === "PASS" && snapshot.hash_valid === true;
}
