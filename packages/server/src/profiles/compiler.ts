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

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CURRENT_VERSION,
  createOfficialVersionResolver,
  getVersionBehavior,
  mergeGameConfigWithDefault,
  type GameData,
  type Version,
} from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import { analyzeResult } from "@gi-tcg/data-code-analyzer";
import { CustomDataLoader } from "@gi-tcg/custom-data-loader";
import { DiceType } from "@gi-tcg/typings";
import { PLAYCOST_OVERRIDE } from "./char-stats";
import { createPracticeResolver } from "./practice-resolver";
import type { OverrideData } from "@gi-tcg/assets-manager";
import type {
  CompiledProfile,
  ModSource,
  Preset,
  Profile,
  ProfileGameConfig,
} from "./types";
import { loadReference } from "./reference";
import {
  presetSchema,
  inlinePluginSchema,
  pluginSchema,
  versionMapSchema,
  modSchema,
  overridesSchema,
} from "./schema";

const DEFAULT_GAME_CONFIG: ProfileGameConfig = (({
  randomSeed,
  hostWho,
  hostRelatedExecution,
  ...config
}) => config)(mergeGameConfigWithDefault());

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function finishProfile(
  profile: Profile,
  data: GameData,
): CompiledProfile {
  // Hash the same representation served to clients and stored in archives.
  const serialized = JSON.stringify(profile);
  const profileHash = createHash("sha256").update(serialized).digest("hex");
  const { id, name, baseVersion, officialDeckCompatible } = profile;
  return {
    profile: freeze(JSON.parse(serialized)),
    data,
    summary: freeze({
      id,
      name,
      baseVersion,
      officialDeckCompatible,
      profileHash,
    }),
  };
}

export function officialProfile(baseVersion: Version): CompiledProfile {
  return finishProfile(
    {
      id: `official/${baseVersion}`,
      name: `Official ${baseVersion}`,
      baseVersion,
      officialDeckCompatible: true,
      gameConfig: { ...DEFAULT_GAME_CONFIG },
      versionBehavior: getVersionBehavior(baseVersion),
      versionMap: {},
      mods: [],
      assets: {
        version: baseVersion,
        customData: [],
        overrideData: [],
        officialDeckCompatible: true,
      },
    },
    getData(baseVersion),
  );
}

/**
 * 练习用自定义 profile：指定基础版本 + 逐实体版本映射。
 * 用途：赛前练牌时"多选版本"，把若干版本合成一个卡池。
 * - baseVersion 取池内最高版本，天然禁止 sinceVersion 更高的角色/牌
 *   （verifyDeckForProfile 会校验牌组版本不得高于 baseVersion）
 * - versionMap 用于把个别实体钉到池内另一个版本（强度按抽到的版本取）
 */
