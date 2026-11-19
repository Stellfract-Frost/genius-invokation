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
import { CHAR_STATS, VERSION_LIST } from "./char-stats";
import { NotFoundException, BadRequestException } from "../errors";

/** 某角色在指定版本序号下的 (生命, 充能)；该版本尚无此角色时返回 null */
function stateAt(id: number, idx: number): [number, number] | null {
  const seq = CHAR_STATS[id];
  if (!seq) return null;
  let hit: [number, number, number] | null = null;
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
   * 按 strength-rules.md 自动生成 versionMap（仅角色维度：血量↑ 充能↓）。
   * 只在"池内某个版本明显更优"时才钉版本，否则留给 baseVersion。
   * 行动牌/技能的费用维度尚未纳入（见 rules 第六节）。
   */
  private autoVersionMap(sorted: Version[]): Record<number, Version> {
    const baseIdx = VERSION_LIST.indexOf(sorted[sorted.length - 1] as never);
    if (baseIdx < 0) return {};
    const poolIdx = sorted
      .map((v) => VERSION_LIST.indexOf(v as never))
      .filter((i) => i >= 0);
    const map: Record<number, Version> = {};
    for (const idStr of Object.keys(CHAR_STATS)) {
      const id = Number(idStr);
      const base = stateAt(id, baseIdx);
      if (!base) continue;
      let bestIdx = baseIdx;
      let best = base;
      for (const i of poolIdx) {
        const s = stateAt(id, i);
        if (!s) continue;
        if (s[0] > best[0] || (s[0] === best[0] && s[1] < best[1])) {
          best = s;
          bestIdx = i;
        }
      }
      if (bestIdx !== baseIdx) {
        map[id] = VERSION_LIST[bestIdx] as Version;
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
    const resolved =
      versionMap && Object.keys(versionMap).length > 0
        ? versionMap
        : this.autoVersionMap(sorted);
    const pinTag = Object.keys(resolved).length;
    const id = `practice/${sorted.join("-")}${pinTag ? `#${pinTag}` : ""}`;
    const cached = this.profiles.get(id);
    if (cached) {
      return cached;
    }
    const compiled = customProfile(baseVersion, {
      id,
      name: `练习 ${sorted.map((v) => v.replace(/^v/, "")).join(" + ")}`,
      versionMap: resolved,
    });
    this.profiles.set(id, compiled);
    return compiled;
  }

  list() {
    return {
      defaultProfileId: this.defaultProfileId,
      profiles: [...this.profiles.values()].map(({ summary }) => summary),
    };
  }
}
