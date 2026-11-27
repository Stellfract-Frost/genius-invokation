import { COMPETITION_PROFILE_ID, VERSIONS } from "@gi-tcg/core";

export function getDeckVersions(versions: readonly string[] | null | undefined) {
  return VERSIONS.filter((version) => versions?.includes(version));
}

export function getDeckVersionKey(versions: readonly string[] | null | undefined) {
  const selected = getDeckVersions(versions);
  return selected.length > 1 ? COMPETITION_PROFILE_ID : (selected[0] ?? "");
}
