import { Card, Character, DiceCount, State, Status, Support, $, setup } from "#test";
import { PuffPopsInEffect } from "@gi-tcg/data/internal/cards/event/food.gts";
import { FlowerfeatherClan } from "@gi-tcg/data/internal/cards/support/place.gts";
import {
  AzureDevourInEffect,
  AzureDevourStatus,
  FavoniusBladeworkDancingRadiance,
  FourWindsAscensionInEffect,
  FourWindsAscensionStatus,
  StatusAzureDevourPreparing,
  SturmUndDrang,
  Varka,
  WindboundExecution,
} from "@gi-tcg/data/internal/characters/anemo/varka.gts";
import { expect, test } from "vitest";

test("Circulation keeps Varka's generated Windbound Execution and does not recycle it after tuning", async () => {
  const c = setup(
    <State config={{ roomRules: ["circulation"] }}>
      <Character my active def={Varka}>
        <Status def={SturmUndDrang} />
      </Character>
      <Character opp active />
      <DiceCount my count={6} />
    </State>,
  );
  await c.me.skill(FavoniusBladeworkDancingRadiance);
  await c.opp.end();
  await c.me.skill(FavoniusBladeworkDancingRadiance);
  expect(c.state.players[0].hands[0]?.generated).toBe(true);
  await c.me.end();
  c.expect($.my.hand.def(WindboundExecution)).toBeExist();
  await c.opp.end();
  await c.me.tune(WindboundExecution);
  c.expect($.my.hand.def(WindboundExecution)).toNotExist();
  expect(c.state.players[0].discard).toHaveLength(0);
  expect(c.state.players[0].pile).toHaveLength(0);
});

test.each([
  [FourWindsAscensionStatus, FourWindsAscensionInEffect],
  [AzureDevourStatus, AzureDevourInEffect],
])("Windbound Execution selection enters hand and takes effect", async (card, status) => {
  const c = setup(
    <State>
      <Character my active def={Varka} health={8}>
        <Status def={PuffPopsInEffect} />
      </Character>
      <Support my def={FlowerfeatherClan} />
      <Card my def={WindboundExecution} />
    </State>,
  );
  await c.me.card(WindboundExecution);
  await c.me.selectCard(card);
  c.expect($.my.active).toHaveVariable({ health: 9 });
  c.expect($.my.typeStatus.def(status)).toBeExist();
  c.expect($.my.hand).toBeCount(0);
  c.expect($.my.typeSupport.def(FlowerfeatherClan)).toHaveVariable({ disposedCardCount: 0 });
});

test("Azure Devour prepares two consecutive skills", async () => {
  const c = setup(
    <State>
      <Character my active def={Varka}>
        <Status def={StatusAzureDevourPreparing} />
      </Character>
      <Character opp active health={10} />
    </State>,
  );
  await c.stepToNextAction();
  c.expect($.opp.active).toHaveVariable({ health: 8 });
  c.expect($.my.typeStatus.def(StatusAzureDevourPreparing)).toHaveVariable({ usage: 1 });
  await c.opp.end();
  c.expect($.opp.active).toHaveVariable({ health: 6 });
  c.expect($.my.typeStatus.def(StatusAzureDevourPreparing)).toNotExist();
});
