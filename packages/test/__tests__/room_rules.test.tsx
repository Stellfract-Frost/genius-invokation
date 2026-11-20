// Copyright (C) 2026 Piovium Labs
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

import { ref, setup, Character, State, Card, $ } from "#test";
import { test, expect } from "vitest";
import { Game } from "@gi-tcg/core";
import { Venti } from "@gi-tcg/data/internal/characters/anemo/venti.gts";
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

test("undercurrent: 每回合开始双方获得 2 层暗流的诅咒", async () => {
  const c = setup(
    <State config={{ roomRules: ["undercurrent"] }}>
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  c.expect($.my.combatStatus.def(CurseOfTheUndercurrent)).toNotExist();
  await c.me.end();
  await c.opp.end();
  c.expect($.my.combatStatus.def(CurseOfTheUndercurrent)).toHaveVariable({
    usage: 2,
  });
  c.expect($.opp.combatStatus.def(CurseOfTheUndercurrent)).toHaveVariable({
    usage: 2,
  });
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

test("shiftingCost: 手牌费用被固定值覆写", async () => {
  const target = ref();
  const c = setup(
    <State config={{ roomRules: ["shiftingCost"] }}>
      <Character my active def={Venti} v={{ health: 5 }} ref={target} />
      <Character opp active />
      <Card my def={MondstadtHashBrown} v={{ ruleCost: 0 }} />
    </State>,
  );
  // 原费用为 1，覆写为 0 后无需任何骰子即可打出
  await c.me.card(MondstadtHashBrown, target);
  c.expect($.my.active).toHaveVariable({ health: 7 });
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
  const costs = c.state.players[0].hands.map(
    (card) => card.variables.ruleCost,
  );
  // 4 张 1 费牌，重分配后总和仍为 4
  expect(costs.reduce((acc, value) => acc + (value ?? 0), 0)).toBe(4);
  // 至少一张增费（2）、至少一张减费（0）
  expect(costs.some((value) => value === 2)).toBe(true);
  expect(costs.some((value) => value === 0)).toBe(true);
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

test("restraint: 每回合最多打出 3 张手牌", async () => {
  const c = setup(
    <State config={{ roomRules: ["restraint"] }}>
      <Character my active def={Venti} />
      <Character my def={Venti} />
      <Character opp active />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
      <Card my def={ChangingShifts} />
    </State>,
  );
  await c.me.card(ChangingShifts);
  await c.me.card(ChangingShifts);
  await c.me.card(ChangingShifts);
  await expect(c.me.card(ChangingShifts)).rejects.toThrow();
});

test("chaos: 回合开始抽取一个未出现过的增益规则", async () => {
  const c = setup(
    <State config={{ roomRules: ["chaos"] }}>
      <Character my active def={Venti} />
      <Character opp active />
    </State>,
  );
  await c.me.end();
  await c.opp.end();
  const ext = c.state.extensions.find((e) => e.definition.type === "extension" && e.definition.skills.length === 0 && e.definition.description === "Room special rules runtime state");
  expect(ext).toBeDefined();
  const runtime = ext!.state as { chaosActive: string | null };
  expect(runtime.chaosActive).not.toBeNull();
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