export function customProfile(
  baseVersion: Version,
  options: {
    id: string;
    name: string;
    versionMap?: Record<number, Version>;
    fieldOverrides?: Record<number, { hp?: number; maxEnergy?: number }>;
  },
): CompiledProfile {
  const versionMap = options.versionMap ?? {};
  // 必须走 resolver + CustomDataLoader，否则 versionMap 不会作用到实际数据上
  // （与 compilePreset 保持同一条链路）
  // 用自定义 resolver：允许"本体取新、技能取旧"的跨版本组合（官方实现会直接抛冲突）
  const resolver = createPracticeResolver(baseVersion, versionMap, analyzeResult);
  if (resolver.log.conflicts.length > 0) {
    console.warn(
      `[practice] ${options.id} 依赖冲突 ${resolver.log.conflicts.length} 处（已按旧版本保留）`,
    );
  }
  const loader = new CustomDataLoader();
  loader.setVersion(resolver as never);
  const [
    data,
    { officialDeckCompatible, customData = [], overrideData = [] },
  ] = loader.done();
  // 集所长的字段级覆盖：本体取池内血量最高的版本，充能取池内最低值。
  // 注意：GameData 里的角色定义是全局共享的，直接改会污染其它 profile，
  // 因此这里做写时复制：只替换被覆盖的角色，并新建 Map。
  let patched = data;
  const ovEntries = Object.entries(options.fieldOverrides ?? {});
  type RawPlayCost = { type: string; count: number }[];
  type RawSkill = {
    id: number;
    skillType: string | null;
    playCost?: RawPlayCost;
    initiativeSkillConfig?: {
      requiredCost: ReadonlyMap<DiceType, number>;
    };
  };
  const diceCostType: Record<number, string> = {
    [DiceType.Void]: "GCG_COST_DICE_VOID",
    [DiceType.Cryo]: "GCG_COST_DICE_CRYO",
    [DiceType.Hydro]: "GCG_COST_DICE_HYDRO",
    [DiceType.Pyro]: "GCG_COST_DICE_PYRO",
    [DiceType.Electro]: "GCG_COST_DICE_ELECTRO",
    [DiceType.Anemo]: "GCG_COST_DICE_ANEMO",
    [DiceType.Geo]: "GCG_COST_DICE_GEO",
    [DiceType.Dendro]: "GCG_COST_DICE_DENDRO",
    [DiceType.Omni]: "GCG_COST_DICE_SAME",
    [DiceType.Aligned]: "GCG_COST_DICE_ALIGNED",
    [DiceType.Energy]: "GCG_COST_ENERGY",
    [DiceType.Legend]: "GCG_COST_LEGEND",
  };
  // 费用覆盖：除了固定规则（如魔偶剑鬼），充能被压低的角色，其爆发费用也要
  // 跟着降到同一个值，否则会出现「面板 2 充能、大招仍要 3 充能」。
  const costOverrides: Record<number, RawPlayCost> = {
    ...PLAYCOST_OVERRIDE,
  };
  const skillCostPatches = new Map<number, ReadonlyMap<DiceType, number>>();
  for (const [idStr, ov] of ovEntries) {
    const maxEnergy = ov.maxEnergy;
    if (maxEnergy == null) continue;
    const ch = data.characters.get(Number(idStr)) as unknown as {
      skills?: RawSkill[];
    } | null;
    for (const sk of ch?.skills ?? []) {
      if (sk.skillType !== "burst" || costOverrides[sk.id]) continue;
      const requiredCost = sk.initiativeSkillConfig?.requiredCost;
      const energy = requiredCost?.get(DiceType.Energy);
      if (!requiredCost || energy === undefined) continue;
      const nextCost = new Map(requiredCost);
      nextCost.set(DiceType.Energy, Math.min(energy, maxEnergy));
      skillCostPatches.set(sk.id, nextCost);
      costOverrides[sk.id] = [...nextCost].map(([type, count]) => ({
        type: diceCostType[type] ?? String(type),
        count,
      }));
    }
  }
  const hasCostOverride =
    Object.keys(costOverrides).length > 0 || skillCostPatches.size > 0;
  if (ovEntries.length > 0 || hasCostOverride) {
    const chars = new Map(data.characters);
    for (const [idStr, ov] of ovEntries) {
      const id = Number(idStr);
      const ch = chars.get(id) as unknown as {
        varConfigs?: Record<string, { initialValue?: number }>;
      } | null;
      const vc = ch?.varConfigs;
      if (!ch || !vc) continue;
      const nextVarConfigs = { ...vc };
      if (ov.maxEnergy != null && vc.maxEnergy) {
        nextVarConfigs.maxEnergy = { ...vc.maxEnergy, initialValue: ov.maxEnergy };
      }
      if (ov.hp != null && vc.maxHealth) {
        nextVarConfigs.maxHealth = { ...vc.maxHealth, initialValue: ov.hp };
      }
      chars.set(id, { ...(ch as object), varConfigs: nextVarConfigs } as never);
    }
    if (hasCostOverride) {
      for (const [cid, ch] of [...chars]) {
        const list = (ch as unknown as { skills?: RawSkill[] }).skills;
        if (
          !list?.some(
            (sk) => skillCostPatches.has(sk.id) || PLAYCOST_OVERRIDE[sk.id],
          )
        ) {
          continue;
        }
        const nextSkills = list.map((sk) => {
          const nextCost = skillCostPatches.get(sk.id);
          if (nextCost) {
            return {
              ...sk,
              initiativeSkillConfig: {
                ...sk.initiativeSkillConfig,
                requiredCost: nextCost,
              },
            };
          }
          if (PLAYCOST_OVERRIDE[sk.id]) {
            return { ...sk, playCost: PLAYCOST_OVERRIDE[sk.id] };
          }
          return sk;
        });
        chars.set(cid, { ...(ch as object), skills: nextSkills } as never);
      }
    }
    patched = { ...data, characters: chars } as typeof data;
  }
  return finishProfile(
    {
      id: options.id,
      name: options.name,
      baseVersion,
      officialDeckCompatible: true,
      gameConfig: { ...DEFAULT_GAME_CONFIG },
      versionBehavior: getVersionBehavior(baseVersion),
      versionMap,
      mods: [],
      assets: {
        // 逐实体版本映射：前端据此按实体版本渲染角色/技能/卡牌，而不是只按 base 显示
        version: { ...resolver.versionMap, $category: baseVersion },
        customData,
        // 字段级覆盖（如集所长压低的充能）必须一起下发，否则前端仍按静态数据显示
        overrideData: [
          ...overrideData,
          ...Object.entries(options.fieldOverrides ?? {}).map(([id, ov]) => ({
            id: Number(id),
            ...ov,
          })),
          // 技能费用覆盖（如魔偶剑鬼 25013 改回 3 风骰，或充能降低后的爆发）
          ...Object.entries(costOverrides).map(([id, playCost]) => ({
            id: Number(id),
            playCost,
          })),
        ],
        officialDeckCompatible,
      },
    },
    patched,
  );
}

