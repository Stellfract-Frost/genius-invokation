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

import { DiceType, type DiceRequirement } from "@gi-tcg/typings";
import type { GameState } from "./base/state";
import type { ExtensionDefinition } from "./base/extension";
import type { SkillDefinition } from "./base/skill";
import { DEFAULT_VERSION_INFO } from "./base/version";

/**
 * 「特殊规则」是房间级别的对局修饰，由房主在创建房间时选择，对双方同时生效。
 *
 * 设计约束：
 * 1. 规则只在 core 服务端执行，双方状态通过 mutation 同步，保证不会不同步。
 * 2. 规则运行时状态存放在一个隐藏的 extension 里，`exposeState` 不会把它发给前端，
 *    因此玩家和观战者都看不到内部计数；但 mutation 会进回放日志，断线重连和复盘正常。
 * 3. 规则产生的效果尽量走既有结算原语（heal / drawCardsPlain / insertEntityOnStage），
 *    以便正确触发相关的响应类效果。
 */
export type RoomRuleId =
  /** 混沌：每回合随机一个正面规则，不重复，抽完重开一轮 */
  | "chaos"
  /** 抽牌：对局开始时手牌 7 张 */
  | "extraDraw"
  /** 变化：每回合开始时在总费用不变的前提下重新分配手牌费用 */
  | "shiftingCost"
  /** 回复：每回合结束双方全体回复 1 点生命 */
  | "regeneration"
  /** 增费：每回合开始获得 1 个万能元素骰 */
  | "extraDie"
  /** 膨胀：双方角色生命上限与当前生命翻倍 */
  | "doubleHealth"
  /** 疲劳：技能用过一次后费用 +1（上限 +1） */
  | "skillFatigue"
  /** 暗流：奇数回合开始双方各获得 2 层「暗流的诅咒」 */
  | "undercurrent"
  /** 束缚：每回合最多打出 7 张手牌 */
  | "restraint"
  /** 禁疗：治疗量归零（复活除外） */
  | "noHeal"
  /** 禁忌：开局双方牌库随机塞入 6 张「禁忌知识」 */
  | "forbiddenKnowledge";

export type RoomRulePolarity = "buff" | "debuff" | "special";

export interface RoomRuleMeta {
  readonly id: RoomRuleId;
  readonly name: string;
  readonly description: string;
  readonly polarity: RoomRulePolarity;
}

export const ROOM_RULES: readonly RoomRuleMeta[] = [
  {
    id: "chaos",
    name: "混沌",
    description: "每回合随机获得一个正面规则，且不会重复；全部用完后重新开启一轮。",
    polarity: "special",
  },
  {
    id: "extraDraw",
    name: "抽牌",
    description: "对局开始时手牌数量变为 7 张。",
    polarity: "buff",
  },
  {
    id: "shiftingCost",
    name: "变化",
    description:
      "每回合开始时统计手牌总费用，随机让手中所有手牌增费、减费或不变，重新分配后手牌总费用保持不变。",
    polarity: "buff",
  },
  {
    id: "regeneration",
    name: "回复",
    description: "每回合结束时，双方所有角色回复 1 点生命。",
    polarity: "buff",
  },
  {
    id: "extraDie",
    name: "增费",
    description: "每回合开始时，双方各获得 1 个万能元素骰。",
    polarity: "buff",
  },
  {
    id: "doubleHealth",
    name: "膨胀",
    description: "双方所有角色的生命上限翻倍，当前生命同步翻倍。",
    polarity: "buff",
  },
  {
    id: "skillFatigue",
    name: "疲劳",
    description:
      "本回合内，每个技能（含普通攻击）使用过一次后，再次使用该技能时费用 +1（最多 +1），下回合重置；双方独立计算。",
    polarity: "debuff",
  },
  {
    id: "undercurrent",
    name: "暗流",
    description:
      "每奇数回合开始时，双方各获得 2 层「暗流的诅咒」：使用元素战技或元素爆发时多花费 1 个元素骰，可用 2 次。",
    polarity: "debuff",
  },
  {
    id: "restraint",
    name: "束缚",
    description: "每回合最多只能打出 7 张手牌。",
    polarity: "debuff",
  },
  {
    id: "noHeal",
    name: "禁疗",
    description: "所有治疗量变为 0（复活除外），治疗仍会正常结算。",
    polarity: "debuff",
  },
  {
    id: "forbiddenKnowledge",
    name: "禁忌",
    description: "对局开始时，双方牌库中随机塞入 6 张「禁忌知识」。",
    polarity: "debuff",
  },
];

