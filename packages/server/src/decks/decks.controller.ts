// Copyright (C) 2024-2025 Guyutongxue
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
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { Hono } from "hono";
import { NotFoundException } from "../errors";
import { type } from "arktype";
import { VERSIONS, type Version } from "@gi-tcg/core";
import {
  CIRCULATION_DECK_CARD_COUNT,
  STANDARD_DECK_CARD_COUNT,
} from "@gi-tcg/typings";
import { sValidator } from "@hono/standard-validator";
import { getUserId } from "../auth/user.decorator";
import { decksService, profilesService } from "../services";
import {
  PaginationDto,
  IntParam,
  stringLength,
  deckMatchesProfile,
} from "../utils";
import { AuthGuard } from "../auth/auth.guard";

const VersionSchema = type("string").narrow(
  (version, ctx) =>
    VERSIONS.includes(version as Version) ||
    ctx.reject("a supported game version"),
);

const DeckCardCountSchema = type.unit(CIRCULATION_DECK_CARD_COUNT)
  .or(type.unit(STANDARD_DECK_CARD_COUNT));

export const DeckDto = type({
  characters: "(number.integer > 0)[] == 3",
  cards: type("(number.integer > 0)[]").narrow((cards, ctx) =>
    DeckCardCountSchema.allows(cards.length) ||
    ctx.reject("an array of 24 or 30 cards"),
  ),
  "versions?": VersionSchema.array(),
});
export type DeckDto = typeof DeckDto.infer;

export const CreateDeckDto = DeckDto.merge({ name: stringLength(1, 64) });
export type CreateDeckDto = typeof CreateDeckDto.infer;

export const UpdateDeckDto = CreateDeckDto.partial();
export type UpdateDeckDto = typeof UpdateDeckDto.infer;

export const QueryDeckDto = PaginationDto.merge({
  "profileId?": "string",
  "deckSize?": IntParam.to(DeckCardCountSchema),
});
export type QueryDeckDto = typeof QueryDeckDto.infer;

const DeckParam = type({ deckId: IntParam });
const FilterDecksDto = type({
  profileId: "string",
  "deckSize?": DeckCardCountSchema,
  decks: DeckDto.array(),
});

export const DecksController = new Hono()
  .post("/version", sValidator("json", CreateDeckDto), async (c) =>
    c.json(await decksService.deckToCode(c.req.valid("json")), 201),
  )
  .post("/filter", sValidator("json", FilterDecksDto), async (c) => {
    const { profileId, deckSize, decks } = c.req.valid("json");
    const profile = profilesService.get(profileId);
    return c.json({
      matches: await Promise.all(
        decks.map((deck) => deckMatchesProfile(deck, profile, deckSize)),
      ),
    });
  })
  .use(AuthGuard)
  .post("/", sValidator("json", CreateDeckDto), async (c) => {
    const userId = await getUserId(c);
    const result = await decksService.createDeck(userId!, c.req.valid("json"));
    return c.json({ id: result.id, code: result.code }, 201);
  })
  .get("/", sValidator("query", QueryDeckDto), async (c) => {
    const userId = await getUserId(c);
    return c.json(
      await decksService.getAllDecks(userId!, c.req.valid("query")),
    );
  })
  .get("/:deckId", sValidator("param", DeckParam), async (c) => {
    const userId = await getUserId(c);
    const { deckId } = c.req.valid("param");
    const deck = await decksService.getDeck(userId!, deckId);
    if (deck === null) {
      throw new NotFoundException();
    }
    return c.json(deck);
  })
  .patch(
    "/:deckId",
    sValidator("param", DeckParam),
    sValidator("json", UpdateDeckDto),
    async (c) => {
      const userId = await getUserId(c);
      const { deckId } = c.req.valid("param");
      return c.json(
        await decksService.updateDeck(userId!, deckId, c.req.valid("json")),
      );
    },
  )
  .delete("/:deckId", sValidator("param", DeckParam), async (c) => {
    const userId = await getUserId(c);
    const { deckId } = c.req.valid("param");
    await decksService.deleteDeck(userId!, deckId);
    return c.json({ message: `deck ${deckId} deleted` });
  });
