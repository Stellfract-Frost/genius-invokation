// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { CURRENT_VERSION, VERSIONS } from "@gi-tcg/core";
import type { Version } from "@gi-tcg/core";
import { customProfile, loadPresets, officialProfile } from "./compiler";
import type { CompiledProfile } from "./types";
import {
  CARD_PIN,
  CHAR_BODY,
  LIANYU_PIN,
  SKILL_OWNER,
  SKILL_STATS,
  VERSION_LIST,
} from "./char-stats";
import { NotFoundException, BadRequestException } from "../errors";

/** 角色本体在指定版本序号下的 [生命, 充能] */
function bodyAt(id: number, idx: number): [number, number] | null {
  const seq = CHAR_BODY[id];
  if (!seq) return null;
  let hit: [number, number, number] | null = null;
  for (const e of seq) {
    if (e[0] <= idx) hit = e;
  }
  return hit ? [hit[1], hit[2]] : null;
}

/** 技能在指定版本序号下的 [文本指纹, 描述数值和] */
function skillAt(id: number, idx: number): [string, number] | null {
  const seq = SKILL_STATS[id];
  if (!seq) return null;
  let hit: [number, string, number] | null = null;
  for (const e of seq) {
    if (e[0] <= idx) hit = e;
  }
  return hit ? [hit[1], hit[2]] : null;
}

export class ProfilesService {
  readonly defaultProfileId = `official/${CURRENT_VERSION}`;
  private profiles = new Map<string, CompiledProfile>();

  async onModuleInit() {
    for (const version of VERSIONS) {
      const compiled = officialProfile(version);
      this.profiles.set(compiled.profile.id, compiled);
    }
    for (const compiled of await loadPresets(
      new URL("../../presets/", import.meta.url),
      { recursive: true },
    )) {
      this.profiles.set(compiled.profile.id, compiled);
    }
  }

  get(id = this.defaultProfileId) {
    const profile = this.profiles.get(id);
    if (!profile) {
      throw new NotFoundException(`Profile ${id} not found`);
    }
    return profile;
  }
  /**
   * 按 strength-rules.md 自动生成 versionMap。
   * 角色本体与技能是两个独立判定单元：
   *  - 本体：生命↑、充能↓（恋雨杯指定版在池内则优先）
   *  - 技能：恋雨杯指定优先，否则描述数值和比大小，平局取较新
   * 这样「本体取最新 + 某个技能回调旧版」才能表达（如纯水精灵 11 血 + 爆发回 4.1）。
   */
  private autoVersionMap(
    sorted: Version[],
    includeSkills = true,
  ): Record<number, Version> {
    const baseIdx = VERSION_LIST.indexOf(sorted[sorted.length - 1] as never);
    if (baseIdx < 0) return {};
    const poolIdx = sorted
      .map((v) => VERSION_LIST.indexOf(v as never))
      .filter((i) => i >= 0);
    const map: Record<number, Version> = {};
    const bodyBest = new Map<number, number>();

    // ① 角色本体：生命↑、充能↓；恋雨杯指定版在池内时优先
    for (const idStr of Object.keys(CHAR_BODY)) {
      const id = Number(idStr);
      if (!bodyAt(id, baseIdx)) continue;
      const avail = poolIdx.filter((i) => bodyAt(id, i) !== null);
      if (avail.length === 0) continue;
      let bestIdx = baseIdx;
      const pin = LIANYU_PIN[id];
      if (pin !== undefined && avail.includes(pin)) {
        bestIdx = pin;
      } else {
        for (const i of avail) {
          const s = bodyAt(id, i)!;
          const b = bodyAt(id, bestIdx)!;
          if (s[0] > b[0] || (s[0] === b[0] && s[1] < b[1])) {
            bestIdx = i;
          }
        }
      }
      bodyBest.set(id, bestIdx);
      if (bestIdx !== baseIdx) map[id] = VERSION_LIST[bestIdx] as Version;
    }

    // ② 技能：恋雨杯指定优先，否则描述数值和比大小（平局取较新）
    const pinnedSkills: number[] = [];
    for (const idStr of includeSkills ? Object.keys(SKILL_STATS) : []) {
      const id = Number(idStr);
      const base = skillAt(id, baseIdx);
      if (!base) continue;
      const avail = poolIdx.filter((i) => skillAt(id, i) !== null);
      if (avail.length === 0) continue;
      let bestIdx = baseIdx;
      const pin = LIANYU_PIN[id];
      if (pin !== undefined && avail.includes(pin)) {
        bestIdx = pin;
      } else {
        let bestScore = base[1];
        for (const i of avail) {
          const s = skillAt(id, i)!;
          if (s[1] > bestScore || (s[1] === bestScore && i > bestIdx)) {
            bestScore = s[1];
            bestIdx = i;
          }
        }
      }
      if (bestIdx !== baseIdx) {
        map[id] = VERSION_LIST[bestIdx] as Version;
        pinnedSkills.push(id);
      }
    }

    // ③ 行动牌：完全采用恋雨杯的指定版本（池内有才生效），不做数值比较
    for (const [idStr, pinIdx] of Object.entries(CARD_PIN)) {
      if (poolIdx.includes(pinIdx)) {
        map[Number(idStr)] = VERSION_LIST[pinIdx] as Version;
      }
    }

    // ④ 防止依赖传播把本体版本拉低：
    //    技能一旦钉了旧版，resolver 会沿依赖把角色本体也拉到那个版本，
    //    导致「本体该 11 血反而变 10 血」。显式钉住本体（root 优先）即可挡住。
    for (const skillId of pinnedSkills) {
      const ownerId = SKILL_OWNER[skillId];
      if (ownerId === undefined) continue;
      if (map[ownerId] !== undefined) continue;
      const best = bodyBest.get(ownerId);
      if (best !== undefined) {
        map[ownerId] = VERSION_LIST[best] as Version;
      }
    }

    return map;
  }

