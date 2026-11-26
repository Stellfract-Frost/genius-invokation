// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { ref, setup, Character, State, Card, DiceCount, $ } from "#test";
import { test, expect } from "vitest";
import {
  Game,
  StateSymbol,
  deserializeGameStateLog,
  exposeState,
  getRuleRuntime,
  serializeGameStateLog,
  type Mutation,
} from "@gi-tcg/core";
import getData from "@gi-tcg/data";
import {
  CountdownToTheShow2,
  CountdownToTheShow3,
  ForbiddenKnowledge,
} from "@gi-tcg/data/internal/cards/event/other.gts";
import {
  LumenstoneAdjuvant,
  Nre,
} from "@gi-tcg/data/internal/cards/support/item.gts";
import { Ganyu } from "@gi-tcg/data/internal/characters/cryo/ganyu.gts";
import {
  DivineMarksmanship,
  SkywardSonnet,
  Venti,
} from "@gi-tcg/data/internal/characters/anemo/venti.gts";
import { MondstadtHashBrown } from "@gi-tcg/data/internal/cards/event/food.gts";
import { ChangingShifts } from "@gi-tcg/data/internal/cards/event/other.gts";
import { CurseOfTheUndercurrent } from "@gi-tcg/data/internal/characters/hydro/abyss_herald_wicked_torrents.gts";

