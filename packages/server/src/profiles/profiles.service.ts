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
  CHAR_OVERRIDE,
  ENTITY_RESTRICTION,
  LIANYU_PIN,
  SKILL_OWNER,
  SKILL_RESTRICTION,
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
  /** 本体选版的唯一实现：恋雨杯指定优先，否则血量高→充能低→较新 */
  private bodyChoice(id: number, poolIdx: number[], baseIdx: number): number | null {
    const avail = poolIdx.filter((i) => bodyAt(id, i) !== null);
    if (avail.length === 0) return null;
    const pin = LIANYU_PIN[id];
    if (pin !== undefined && avail.includes(pin)) return pin;
    // 恋雨杯指定版不在池内时，只允许“不高于有效上限”的本体：
    // 生命不更高、充能不更低。CHAR_OVERRIDE 是恋雨杯的字段覆盖（甘雨/宵宫）。
    const pinBody = pin !== undefined ? bodyAt(id, pin) : null;
    const override = CHAR_OVERRIDE[id];
    const capHp = override?.hp ?? pinBody?.[0];
    const capEnergy = override?.maxEnergy ?? pinBody?.[1];
    const candidates =
      capHp !== undefined && capEnergy !== undefined
        ? avail.filter((i) => {
            const s = bodyAt(id, i)!;
            return s[0] <= capHp && s[1] >= capEnergy;
          })
        : avail;
    const pool = candidates.length > 0 ? candidates : avail;
    let bestIdx = pool.includes(baseIdx) ? baseIdx : pool[pool.length - 1];
    for (const i of pool) {
      const s = bodyAt(id, i)!;
      const b = bodyAt(id, bestIdx)!;
      if (s[0] > b[0] || (s[0] === b[0] && s[1] < b[1])) bestIdx = i;
    }
    return bestIdx;
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

    // ① 角色本体：恋雨杯指定优先，否则 生命↑、充能↓
    for (const idStr of Object.keys(CHAR_BODY)) {
      const id = Number(idStr);
      if (!bodyAt(id, baseIdx)) continue;
      const bestIdx = this.bodyChoice(id, poolIdx, baseIdx);
      if (bestIdx === null) continue;
      bodyBest.set(id, bestIdx);
      // 显式钉住本体：行动牌的恋雨杯版本可能沿依赖把技能/本体拉旧，
      // 角色本体必须保留在本池选出的版本。
      map[id] = VERSION_LIST[bestIdx] as Version;
    }

    // ② 技能：恋雨杯指定优先，否则描述数值和比大小（平局取较新）
    const pinnedSkills: number[] = [];
    for (const idStr of includeSkills ? Object.keys(SKILL_STATS) : []) {
      const id = Number(idStr);
      const base = skillAt(id, baseIdx);
      if (!base) continue;
      const rawAvail = poolIdx.filter((i) => skillAt(id, i) !== null);
      if (rawAvail.length === 0) continue;
      // 已知“从某版起加限制”的技能，只允许取限制之前的版本。
      const weakerFrom = SKILL_RESTRICTION[id];
      const cappedAvail =
        weakerFrom !== undefined
          ? rawAvail.filter((i) => i < weakerFrom)
          : rawAvail;
      const avail = cappedAvail.length > 0 ? cappedAvail : rawAvail;
      let bestIdx = baseIdx;
      const pin = LIANYU_PIN[id];
      if (pin !== undefined && avail.includes(pin)) {
        bestIdx = pin;
      } else {
        // 恋雨杯指定版不在池内时，只能取“不高于它”的候选：
        // 文本相同（同一效果）或描述数值和更低（更弱）。
        // 不能因为池里没有指定版，就取一个更强的版本来突破上限。
        const candidates = (() => {
          if (pin === undefined) {
            return avail;
          }
          const pinStat = skillAt(id, pin);
          if (!pinStat) {
            return avail;
          }
          const allowed = avail.filter((i) => {
            const s = skillAt(id, i)!;
            return s[0] === pinStat[0] || s[1] < pinStat[1];
          });
          return allowed.length > 0 ? allowed : avail;
        })();
        bestIdx = candidates.includes(baseIdx)
          ? baseIdx
          : candidates[candidates.length - 1];
        let bestScore = skillAt(id, bestIdx)![1];
        for (const i of candidates) {
          const s = skillAt(id, i)!;
          if (s[1] > bestScore || (s[1] === bestScore && i > bestIdx)) {
            bestScore = s[1];
            bestIdx = i;
          }
        }
      }
      // 所有可用技能都显式钉到本池选出的版本，防止行动牌的旧版依赖
      // 把角色技能一起拉旧。
      map[id] = VERSION_LIST[bestIdx] as Version;
      if (bestIdx !== baseIdx) {
        pinnedSkills.push(id);
      }
    }

    // ③ 关联实体（领域/召唤物等）如果也有“加限制”的削弱点，
    //    在限制之前的抽选版本里取最新一版。
    for (const [idStr, weakerFrom] of Object.entries(ENTITY_RESTRICTION)) {
      const allowed = poolIdx.filter((i) => i < weakerFrom);
      const candidates = allowed.length > 0 ? allowed : poolIdx;
      const idx = candidates[candidates.length - 1];
      if (idx !== undefined) {
        map[Number(idStr)] = VERSION_LIST[idx] as Version;
      }
    }

    // ④ 行动牌：完全采用恋雨杯的指定版本，不受抽选版本限制
    for (const [idStr, pinIdx] of Object.entries(CARD_PIN)) {
      map[Number(idStr)] = VERSION_LIST[pinIdx] as Version;
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
  private fieldOverrides(
    sorted: Version[],
  ): Record<number, { hp?: number; maxEnergy?: number }> {
    const baseIdx = VERSION_LIST.indexOf(sorted[sorted.length - 1] as never);
    if (baseIdx < 0) return {};
    const poolIdx = sorted
      .map((v) => VERSION_LIST.indexOf(v as never))
      .filter((i) => i >= 0);
    const out: Record<number, { hp?: number; maxEnergy?: number }> = {};
    for (const idStr of Object.keys(CHAR_BODY)) {
      const id = Number(idStr);
      const states = poolIdx
        .map((i) => bodyAt(id, i))
        .filter((x): x is [number, number] => x !== null);
      if (states.length === 0) continue;
      const minEnergy = Math.min(...states.map((s) => s[1]));
      const bestIdx = this.bodyChoice(id, poolIdx, baseIdx);
      if (bestIdx === null) continue;
      const chosen = bodyAt(id, bestIdx);
      const atBase = bodyAt(id, baseIdx);
      if (!chosen || !atBase) continue;
      // 前端按 base 版本的静态数据渲染，所以凡是"选中版本与 base 不同"的字段都要覆盖
      const ov: { hp?: number; maxEnergy?: number } = {};
      const pin = LIANYU_PIN[id];
      const pinBody = pin !== undefined ? bodyAt(id, pin) : null;
      const capEnergy = CHAR_OVERRIDE[id]?.maxEnergy ?? pinBody?.[1];
      const targetEnergy =
        capEnergy !== undefined
          ? Math.max(minEnergy, capEnergy)
          : Math.min(minEnergy, chosen[1]);
      if (targetEnergy !== atBase[1]) ov.maxEnergy = targetEnergy;
      if (chosen[0] !== atBase[0]) ov.hp = chosen[0];
      if (Object.keys(ov).length > 0) out[id] = ov;
    }
    return out;
  }

  /**
   * 退化判定：整角色只取一个版本（用于依赖冲突、无法混版本时）。
   * 排序依据：效果优先（该角色技能描述数值和）→ 血量 → 较新版本。
   */
  private coarseVersionMap(
    sorted: Version[],
    includeSkills = true,
  ): Record<number, Version> {
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
        const pinBody = pin !== undefined ? bodyAt(id, pin) : null;
        const override = CHAR_OVERRIDE[id];
        const capHp = override?.hp ?? pinBody?.[0];
        const capEnergy = override?.maxEnergy ?? pinBody?.[1];
        const capped =
          capHp !== undefined && capEnergy !== undefined
            ? avail.filter((i) => {
                const s = bodyAt(id, i)!;
                return s[0] <= capHp && s[1] >= capEnergy;
              })
            : avail;
        const candidates = capped.length > 0 ? capped : avail;
        bestIdx = candidates.includes(baseIdx)
          ? baseIdx
          : candidates[candidates.length - 1];
        let bestScore = scoreOf(id, bestIdx);
        let bestHp = bodyAt(id, bestIdx)![0];
        for (const i of candidates) {
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
      map[id] = VERSION_LIST[bestIdx] as Version;
    }
    // 退化时仍保留恋雨杯的技能指定（其自身配置自洽，如夜兰 12093→4.6）
    for (const idStr of includeSkills ? Object.keys(SKILL_STATS) : []) {
      const id = Number(idStr);
      const pin = LIANYU_PIN[id];
      if (pin === undefined || !poolIdx.includes(pin)) continue;
      if (pin !== baseIdx) map[id] = VERSION_LIST[pin] as Version;
    }
    // 行动牌照样按恋雨杯钉（与角色判定/抽选版本无关）
    for (const [idStr, pinIdx] of Object.entries(CARD_PIN)) {
      map[Number(idStr)] = VERSION_LIST[pinIdx] as Version;
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
    const selectedMaxIdx = VERSION_LIST.indexOf(baseVersion as never);
    // 角色只允许抽到的版本为止；行动牌不受版本限制，所以数据加载到当前版本，
    // 再用 blacklist 挡住抽选最高版之后才登场的角色。
    const dataVersion = CURRENT_VERSION;
    const characterBlacklist = Object.keys(CHAR_BODY)
      .map(Number)
      .filter((id) => CHAR_BODY[id]![0]![0] > selectedMaxIdx);
    const name = "比赛版本";
    const overrides = this.fieldOverrides(sorted);
    const build = (vm: Record<number, Version>) => {
      const pinTag = Object.keys(vm).length;
      const id = `practice/${sorted.join("-")}${pinTag ? `#${pinTag}` : ""}`;
      return customProfile(baseVersion, {
        id,
        name,
        dataVersion,
        versionMap: vm,
        fieldOverrides: overrides,
        deck: {
          blacklist: characterBlacklist,
          allowNewerCards: true,
        },
      });
    };

    const levels: { name: string; vm: () => Record<number, Version> }[] = [
      { name: "细粒度(本体+技能+行动牌)", vm: () => (versionMap && Object.keys(versionMap).length > 0 ? versionMap : this.autoVersionMap(sorted)) },
      { name: "整角色+恋雨杯技能+行动牌", vm: () => this.coarseVersionMap(sorted) },
      { name: "整角色+行动牌", vm: () => this.coarseVersionMap(sorted, false) },
      { name: "不钉版本(纯 base)", vm: () => ({}) },
    ];
    let compiled: CompiledProfile | null = null;
    let lastErr: unknown = null;
    for (const level of levels) {
      try {
        compiled = build(level.vm());
        if (level !== levels[0]) {
          console.warn(`[practice] ${sorted.join("+")} 降级为「${level.name}」`);
        }
        break;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[practice] ${sorted.join("+")} 「${level.name}」冲突：`,
          (err as Error).message?.split("\n")[0],
        );
      }
    }
    if (!compiled) {
      throw lastErr instanceof Error ? lastErr : new Error("profile build failed");
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