  /**
   * 集所长：本体取池内血量最高的版本，充能取池内最低值。
   * 仅当池内确实存在更低充能的版本时才覆盖（否则不动，避免无意义的 override）。
   */
  private fieldOverrides(sorted: Version[]): Record<number, { maxEnergy?: number }> {
    const baseIdx = VERSION_LIST.indexOf(sorted[sorted.length - 1] as never);
    if (baseIdx < 0) return {};
    const poolIdx = sorted
      .map((v) => VERSION_LIST.indexOf(v as never))
      .filter((i) => i >= 0);
    const out: Record<number, { maxEnergy?: number }> = {};
    for (const idStr of Object.keys(CHAR_BODY)) {
      const id = Number(idStr);
      const states = poolIdx
        .map((i) => bodyAt(id, i))
        .filter((x): x is [number, number] => x !== null);
      if (states.length === 0) continue;
      const minEnergy = Math.min(...states.map((s) => s[1]));
      // 与 autoVersionMap 的本体选择保持同一规则：血量高 → 充能低 → 较新
      let bestIdx = baseIdx;
      if (!bodyAt(id, baseIdx)) bestIdx = poolIdx.find((i) => bodyAt(id, i)) ?? baseIdx;
      for (const i of poolIdx) {
        const s = bodyAt(id, i);
        const b = bodyAt(id, bestIdx);
        if (!s || !b) continue;
        if (s[0] > b[0] || (s[0] === b[0] && s[1] < b[1])) bestIdx = i;
      }
      const chosen = bodyAt(id, bestIdx);
      if (!chosen) continue;
      if (minEnergy < chosen[1]) out[id] = { maxEnergy: minEnergy };
    }
    return out;
  }