test("regeneration: 回合结束双方全体回复 1 点生命", async () => {
  const c = setup(
    <State config={{ roomRules: ["regeneration"] }}>
      <Character my active def={Venti} v={{ health: 5 }} />
      <Character opp active v={{ health: 6 }} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  c.expect($.my.active).toHaveVariable({ health: 6 });
  c.expect($.opp.active).toHaveVariable({ health: 7 });
});

test("noHeal: 治疗量为 0，但不阻止治疗结算", async () => {
  const target = ref();
  const c = setup(
    <State config={{ roomRules: ["noHeal"] }}>
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.card(MondstadtHashBrown, target);
  c.expect($.my.active).toHaveVariable({ health: 5 });
});

test("noHeal off: 同样操作应回复 2 点生命", async () => {
  const target = ref();
  const c = setup(
    <State>
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.card(MondstadtHashBrown, target);
  c.expect($.my.active).toHaveVariable({ health: 7 });
});

test("undercurrent: 奇数回合开始时双方获得 2 层暗流的诅咒", async () => {
  const c = setup(
    <State
      phase="roll"
      roundNumber={1}
      config={{ roomRules: ["undercurrent"] }}
    >
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  c.expect($.my.combatStatus.def(CurseOfTheUndercurrent)).toHaveVariable({
    usage: 2,
  });
  c.expect($.opp.combatStatus.def(CurseOfTheUndercurrent)).toHaveVariable({
    usage: 2,
  });
});

test("undercurrent: 偶数回合不触发", async () => {
  const c = setup(
    <State
      phase="roll"
      roundNumber={2}
      config={{ roomRules: ["undercurrent"] }}
    >
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  c.expect($.my.combatStatus.def(CurseOfTheUndercurrent)).toNotExist();
});

test("extraDraw: 开局手牌数为 7", () => {
  const state = Game.createInitialState({
    decks: [
      { characters: [], cards: [] },
      { characters: [], cards: [] },
    ],
    data: {
      characters: new Map(),
      entities: new Map(),
      attachments: new Map(),
      extensions: new Map(),
    },
    roomRules: ["extraDraw"],
  });
  expect(state.config.initialHandsCount).toBe(7);
});

test("extraDie: 回合开始额外获得 1 个万能骰", async () => {
  const c = setup(
    <State config={{ roomRules: ["extraDie"] }}>
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  expect(c.state.players[0].dice.length).toBe(9);
  expect(c.state.players[1].dice.length).toBe(9);
});

test("shiftingCost: 减费增量叠加在当前费用上", async () => {
  const target = ref();
  const c = setup(
    <State config={{ roomRules: ["shiftingCost"] }}>
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} v={{ ruleCost: -1 }} />
    </State>,
  );
  // 原费用 1 + 增量 -1 = 0，无需任何骰子即可打出
  await c.me.card(MondstadtHashBrown, target);
  c.expect($.my.active).toHaveVariable({ health: 7 });
});

test("shiftingCost: 增费增量叠加在当前费用上", async () => {
  const target = ref();
  const c = setup(
    <State config={{ roomRules: ["shiftingCost"] }}>
      <DiceCount my count={8} />
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} v={{ ruleCost: 1 }} />
    </State>,
  );
  // 原费用 1 + 增量 1 = 2，应消耗 2 个骰子
  await c.me.card(MondstadtHashBrown, target);
  expect(c.state.players[0].dice.length).toBe(6);
});

test("shiftingCost: 未设置 ruleCost 的手牌仍按原费用计算", async () => {
  const target = ref();
  const c = setup(
    <State config={{ roomRules: ["shiftingCost"] }}>
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  // 没有 ruleCost 变量时不覆写，行为与原版一致
  c.expect($.my.active).toHaveVariable({ health: 5 });
});

test("shiftingCost: 回合开始时重分配，且手牌总费用不变", async () => {
  const c = setup(
    <State config={{ roomRules: ["shiftingCost"] }}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  const deltas = c.state.players[0].hands.map(
    (card) => card.variables.ruleCost ?? 0,
  );
  // 增费与减费成对，增量之和必须为 0
  expect(deltas.reduce((acc, value) => acc + value, 0)).toBe(0);
  expect(deltas.some((value) => value === 1)).toBe(true);
  expect(deltas.some((value) => value === -1)).toBe(true);
});

test("shiftingCost: 上一回合的增量不参与本回合分配基准", async () => {
  const c = setup(
    <State config={{ roomRules: ["shiftingCost"] }}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} v={{ ruleCost: 3 }} />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  const deltas = c.state.players[0].hands.map(
    (card) => card.variables.ruleCost ?? 0,
  );
  // 旧增量（+1）被丢弃并重新分配，新增量之和仍为 0
  expect(deltas.reduce((acc, value) => acc + value, 0)).toBe(0);
  expect(deltas.every((value) => Math.abs(value) <= 1)).toBe(true);
});

test("shiftingCost: 没有规则时不会给手牌写入费用覆盖", async () => {
  const c = setup(
    <State>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  const costs = c.state.players[0].hands.map(
    (card) => card.variables.ruleCost,
  );
  expect(costs.every((value) => typeof value === "undefined")).toBe(true);
});

test("restraint: 每回合最多打出 7 张手牌", async () => {
  const c = setup(
    <State config={{ roomRules: ["restraint"] }}>
      <Character my active def={Venti} />
      <Character my def={Venti} />
      <Character opp active />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
    </State>,
  );
  for (let i = 0; i < 7; i++) {
    await c.me.card(ChangingShifts);
  }
  await expect(c.me.card(ChangingShifts)).rejects.toThrow();
});

test("chaos: 每轮抽遍回合增益，跳过只能在开局结算的膨胀", async () => {
  const c = setup(
    <State config={{ roomRules: ["chaos"] }}>
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  const drawn = [];
  for (let round = 0; round < 4; round++) {
    await c.me.end();
    await c.opp.end();
    drawn.push(getRuleRuntime(c.state).chaosActive);
  }
  expect(new Set(drawn)).toEqual(
    new Set(["extraDraw", "shiftingCost", "regeneration", "extraDie"]),
  );
});

test("extraDraw + forbiddenKnowledge: 开局抽 7 张并塞入 6 张禁忌知识", async () => {
  const c = setup(
    <State
      phase="initHands"
      config={{ roomRules: ["extraDraw", "forbiddenKnowledge"] }}
    >
      <Character my def={Venti} />
      <Character opp def={Venti} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
    </State>,
  );
  // 等待 initHands 抽牌与塞牌完成（随后会停在 switchHands 交互上）
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(c.state.players[0].hands.length).toBe(7);
  // 10 - 7 + 6 = 9
  expect(c.state.players[0].pile.length).toBe(9);
  // 对方牌库为空，抽不到牌，但禁忌知识仍会塞入 6 张
  expect(c.state.players[1].hands.length).toBe(0);
  expect(c.state.players[1].pile.length).toBe(6);
});

test("extraDraw: 即使指定了初始手牌数也强制为 7", () => {
  const state = Game.createInitialState({
    decks: [
      { characters: [], cards: [] },
      { characters: [], cards: [] },
    ],
    data: {
      characters: new Map(),
      entities: new Map(),
      attachments: new Map(),
      extensions: new Map(),
    },
    roomRules: ["extraDraw"],
    initialHandsCount: 5,
  });
  expect(state.config.initialHandsCount).toBe(7);
});

test("state: 本回合生效规则随对局状态暴露给双方", async () => {
  const c = setup(
    <State config={{ roomRules: ["regeneration", "noHeal"] }}>
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  for (const who of [0, 1] as const) {
    const exposed = exposeState(who, c.state);
    expect(exposed.activeRule).toEqual(["regeneration", "noHeal"]);
    expect(exposed.chaosEnabled).toBe(false);
  }
});

test("state: 混沌局暴露本回合抽到的规则", async () => {
  const c = setup(
    <State phase="roll" roundNumber={1} config={{ roomRules: ["chaos"] }}>
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const exposed = exposeState(0, c.state);
  expect(exposed.chaosEnabled).toBe(true);
  expect(exposed.activeRule.length).toBe(1);
});

test("doubleHealth: 双方角色初始生命变为原值的 1.5 倍，向下取整", () => {
  const cards = Array.from({ length: 30 }, () => 333006);
  const state = Game.createInitialState({
    decks: [
      { characters: [1301, 1103, 1510], cards },
      { characters: [1301, 1103, 1510], cards },
    ],
    data: getData(),
    roomRules: ["doubleHealth"],
  });
  for (const who of [0, 1] as const) {
    expect(state.players[who].characters.map(({ variables }) => variables.maxHealth))
      .toEqual([15, 15, 16]);
    expect(state.players[who].characters.map(({ variables }) => variables.health))
      .toEqual([15, 15, 16]);
  }
});

test("skillFatigue: 技能用过一次后费用 +1", async () => {
  const c = setup(
    <State config={{ roomRules: ["skillFatigue"] }}>
      <DiceCount my count={12} />
      <Character my active def={Venti} />
      <Character opp active def={Venti} />
    </State>,
  );
  // 普攻原本 3 费（1 风 + 2 无色）
  await c.me.skill(DivineMarksmanship);
  expect(c.state.players[0].dice.length).toBe(9);
  // 对手先结束回合，把行动权交还给我
  await c.opp.end();
  // 再次使用同一技能：费用 +1 => 4 费，且加的是**无色骰**（1 风 + 3 无色）
  {
    const actions = await (c as any).game.availableActions();
    const attack = actions.find(
      (a: any) => a.skill?.definition.id === 15031 && a.validity === 0,
    );
    expect(
      [...(attack.cost as Map<number, number>).entries()].sort(
        (x, y) => x[0] - y[0],
      ),
    ).toEqual([
      [0, 3],
      [5, 1],
    ]);
  }
  await c.me.skill(DivineMarksmanship);
  expect(c.state.players[0].dice.length).toBe(5);
});

test("skillFatigue: 双方技能记录互不影响", async () => {
  const c = setup(
    <State config={{ roomRules: ["skillFatigue"] }}>
      <DiceCount my count={12} />
      <DiceCount opp count={12} />
      <Character my active def={Venti} />
      <Character opp active def={Venti} />
    </State>,
  );
  // 我方先用一次普攻
  await c.me.skill(DivineMarksmanship);
  expect(c.state.players[0].dice.length).toBe(9);
  // 对手第一次使用同一技能，仍按原价 3 费（不共享我方的记录）
  await c.opp.skill(DivineMarksmanship);
  expect(c.state.players[1].dice.length).toBe(9);
  // 我方第二次使用才 +1 => 4 费
  await c.me.skill(DivineMarksmanship);
  expect(c.state.players[0].dice.length).toBe(5);
});

test("skillFatigue: 未使用过的技能不加价", async () => {
  const c = setup(
    <State config={{ roomRules: ["skillFatigue"] }}>
      <DiceCount my count={12} />
      <Character my active def={Venti} />
      <Character opp active def={Venti} />
    </State>,
  );
  // 元素战技 3 费，未使用过，按原价
  await c.me.skill(SkywardSonnet);
  expect(c.state.players[0].dice.length).toBe(9);
});

test("forbiddenKnowledge: 禁忌知识均匀分布在牌库中", async () => {
  const c = setup(
    <State phase="initHands" config={{ roomRules: ["forbiddenKnowledge"] }}>
      <Character my def={Venti} />
      <Character opp def={Venti} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
    </State>,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pile = c.state.players[0].pile;
  const indices = pile.flatMap((card, index) =>
    card.definition.id === 301020 ? [index] : [],
  );
  expect(indices.length).toBe(6);
  for (let i = 1; i < indices.length; i++) {
    // 均匀插入后任意两张禁忌之间至少隔一张牌
    expect(indices[i]! - indices[i - 1]!).toBeGreaterThan(1);
  }
});

test("circulation: 回合结束未打出的手牌进入弃牌堆，并洗回牌库抽出", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  // 2 张手牌进弃牌堆 -> 牌库不足 5 张时洗回 -> 重新抽到手上
  expect(c.state.players[0].discard.length).toBe(0);
  expect(c.state.players[0].hands.length).toBe(2);
});

test("circulation: 打出的事件牌进入弃牌堆", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Venti} />
      <Character my def={Venti} />
      <Character opp active />
      <Card my def={ChangingShifts} />
    </State>,
  );
  await c.me.card(ChangingShifts);
  expect(c.state.players[0].hands.length).toBe(0);
  expect(c.state.players[0].discard.length).toBe(1);
  expect(c.state.players[0].discard[0]!.definition.id).toBe(332002);
});

test("circulation: 没有该规则时手牌不会在回合结束被弃置", async () => {
  const c = setup(
    <State roundNumber={3}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  expect(c.state.players[0].hands.length).toBe(2);
  expect(c.state.players[0].pile.length).toBe(0);
  expect(c.state.players[0].discard.length).toBe(0);
});

test("circulation: 衍生牌使用后不进入弃牌堆", async () => {
  const target = ref();
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} generated />
    </State>,
  );
  await c.me.card(MondstadtHashBrown, target);
  expect(c.state.players[0].discard.length).toBe(0);
});

test("circulation: 衍生牌在回合结束时保留在手上", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} generated />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  const hands = c.state.players[0].hands;
  expect(hands.some((card) => card.generated)).toBe(true);
});

test("circulation: 抽牌途中牌库抽空会立刻用弃牌堆补齐", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
      <Card my def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  // 三次抽空依次生成 0、1、2 张禁忌知识。第 5 抽之后正好剩 1 张。
  expect(c.state.players[0].hands.map((card) => card.definition.id)).toEqual([
    MondstadtHashBrown,
    MondstadtHashBrown,
    MondstadtHashBrown,
    ForbiddenKnowledge,
    ForbiddenKnowledge,
  ]);
  expect(c.state.players[0].pile.map((card) => card.definition.id)).toEqual([
    ForbiddenKnowledge,
  ]);
  expect(c.state.players[0].discard.length).toBe(0);
});

test("circulation: 第三回合每名玩家首次抽空都生成零张禁忌知识", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }} roundNumber={3}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
      <Card opp pile def={MondstadtHashBrown} />
      <Card opp pile def={MondstadtHashBrown} />
      <Card opp pile def={MondstadtHashBrown} />
      <Card opp pile def={MondstadtHashBrown} />
      <Card opp pile def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  for (const player of c.state.players) {
    expect(player.hands).toHaveLength(5);
    expect(player.pile).toHaveLength(0);
  }
});

