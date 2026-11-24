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

import console from "node:console";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CURRENT_VERSION,
  createOfficialVersionResolver,
  getVersionBehavior,
  mergeGameConfigWithDefault,
  playSkillOfCard,
  type GameData,
  type Version,
} from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import { analyzeResult } from "@gi-tcg/data-code-analyzer";
import { CustomDataLoader } from "@gi-tcg/custom-data-loader";
import { DiceType } from "@gi-tcg/typings";
import { PLAYCOST_OVERRIDE } from "./char-stats";
import { createPracticeResolver } from "./practice-resolver";
import type { OverrideData, PlayCost } from "@gi-tcg/assets-manager";
import type {
  CompiledProfile,
  CompiledPreset,
  ModSource,
  Preset,
  Profile,
  ProfileDeckConfig,
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
 * baseVersion 决定对局规则，versionMap 决定角色及技能的选版。
 * 行动牌使用赛事配置，角色池由 deck 黑名单限制。
 */
export function customProfile(
  baseVersion: Version,
  options: {
    id: string;
    name: string;
    versionMap?: Record<number, Version>;
    fieldOverrides?: Record<number, { hp?: number; maxEnergy?: number }>;
    deck?: ProfileDeckConfig;
    /**
     * 行动牌的数据来源（赛事配置的编译产物）。
     * 多版本即比赛版本：手牌一律用赛事那份数据，角色仍按所选版本。
     */
    cardDataFrom: CompiledPreset;
  },
): CompiledProfile {
  const source = options.cardDataFrom;
  const cardIds = new Set(
    [...source.data.entities.values()]
      .filter(playSkillOfCard)
      .map(({ id }) => id),
  );
  const dependencies = new Map<number, Set<number>>();
  for (const { id, dependencies: ids } of analyzeResult) {
    const edges = dependencies.get(id) ?? new Set<number>();
    ids.forEach((id) => edges.add(id));
    dependencies.set(id, edges);
  }
  const characterIds = new Set(source.data.characters.keys());
  for (const id of characterIds) {
    for (const dependency of dependencies.get(id) ?? []) {
      if (!cardIds.has(dependency)) {
        characterIds.add(dependency);
      }
    }
  }
  // Shared dependencies follow the selected character skills. Card-only
  // dependencies, such as generated cards and support counters, follow Live.
  const cardDataIds = new Set(cardIds);
  for (const id of cardDataIds) {
    for (const dependency of dependencies.get(id) ?? []) {
      if (!characterIds.has(dependency)) {
        cardDataIds.add(dependency);
      }
    }
  }
  const versionMap = Object.fromEntries(
    Object.entries(options.versionMap ?? {}).filter(
      ([id]) => !cardDataIds.has(Number(id)),
    ),
  );
  const rulesVersion = baseVersion;
  const dataVersion = source.profile.baseVersion;
  // 多版本角色允许本体与技能选用不同的历史版本。
  const resolver = createPracticeResolver(
    dataVersion,
    versionMap,
    analyzeResult,
  );
  if (resolver.log.conflicts.length > 0) {
    console.warn(
      `[practice] ${options.id} 依赖冲突 ${resolver.log.conflicts.length} 处（已按旧版本保留）`,
    );
  }
  const data = source.resolveData(resolver);
  // 集所长的字段级覆盖：本体取池内血量最高的版本，充能取池内最低值。
  // 注意：GameData 里的角色定义是全局共享的，直接改会污染其它 profile，
  // 因此这里做写时复制：只替换被覆盖的角色，并新建 Map。
  let patched = data;
  const ovEntries = Object.entries(options.fieldOverrides ?? {});
  type RawSkill = {
    id: number;
    skillType: string | null;
    playCost?: PlayCost[];
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
    [DiceType.Aligned]: "GCG_COST_DICE_SAME",
    [DiceType.Energy]: "GCG_COST_ENERGY",
    [DiceType.Legend]: "GCG_COST_LEGEND",
  };
  // 费用覆盖：除了固定规则（如魔偶剑鬼），充能被压低的角色，其爆发费用也要
  // 跟着降到同一个值，否则会出现「面板 2 充能、大招仍要 3 充能」。
  const costOverrides: Record<number, PlayCost[]> = {
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
        nextVarConfigs.maxEnergy = {
          ...vc.maxEnergy,
          initialValue: ov.maxEnergy,
        };
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
  const finalData = {
    ...patched,
    entities: new Map(patched.entities),
    extensions: new Map(patched.extensions),
    attachments: new Map(patched.attachments),
  };
  const {
    version: sourceVersion,
    customData,
    overrideData = [],
  } = source.profile.assets;
  const assetVersions: Record<number, string> & {
    $base: string;
    $category: string;
  } = {
    ...resolver.versionMap,
    $category: dataVersion,
  };
  const officialCards = getData(dataVersion).entities;
  const assetOverrides = new Map(overrideData.map((item) => [item.id, item]));
  for (const id of cardDataIds) {
    const entity = source.data.entities.get(id);
    const extension = source.data.extensions.get(id);
    const attachment = source.data.attachments.get(id);
    if (entity) {
      finalData.entities.set(id, entity);
      const skill = playSkillOfCard(entity);
      if (skill && entity !== officialCards.get(id)) {
        // The deck editor reads the base category in bulk. Publish the same
        // costs as the engine so those cards don't inherit the category cost.
        const playCost: PlayCost[] = [
          ...skill.initiativeSkillConfig.requiredCost,
        ].map(([type, count]) => ({
          type: diceCostType[type] ?? String(type),
          count,
        }));
        assetOverrides.set(id, { ...assetOverrides.get(id), id, playCost });
      }
    }
    if (extension) {
      finalData.extensions.set(id, extension);
    }
    if (attachment) {
      finalData.attachments.set(id, attachment);
    }
    const version =
      typeof sourceVersion === "string"
        ? sourceVersion
        : (sourceVersion[id] ?? sourceVersion.$base);
    if (version === dataVersion) {
      delete assetVersions[id];
    } else {
      assetVersions[id] = version;
    }
  }

  return finishProfile(
    {
      id: options.id,
      name: options.name,
      baseVersion: rulesVersion,
      officialDeckCompatible: true,
      gameConfig: { ...DEFAULT_GAME_CONFIG },
      versionBehavior: {
        ...getVersionBehavior(rulesVersion),
        discardMaxCostHandsAbortPreview:
          source.profile.versionBehavior.discardMaxCostHandsAbortPreview,
      },
      versionMap,
      mods: source.profile.mods,
      ...(options.deck ? { deck: options.deck } : {}),
      assets: {
        // 逐实体版本映射：前端据此按实体版本渲染角色/技能/卡牌，而不是只按 base 显示
        version: assetVersions,
        customData,
        // 字段级覆盖（如集所长压低的充能）必须一起下发，否则前端仍按静态数据显示
        overrideData: [
          ...assetOverrides.values(),
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
        officialDeckCompatible: true,
      },
    },
    finalData,
  );
}

export async function compilePreset(
  preset: Preset,
  source: URL,
): Promise<CompiledPreset> {
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
  const compiled = finishProfile(
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
        version: resolver.versionMap,
        customData,
        overrideData: [...merged.values()],
        officialDeckCompatible,
      },
    },
    data,
  );
  return { ...compiled, resolveData: (resolver) => loader.done(resolver)[0] };
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
): Promise<CompiledPreset | null> {
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
): Promise<CompiledPreset[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive });
  const profiles: CompiledPreset[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = await loadPreset(join(entry.parentPath, entry.name));
    if (profile) profiles.push(profile);
  }
  return profiles;
}
