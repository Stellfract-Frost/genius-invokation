import { VERSIONS } from "@gi-tcg/core";

export function getDeckVersions(versions: readonly string[] | null | undefined) {
  return VERSIONS.filter((version) => versions?.includes(version));
}

export function getDeckVersionKey(versions: readonly string[] | null | undefined) {
  return getDeckVersions(versions).join("+");
}