test("circulation: 即使抽牌正好结束，抽空也立即随机洗回弃牌堆", async () => {
  const orders = new Set<string>();
  for (const seed of [1, 2, 3]) {
    const c = setup(
      <State config={{ roomRules: ["circulation"] }} random={seed}>
        <Character my active def={Venti} />
        <Character opp active />
        <Card my def={ChangingShifts} />
        <Card my def={Nre} />
        <Card my def={CountdownToTheShow3} />
        <Card my pile def={MondstadtHashBrown} />
        <Card my pile def={MondstadtHashBrown} />
        <Card my pile def={MondstadtHashBrown} />
        <Card my pile def={MondstadtHashBrown} />
        <Card my pile def={MondstadtHashBrown} />
      </State>,
    );
    await c.me.end();
    await c.opp.end();
    const { pile, discard } = c.state.players[0];
    const cards = pile.map((card) => card.definition.id);
    expect(discard).toHaveLength(0);
    expect(cards).toHaveLength(3);
    expect(new Set(cards)).toEqual(new Set([ChangingShifts, Nre, CountdownToTheShow3]));
    orders.add(cards.join(","));
  }
  expect(orders.size).toBeGreaterThan(1);
});

test.each([
  { maxPileCount: 1, expectedPile: [ForbiddenKnowledge], remaining: 2 },
  {
    maxPileCount: 4,
    expectedPile: [ChangingShifts, ForbiddenKnowledge, ChangingShifts],
    remaining: 0,
  },
])("circulation: 先在弃牌堆生成禁忌知识再洗回（牌库容量 $maxPileCount）", async ({
  maxPileCount, expectedPile, remaining,
}) => {
  const c = setup(
    <State
      dataVersion="v3.3.0"
      config={{ roomRules: ["circulation"], maxPileCount }}
      roundNumber={3}
    >
      <Character my active def={Ganyu} />
      <Character opp active />
      <Card my def={Nre} />
      <Card my def={Nre} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={MondstadtHashBrown} />
      <Card my pile def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.tune(MondstadtHashBrown);
  await c.me.card(Nre);
  expect(c.state.players[0].pile.map((card) => card.definition.id)).toEqual([
    MondstadtHashBrown,
  ]);
  await c.me.tune(ChangingShifts);
  await c.me.tune(ChangingShifts);
  const mutations: Mutation[] = [];
  c.game.onPause = (_state, batch) => {
    mutations.push(...batch);
  };
  await c.me.card(Nre);
  const { pile, discard } = c.state.players[0];
  expect(pile.map((card) => card.definition.id)).toEqual(expectedPile);
  expect(discard.map((card) => card.definition.id)).toEqual(
    Array.from({ length: remaining }, () => ChangingShifts),
  );
  expect(mutations.flatMap((mutation) => {
    if (
      mutation.type === "createEntity" &&
      mutation.value.definition.id === ForbiddenKnowledge
    ) {
      return [`create:${mutation.target.type}`];
    }
    if (mutation.type === "removeEntity" && mutation.reason === "reshuffle") {
      return [`reshuffle:${mutation.from.type}`];
    }
    return [];
  })).toEqual([
    "create:discard",
    ...Array.from({ length: expectedPile.length }, () => "reshuffle:discard"),
    "create:pile",
  ]);
});

test("circulation: 同一回合逐次增加禁忌知识，双方独立计数并在新回合重置", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }} roundNumber={2}>
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={CountdownToTheShow3} />
      <Card my def={CountdownToTheShow3} />
      <Card my pile def={MondstadtHashBrown} />
      <Card opp pile def={MondstadtHashBrown} />
    </State>,
  );
  const countKnowledge = () => {
    const { hands, pile, discard } = c.state.players[0];
    return [...hands, ...pile, ...discard].filter(
      (card) => card.definition.id === ForbiddenKnowledge,
    ).length;
  };
  await c.me.card(CountdownToTheShow3);
  expect(c.state.players[0].pile).toHaveLength(0);
  expect(countKnowledge()).toBe(0);
  await c.me.card(CountdownToTheShow3);
  expect(c.state.players[0].pile).toHaveLength(3);
  expect(countKnowledge()).toBe(6);
  const log = serializeGameStateLog([{ state: c.state, canResume: true }]);
  const [restored] = deserializeGameStateLog(c.state.data, log);
  expect(getRuleRuntime(restored.state).circulationRefills).toEqual({
    roundNumber: 2,
    counts: [4, 0],
  });
  await c.me.end();
  await c.opp.end();
  expect(c.state.players[1].pile).toHaveLength(0);
  expect(c.state.players[1].hands.map((card) => card.definition.id)).toEqual([
    MondstadtHashBrown,
  ]);
  expect(countKnowledge()).toBe(10);
  await c.me.end();
  await c.opp.end();
  await c.me.end();
  await c.opp.end();
  expect(getRuleRuntime(c.state).circulationRefills).toEqual({
    roundNumber: 4,
    counts: [1, 1],
  });
  expect(countKnowledge()).toBe(10);
});

