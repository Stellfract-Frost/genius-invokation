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
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { For, Show, createEffect } from "solid-js";
import type { AllCardsProps } from "./AllCards";
import { DeckCard, TinyActionCard, TinyCharacterCard } from "./Card";
import { useDeckBuilderContext } from "./DeckBuilder";
import { createStore, produce } from "solid-js/store";
import type {
  DeckDataActionCardInfo,
  DeckDataCharacterInfo,
} from "@gi-tcg/assets-manager";

export function CurrentDeck(props: AllCardsProps & { onExpand: () => void }) {
  const { t } = useDeckBuilderContext();
  const [current, setCurrent] = createStore({
    characters: Array.from(
      { length: 3 },
      () => null
    ) as (DeckDataCharacterInfo | null)[],
    cards: Array.from(
      { length: props.actionCardLimit },
      () => null
    ) as (DeckDataActionCardInfo | null)[],
  });

  createEffect(() => {
    const selectedChs = props.deck.characters
      .map((id) => props.characters.get(id))
      .filter((ch): ch is DeckDataCharacterInfo => typeof ch !== "undefined");
    const selectedAcs = props.deck.cards
      .map((id) => props.actionCards.get(id))
      .filter((ac): ac is DeckDataActionCardInfo => typeof ac !== "undefined")
      .toSorted((a, b) => a.id - b.id);
    setCurrent(
      produce((prev) => {
        for (let i = 0; i < 3; i++) {
          prev.characters[i] = selectedChs[i] ?? null;
        }
        prev.cards.length = Math.max(props.actionCardLimit, selectedAcs.length);
        for (let i = 0; i < prev.cards.length; i++) {
          prev.cards[i] = selectedAcs[i] ?? null;
        }
      })
    );
  });

  const removeCharacter = (idx: number) => {
    setCurrent(produce((prev) => (prev.characters[idx] = null)));
    props.onChangeDeck?.({
      ...props.deck,
      characters: current.characters
        .filter((ch): ch is DeckDataCharacterInfo => ch !== null)
        .map((ch) => ch.id),
    });
  };
  const removeActionCard = (idx: number) => {
    setCurrent(produce((prev) => (prev.cards[idx] = null)));
    props.onChangeDeck?.({
      ...props.deck,
      cards: current.cards
        .filter((ac): ac is DeckDataActionCardInfo => ac !== null)
        .map((ac) => ac.id),
    });
  };

  return (
    <div
      role="region"
      aria-label={t("currentDeck")}
      class="deck-selection"
    >
      <div class="deck-selection-header">
        <ul aria-label={t("characters")} class="deck-selection-characters">
          <For each={current.characters}>
            {(ch, idx) => (
              <li
                class="min-w-0"
                onClick={() => ch && removeCharacter(idx())}
              >
                <Show
                  when={ch}
                  fallback={
                    <div
                      aria-hidden="true"
                      class="deck-selection-placeholder aspect-square rounded-full DP:aspect-[7/12] DP:rounded-xl @3xl:aspect-[7/12] @3xl:rounded-xl"
                    />
                  }
                >
                  {(ch) => (
                    <>
                      <DeckCard
                        class="rounded-xl hidden @3xl:block DP:block"
                        id={ch().id}
                        type="character"
                        warn={ch().version > props.version}
                      />
                      <TinyCharacterCard
                        id={ch().id}
                        warn={ch().version > props.version}
                      />
                    </>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
        <button
          type="button"
          class="@3xl:hidden DP:hidden shrink-0 rounded-lg b-1 px-2 h-7 text-sm"
          onClick={props.onExpand}
        >
          {t("currentDeck")}
        </button>
      </div>
      <ul aria-label={t("actionCards")} class="deck-selection-actions">
        <For each={current.cards}>
          {(ac, idx) => (
            <li
              bool:data-preview={ac !== null || idx() < 6}
              class="aspect-[7/12] min-w-0"
              onClick={() => ac && removeActionCard(idx())}
            >
              <Show
                when={ac}
                fallback={
                  <div
                    aria-hidden="true"
                    class="deck-selection-placeholder aspect-[7/12] rounded-md @3xl:rounded-lg DP:rounded-lg"
                  />
                }
              >
                {(ac) => (
                  <>
                    <DeckCard
                      class="rounded-lg hidden @3xl:block DP:block"
                      id={ac().id}
                      type="actionCard"
                      warn={ac().version > props.version}
                    />
                    <TinyActionCard
                      id={ac().id}
                      warn={ac().version > props.version}
                    />
                  </>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