const ROOM_RULE_MAP: ReadonlyMap<string, RoomRuleMeta> = new Map(
  ROOM_RULES.map((rule) => [rule.id, rule]),
);

export function isRoomRuleId(value: unknown): value is RoomRuleId {
  return typeof value === "string" && ROOM_RULE_MAP.has(value);
}

/** 混沌抽取池：只有正面规则 */
export const CHAOS_POOL: readonly RoomRuleId[] = ROOM_RULES.filter(
  (rule) => rule.polarity === "buff",
).map((rule) => rule.id);

/** 混沌里「抽牌」的回合版效果：立即抽 2 张，而不是把开局手牌改成 7 张 */
export const CHAOS_EXTRA_DRAW_COUNT = 2;

/** 「抽牌」规则下的开局手牌数 */
export const EXTRA_DRAW_HANDS_COUNT = 7;

/** 束缚每回合的可打出张数 */
export const RESTRAINT_PLAY_LIMIT = 7;

/** 暗流每回合给予的「暗流的诅咒」层数 */
export const UNDERCURRENT_STACKS = 2;

/** 禁忌知识开局塞入的张数 */
export const FORBIDDEN_KNOWLEDGE_COUNT = 6;

/** 部分规则需要直接引用数据层的定义 id */
export const RULE_RELATED_DEFINITION_IDS = {
  /** 战斗状态：暗流的诅咒（使用元素战技/爆发时 +1 骰，可用 2 次） */
  curseOfTheUndercurrent: 122033,
  /** 行动牌：禁忌知识 */
  forbiddenKnowledge: 301020,
} as const;

/**
 * 规则运行时状态。只存在于 extension state 中，不暴露给前端。
 */
export interface RoomRuleRuntimeState {
  /** 本轮混沌尚未抽到的规则 */
  readonly chaosRemaining: readonly RoomRuleId[];
  /** 本回合混沌给出的规则 */
  readonly chaosActive: RoomRuleId | null;
  /** 本回合双方已打出的手牌数 */
  readonly playedCards: readonly [number, number];
  /**
   * 本回合双方各自已经用过的技能定义 id（「疲劳」规则使用）。
   * 下标 0/1 对应玩家，回合开始时清空，双方互不影响。
   */
  readonly usedSkills: readonly [readonly number[], readonly number[]];
}

const DEFAULT_RUNTIME_STATE: RoomRuleRuntimeState = {
  chaosRemaining: CHAOS_POOL,
  chaosActive: null,
  playedCards: [0, 0],
  usedSkills: [[], []],
};

/** 规则状态载体 extension 的保留 id，避开数据层定义 */
export const RULE_EXTENSION_ID = 990_001;

export const roomRuleExtensionDefinition: ExtensionDefinition = {
  __definition: "extensions",
  type: "extension",
  id: RULE_EXTENSION_ID,
  version: DEFAULT_VERSION_INFO,
  description: "Room special rules runtime state",
  schema: {},
  initialState: DEFAULT_RUNTIME_STATE,
  skills: [],
};

/**
 * 规则效果自身需要一个 `via`。它是一个不含任何技能的空被动技能定义，
 * 仅用于给 heal / insertEntityOnStage 之类的原语提供结算上下文。
 */
export const RULE_PLACEHOLDER_SKILL = {
  __definition: "skills",
  id: RULE_EXTENSION_ID,
  name: "",
  type: "passive",
  triggerOn: null,
  filter: () => true,
  skills: [],
} as unknown as SkillDefinition;

export function getRuleRuntime(state: GameState): RoomRuleRuntimeState {
  const ext = state.extensions.find(
    (e) => e.definition.id === RULE_EXTENSION_ID,
  );
  if (!ext) {
    return DEFAULT_RUNTIME_STATE;
  }
  return ext.state as RoomRuleRuntimeState;
}

export function getRoomRules(state: GameState): readonly RoomRuleId[] {
  return state.config.roomRules ?? [];
}

export function hasRule(state: GameState, id: RoomRuleId): boolean {
  return getRoomRules(state).includes(id);
}

/**
 * 规则在本回合是否生效。
 *
 * - 房主直接勾选的规则整局生效；
 * - 混沌抽到的规则仅在本回合生效（`chaosActive`）。
 */
export function isRuleActiveThisRound(
  state: GameState,
  id: RoomRuleId,
): boolean {
  if (hasRule(state, id)) {
    return true;
  }
  if (!hasRule(state, "chaos")) {
    return false;
  }
  return getRuleRuntime(state).chaosActive === id;
}