test("circulation: 指定类别抽牌也会先从弃牌堆补空牌库", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }} roundNumber={2}>
      <DiceCount my count={8} />
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={Nre} />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.tune(MondstadtHashBrown);
  await c.me.card(Nre);
  const { hands, pile, discard } = c.state.players[0];
  expect(discard).toHaveLength(0);
  expect(hands.map((card) => card.definition.id)).toEqual([MondstadtHashBrown]);
  expect(pile).toHaveLength(0);
});

test("circulation: 回放还原弃牌堆与特殊规则状态", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <DiceCount my count={8} />
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.tune(MondstadtHashBrown);
  const log = serializeGameStateLog([{ state: c.state, canResume: true }]);
  const [{ state }] = deserializeGameStateLog(c.state.data, log);
  expect(state.players[0].discard[0]?.[StateSymbol]).toBe("entity");
  expect(getRuleRuntime(state)).toEqual(getRuleRuntime(c.state));
  expect(exposeState(0, state).player[0]?.discardCard[0]?.definitionId).toBe(
    MondstadtHashBrown,
  );
});

test("circulation: 旧回放缺少弃牌堆和特殊规则字段时仍可加载", () => {
  const data = getData();
  const deck = { characters: [1101, 1201, 1301], cards: [] };
  const initial = Game.createInitialState({ data, decks: [deck, deck] });
  const log = serializeGameStateLog([{ state: initial, canResume: true }]);
  for (const entry of log.store) {
    if (entry && typeof entry === "object") {
      Reflect.deleteProperty(entry, "discard");
      Reflect.deleteProperty(entry, "roomRules");
    }
  }
  const [{ state }] = deserializeGameStateLog(data, log);
  expect(state.config.roomRules).toEqual([]);
  expect(exposeState(0, state).player.map((p) => p.discardCard)).toEqual([[], []]);
});

