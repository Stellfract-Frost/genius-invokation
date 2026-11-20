// 练习/比赛版本用的自定义版本解析器。
//
// 官方 createOfficialVersionResolver 在"同一个实体被两条依赖链推到不同版本"时直接抛错，
// 导致「本体取新、技能取旧」这类组合无法表达（例：吞星之鲸 2204→6.7 与 22042→4.8
// 在 122042 上撞车；宵宫 1305 被 13053→3.3 与 213051→7.1 两条链拉扯）。
//
// 本实现的规则：
//  1. 显式指定的版本永远优先，且不会被依赖传播覆盖；
//  2. 传播时"先到先得"，冲突只记录不抛错（旧版本优先，符合"效果优先/预削弱"口径）；
//  3. 未命中任何指定的实体回落到 baseVersion。
import { VERSIONS, versionCompare } from "@gi-tcg/core";
import type { DependencyInfo, Version } from "@gi-tcg/core";

interface VersionCandidate {
  readonly id: number;
  readonly version: {
    readonly from: string;
    readonly value: { readonly predicate: "since" | "until"; readonly version: Version };
  };
}

function pickOfficial<T extends VersionCandidate>(
  candidates: readonly T[],
  required: Version,
): T | null {
  const since = candidates.find(
    (c) =>
      c.version.from === "official" &&
      c.version.value.predicate === "since",
  );
  const until = candidates
    .filter(
      (c) =>
        c.version.from === "official" &&
        c.version.value.predicate === "until" &&
        versionCompare(c.version.value.version, required) >= 0,
    )
    .sort((a, b) =>
      versionCompare(a.version.value.version, b.version.value.version),
    );
  if (!since || versionCompare(since.version.value.version, required) > 0) {
    return null;
  }
  return until[0] ?? since;
}

export interface PracticeResolverLog {
  conflicts: { id: number; kept: Version; dropped: Version }[];
}

export function createPracticeResolver(
  baseVersion: Version,
  versions: Record<number, Version>,
  dependencies: readonly DependencyInfo[] = [],
): ((candidates: readonly VersionCandidate[]) => VersionCandidate | null) & {
  versionMap: Record<number, Version> & { $base: Version };
  log: PracticeResolverLog;
} {
  const depMap = new Map(
    dependencies.map(({ id, dependencies }) => [id, dependencies] as const),
  );
  const resolved = new Map<number, Version>();
  const log: PracticeResolverLog = { conflicts: [] };

  // 显式指定优先；按版本从旧到新传播，冲突时旧版本胜出
  const pins = Object.entries(versions)
    .map(([id, v]) => [Number(id), v] as const)
    .sort((a, b) => versionCompare(a[1], b[1]));
  for (const [id, v] of pins) resolved.set(id, v);

  const visit = (id: number, version: Version, seen: Set<number>) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of depMap.get(id) ?? []) {
      const cur = resolved.get(dep);
      if (cur === undefined) {
        resolved.set(dep, version);
        visit(dep, version, seen);
      } else if (cur !== version && versions[dep] === undefined) {
        // 冲突：保留更旧的版本（预削弱口径），只记录不抛错
        const keep = versionCompare(version, cur) < 0 ? version : cur;
        const drop = keep === version ? cur : version;
        if (keep !== cur) resolved.set(dep, keep);
        log.conflicts.push({ id: dep, kept: keep, dropped: drop });
        visit(dep, keep, seen);
      }
    }
  };
  for (const [id, v] of pins) visit(id, v, new Set());

  const versionMap = {
    $base: baseVersion,
    ...versions,
    ...Object.fromEntries([...resolved]),
  } as Record<number, Version> & { $base: Version };

  const resolve = <T extends VersionCandidate>(candidates: readonly T[]) => {
    const id = candidates[0]?.id;
    const required = versionMap[id] ?? baseVersion;
    return pickOfficial(candidates, required);
  };

  const fn = (<T extends VersionCandidate>(candidates: readonly T[]) =>
    resolve(candidates)) as unknown as {
    <T extends VersionCandidate>(candidates: readonly T[]): T | null;
    versionMap: typeof versionMap;
    log: PracticeResolverLog;
  };
  fn.versionMap = versionMap;
  fn.log = log;
  return fn as never;
}

export const _VERSIONS = VERSIONS;