export async function compilePreset(
  preset: Preset,
  source: URL,
): Promise<CompiledProfile> {
  const baseVersion = preset.version ?? CURRENT_VERSION;
  const gameConfig = { ...DEFAULT_GAME_CONFIG, ...preset.config };
  const { base, ...behavior } = preset.version_behavior ?? {};
  const versionBehavior = {
    ...getVersionBehavior(base ?? baseVersion),
    ...behavior,
  };
  const versionMap: Record<number, Version> = {};
  const mods: ModSource[] = [];
  const explicitOverrides: OverrideData[] = [];
  for (const entry of preset.plugins ?? []) {
    const { value: plugin, source: pluginSource } = await loadReference(
      entry,
      source,
      pluginSchema,
      inlinePluginSchema,
      { preset, baseVersion, gameConfig },
    );
    for (const entry of plugin.version_maps ?? []) {
      const { value } = await loadReference(
        entry,
        pluginSource,
        versionMapSchema,
      );
      for (const [id, selected] of Object.entries(value)) {
        versionMap[Number(id)] = selected;
      }
    }
    for (const entry of plugin.mods ?? []) {
      const { value: mod } = await loadReference(
        entry,
        pluginSource,
        modSchema,
      );
      mods.push({
        content: mod.content,
        fileUri:
          mod.fileUri ?? `inmem+profile://${preset.id}/mod-${mods.length}.gts`,
      });
    }
    for (const entry of plugin.static_data_overrides ?? []) {
      const { value } = await loadReference(
        entry,
        pluginSource,
        overridesSchema,
      );
      explicitOverrides.push(...value);
    }
  }
  const resolver = createOfficialVersionResolver(
    baseVersion,
    versionMap,
    analyzeResult,
  );
  const loader = new CustomDataLoader();
  loader.setVersion(resolver);
  for (const mod of mods) {
    try {
      await loader.loadMod(mod.content);
    } catch (cause) {
      throw new Error(`Cannot load Mod ${mod.fileUri}`, { cause });
    }
  }
  const [data, { officialDeckCompatible, customData = [], overrideData = [] }] =
    loader.done();
  if (!officialDeckCompatible) {
    throw new Error(`Profile ${preset.id} is not officialDeckCompatible`);
  }
  const merged = new Map<number, OverrideData>();
  for (const item of [...overrideData, ...explicitOverrides]) {
    merged.set(item.id, { ...merged.get(item.id), ...item });
  }
  return finishProfile(
    {
      id: preset.id,
      name: preset.name ?? preset.id,
      baseVersion,
      officialDeckCompatible: true,
      deck: preset.deck,
      gameConfig,
      versionBehavior,
      versionMap,
      mods,
      assets: {
        version: {
          ...resolver.versionMap,
          // No available $category here. Waiting future solution
        },
        customData,
        overrideData: [...merged.values()],
        officialDeckCompatible,
      },
    },
    data,
  );
}

const presetExtensions = [
  "json",
  "yaml",
  "yml",
  "jsonc",
  "json5",
  "toml",
  "js",
  "ts",
  "cjs",
  "cts",
  "mjs",
  "mts",
];

/** Load the first supported preset in a directory, or null if none exists. */
export async function loadPreset(
  directory: string | URL,
): Promise<CompiledProfile | null> {
  const path = directory instanceof URL ? fileURLToPath(directory) : directory;
  for (const extension of presetExtensions) {
    const source = pathToFileURL(join(path, `preset.${extension}`));
    try {
      await stat(source);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw cause;
    }
    try {
      const { value } = await loadReference(source.href, source, presetSchema);
      return await compilePreset(value, source);
    } catch (cause) {
      throw new Error(`Cannot compile Preset ${source.href}`, { cause });
    }
  }
  return null;
}

export async function loadPresets(
  directory: string | URL,
  { recursive = false } = {},
): Promise<CompiledProfile[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive });
  const profiles: CompiledProfile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = await loadPreset(join(entry.parentPath, entry.name));
    if (profile) profiles.push(profile);
  }
  return profiles;
}