test("circulation: 非角色生成的牌不算衍生牌，打出后进入弃牌堆", async () => {
  const target = ref();
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} notInitial />
    </State>,
  );
  await c.me.card(MondstadtHashBrown, target);
  expect(c.state.players[0].discard.length).toBe(1);
});

test("circulation: 打出的牌进入弃牌堆时清除临时效果", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Venti} />
      <Character my def={Venti} />
      <Character opp active />
      <Card my def={ChangingShifts} v={{ ruleCost: -1 }} />
    </State>,
  );
  await c.me.card(ChangingShifts);
  const played = c.state.players[0].discard[0];
  expect(played).toBeDefined();
  // 变化规则写入的临时变量不应残留
  expect(played!.variables.ruleCost ?? 0).toBe(0);
});

test("circulation: 幻戏低费档离手后，弃牌堆里是 3 费原版", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <DiceCount my count={8} />
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={CountdownToTheShow2} />
    </State>,
  );
  await c.me.card(CountdownToTheShow2);
  expect(c.state.players[0].discard.length).toBe(1);
  expect(c.state.players[0].discard[0]!.definition.id).toBe(332032);
});

test("circulation: 调和后牌进入弃牌堆", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <DiceCount my count={8} />
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} />
    </State>,
  );
  await c.me.tune(MondstadtHashBrown);
  expect(c.state.players[0].handCard ?? c.state.players[0].hands.length).toBeDefined();
  expect(c.state.players[0].discard.length).toBe(1);
});

test("circulation: 调和幻戏不崩，且按当时档位进弃牌堆", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <DiceCount my count={8} />
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={CountdownToTheShow2} />
    </State>,
  );
  await c.me.tune(CountdownToTheShow2);
  expect(c.state.players[0].discard.length).toBe(1);
});

test("circulation: 调和流明石触手可及", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <DiceCount my count={8} />
      <Character my active def={Venti} />
      <Character opp active />
      <Card my def={LumenstoneAdjuvant} />
    </State>,
  );
  await c.me.tune(LumenstoneAdjuvant);
  expect(c.state.players[0].discard.length).toBe(1);
});