  /**
   * 退化判定：整角色只取一个版本（用于依赖冲突、无法混版本时）。
   * 排序依据：效果优先（该角色技能描述数值和）→ 血量 → 较新版本。
   */
  private coarseVersionMap(sorted: Version[]): Record<number, Version> {
    const baseIdx = VERSION_LIST.indexOf(sorted[sorted.length - 1] as never);
    if (baseIdx < 0) return {};
    const poolIdx = sorted
      .map((v) => VERSION_LIST.indexOf(v as never))
      .filter((i) => i >= 0);
    const skillsOf = new Map<number, number[]>();
    for (const [sid, owner] of Object.entries(SKILL_OWNER)) {
      const arr = skillsOf.get(owner) ?? [];
      arr.push(Number(sid));
      skillsOf.set(owner, arr);
    }
    const scoreOf = (charId: number, idx: number) => {
      let total = 0;
      for (const sid of skillsOf.get(charId) ?? []) {
        const st = skillAt(sid, idx);
        if (st) total += st[1];
      }
      return total;
    };
    const map: Record<number, Version> = {};
    for (const idStr of Object.keys(CHAR_BODY)) {
      const id = Number(idStr);
      if (!bodyAt(id, baseIdx)) continue;
      const avail = poolIdx.filter((i) => bodyAt(id, i) !== null);
      if (avail.length === 0) continue;
      let bestIdx = baseIdx;
      const pin = LIANYU_PIN[id];
      if (pin !== undefined && avail.includes(pin)) {
        bestIdx = pin;
      } else {
        let bestScore = scoreOf(id, baseIdx);
        let bestHp = bodyAt(id, baseIdx)![0];
        for (const i of avail) {
          const sc = scoreOf(id, i);
          const hp = bodyAt(id, i)![0];
          if (sc > bestScore || (sc === bestScore && hp > bestHp) ||
              (sc === bestScore && hp === bestHp && i > bestIdx)) {
            bestScore = sc;
            bestHp = hp;
            bestIdx = i;
          }
        }
      }
      if (bestIdx !== baseIdx) map[id] = VERSION_LIST[bestIdx] as Version;
    }
    // 行动牌照样按恋雨杯钉（与角色判定无关）
    for (const [idStr, pinIdx] of Object.entries(CARD_PIN)) {
      if (poolIdx.includes(pinIdx)) {
        map[Number(idStr)] = VERSION_LIST[pinIdx] as Version;
      }
    }
    return map;
  }

  /**
   * 练习用：把若干版本合成一个 profile（幂等，进程重启后失效）。
   * baseVersion 取池内最高版本；versionMap 默认按规则自动生成。
   */
  createMerged(
    versions: Version[],
    versionMap?: Record<number, Version>,
  ): CompiledProfile {
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new BadRequestException("versions must be a non-empty array");
    }
    const unknown = versions.filter((v) => !VERSIONS.includes(v as never));
    if (unknown.length > 0) {
      throw new BadRequestException(`unknown versions: ${unknown.join(", ")}`);
    }
    const sorted = [...new Set(versions)].sort(
      (a, b) => VERSIONS.indexOf(a as never) - VERSIONS.indexOf(b as never),
    );
    const baseVersion = sorted[sorted.length - 1];
    const name = `练习 ${sorted.map((v) => v.replace(/^v/, "")).join(" + ")}`;
    const overrides = this.fieldOverrides(sorted);
    const build = (vm: Record<number, Version>) => {
      const pinTag = Object.keys(vm).length;
      const id = `practice/${sorted.join("-")}${pinTag ? `#${pinTag}` : ""}`;
      return customProfile(baseVersion, {
        id,
        name,
        versionMap: vm,
        fieldOverrides: overrides,
      });
    };

    let resolved =
      versionMap && Object.keys(versionMap).length > 0
        ? versionMap
        : this.autoVersionMap(sorted);
    let compiled: CompiledProfile;
    try {
      compiled = build(resolved);
    } catch {
      // 细粒度混版本会撞依赖（例：吞星之鲸 本体 6.7 + 技能 4.8 → 122042 冲突）
      // 退化为「整角色取一版」：效果优先 → 血量 → 较新
      resolved = this.coarseVersionMap(sorted);
      compiled = build(resolved);
    }
    const cached = this.profiles.get(compiled.profile.id);
    if (cached) {
      return cached;
    }
    this.profiles.set(compiled.profile.id, compiled);
    return compiled;
  }

  list() {
    return {
      defaultProfileId: this.defaultProfileId,
      profiles: [...this.profiles.values()].map(({ summary }) => summary),
    };
  }
}