/** 本回合打出的手牌数 */
export function getPlayedCards(state: GameState, who: 0 | 1): number {
  return getRuleRuntime(state).playedCards[who] ?? 0;
}

/**
 * 从混沌池中抽一个规则。
 *
 * 返回新的运行时状态；池空时重置为完整池再抽，
 * 因此「全部用完仍未结束 → 开启新一轮」。
 */
export function drawChaosRule(
  runtime: RoomRuleRuntimeState,
  random: () => number,
): RoomRuleRuntimeState {
  let remaining = runtime.chaosRemaining.filter((id) => CHAOS_POOL.includes(id));
  if (remaining.length === 0) {
    remaining = [...CHAOS_POOL];
  }
  const index = random() % remaining.length;
  const picked = remaining[index]!;
  return {
    ...runtime,
    chaosRemaining: remaining.filter((_, i) => i !== index),
    chaosActive: picked,
  };
}

/**
 * 计算某张手牌的「变化」费用。
 *
 * 保留原本的元素骰类型，只改写骰子数量；能量与秘传费用不受影响。
 */
export function shiftedCostOf(
  originalCost: ReadonlyMap<DiceType, number>,
  value: number,
): DiceRequirement {
  let elementType: DiceType | null = null;
  let energy = 0;
  let legend = 0;
  for (const [type, count] of originalCost) {
    if (type === DiceType.Energy) {
      energy += count;
    } else if (type === DiceType.Legend) {
      legend += count;
    } else if (elementType === null && count > 0) {
      elementType = type;
    }
  }
  const result: DiceRequirement = new Map();
  if (value > 0) {
    result.set(elementType ?? DiceType.Aligned, value);
  }
  if (energy > 0) {
    result.set(DiceType.Energy, energy);
  }
  if (legend > 0) {
    result.set(DiceType.Legend, legend);
  }
  return result;
}

/**
 * 「疲劳」：给技能的所需骰子整体 +1。
 *
 * 加价优先落在**无色骰**上（普通攻击本身就是「元素 1 + 无色 2」，加价应为无色），
 * 没有无色部分时才加在同元素骰上，仍找不到就退化成万能骰。
 */
export function increaseCostByOne(
  originalCost: ReadonlyMap<DiceType, number>,
): DiceRequirement {
  const result: DiceRequirement = new Map(originalCost);
  const voidCount = result.get(DiceType.Void) ?? 0;
  if (voidCount > 0) {
    result.set(DiceType.Void, voidCount + 1);
    return result;
  }
  let elementType: DiceType | null = null;
  for (const [type, count] of originalCost) {
    if (type === DiceType.Energy || type === DiceType.Legend) {
      continue;
    }
    if (count > 0) {
      elementType = type;
      break;
    }
  }
  const targetType = elementType ?? DiceType.Aligned;
  result.set(targetType, (result.get(targetType) ?? 0) + 1);
  return result;
}

function pickSome(
  items: readonly number[],
  count: number,
  random: () => number,
): number[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = random() % (i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

/**
 * 「变化」：在**总费用不变**的前提下，为每张手牌决定一个费用增量。
 *
 * 每张牌只会被增费（+1）、减费（-1）或不变（0），且增费与减费成对出现，
 * 因此所有手牌的增量之和为 0，费用总和严格守恒。
 *
 * 返回的是**增量**而不是绝对费用：应用时叠加在当前费用之上，
 * 这样其它效果（装备、支援、手牌 buff）给出的减费不会被覆盖。
 */
export function redistributeShiftingDeltas(
  baseCosts: readonly number[],
  random: () => number,
): number[] {
  const deltas = baseCosts.map(() => 0);
  const decreaseCandidates = baseCosts.flatMap((cost, index) =>
    cost > 0 ? [index] : [],
  );
  const maxPairs = Math.min(
    Math.floor(baseCosts.length / 2),
    decreaseCandidates.length,
  );
  if (maxPairs === 0) {
    // 只剩 1 张牌或全部 0 费，无法成对调整
    return deltas;
  }
  const pairs = 1 + (random() % maxPairs);
  const decreaseIndices = pickSome(decreaseCandidates, pairs, random);
  const increaseIndices = pickSome(
    baseCosts.flatMap((_, index) =>
      decreaseIndices.includes(index) ? [] : [index],
    ),
    pairs,
    random,
  );
  for (const index of increaseIndices) {
    deltas[index] = 1;
  }
  for (const index of decreaseIndices) {
    deltas[index] = -1;
  }
  return deltas;
}
