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

import {
  type JSX,
  createContext,
  splitProps,
  useContext,
  untrack,
  createSignal,
  createEffect,
  createMemo,
  Show,
  createResource,
  Switch,
  Match,
  createUniqueId,
  onCleanup,
} from "solid-js";
import { AllCards } from "./AllCards";
import { CurrentDeck } from "./CurrentDeck";
import { STANDARD_DECK_CARD_COUNT, type Deck } from "@gi-tcg/typings";
import { createCardDataViewer } from "@gi-tcg/card-data-viewer";
import {
  DEFAULT_ASSETS_MANAGER,
  type AssetsManager,
  type DeckData,
} from "@gi-tcg/assets-manager";
import { translations, type Locale } from "./i18n";
import type { I18nKey } from "./locales";
import { resolveTemplate, translator } from "@solid-primitives/i18n";

export interface DeckBuilderProps extends JSX.HTMLAttributes<HTMLDivElement> {
  assetsManager?: AssetsManager;
  deck?: Deck;
  actionCardLimit?: number;
  version?: string;
  /** 隐藏内置的版本下拉（由外部自带的版本选择器接管） */
  hideVersionSelect?: boolean;
  /** 规则禁止使用的角色（行动牌不受限） */
  characterBlacklist?: readonly number[];
  onChangeDeck?: (deck: Deck) => void;
  locale?: Locale;
}

interface DeckBuilderContextValue {
  assetsManager: () => AssetsManager;
  locale: () => Locale;
  t: (key: I18nKey, params?: Record<string, string | number>) => string;
  showCard: (e: Event, type: "actionCard" | "character", id: number) => void;
}

const DeckBuilderContext = createContext<DeckBuilderContextValue>();

export const useDeckBuilderContext = () => useContext(DeckBuilderContext)!;

const EMPTY_DECK: Deck = {
  characters: [],
  cards: [],
};

export function DeckBuilder(props: DeckBuilderProps) {
  const [local, rest] = splitProps(props, [
    "assetsManager", "locale", "class", "actionCardLimit",
  ]);
  let container!: HTMLDivElement;
  const assetsManager = createMemo(
    () => local.assetsManager ?? DEFAULT_ASSETS_MANAGER,
  );
  const locale = createMemo(() => local.locale ?? "zh-CN");
  const dict = createMemo(() => translations[locale()]);
  const t = translator(dict, resolveTemplate);

  const [deckData] = createResource(assetsManager, (manager) =>
    manager.getDeckData(),
  );

  const { CardDataViewer, showCard, showCharacter, hide } =
    createCardDataViewer({
      assetsManager,
      locale,
    });

  const [cardDataViewerOffsetX, setCardDataViewerOffsetX] = createSignal(0);
  const [cardDataViewerOffsetY, setCardDataViewerOffsetY] = createSignal(0);
  const [showCurrentDeck, setShowCurrentDeck] = createSignal(false);

  const [version, setVersion] = createSignal(0);
  const allVersions = () => deckData()?.allVersions;
  const versionSpecified = () =>
    !!props.version && allVersions()?.includes(props.version);

  createEffect(() => {
    if (deckData.state === "ready") {
      if (versionSpecified()) {
        setVersion(deckData().allVersions.indexOf(props.version!));
      } else {
        setVersion(deckData().allVersions.length - 1);
      }
    }
  });

  const deckPageControlId = createUniqueId();

  return (
    <DeckBuilderContext.Provider
      value={{
        assetsManager,
        locale,
        t,
        showCard: (e, type, id) => {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          // 当点击事件发生在靠近左侧位置时，在鼠标右下角显示；否则在左上角显示
          if (e.type === "long-press") {
            setCardDataViewerOffsetX((containerRect.width - 300) / 2);
            if (containerRect.bottom - rect.bottom < 200) {
              setCardDataViewerOffsetY(0);
            } else {
              setCardDataViewerOffsetY(rect.bottom - containerRect.top - 25);
            }
          } else if (rect.left - containerRect.left < 320) {
            setCardDataViewerOffsetX(
              rect.left + rect.width / 2 - containerRect.left,
            );
            setCardDataViewerOffsetY(
              rect.top + rect.height / 2 - containerRect.top,
            );
          } else {
            setCardDataViewerOffsetX(0);
            setCardDataViewerOffsetY(0);
          }
          if (type === "actionCard") {
            showCard(id);
          } else {
            showCharacter(id);
          }
        },
      }}
    >
      <div
        class={`gi-tcg-deck-builder @container groupxxx reset ${local.class}`}
        ref={container}
      >
        <input
          type="checkbox"
          id={deckPageControlId}
          class="deck-page-control"
          checked={showCurrentDeck()}
          hidden
        />
        <div
          class="w-full h-full flex flex-col @3xl:flex-row items-stretch gap-0 @3xl:gap-3 select-none"
          {...rest}
          onClick={() => hide()}
        >
          <Show when={showCurrentDeck()}>
            <div class="@3xl:hidden flex shrink-0 items-center justify-between mb-2">
              <span class="font-semibold">{t("currentDeck")}</span>
              <button type="button" class="h-8 rounded-lg b-1 px-2 text-sm" onClick={() => setShowCurrentDeck(false)}>
                {t("cardPool")}
              </button>
            </div>
          </Show>
          <Switch>
            <Match when={deckData.loading}>
              <div class="flex-grow">{t("loadingCards")}</div>
            </Match>
            <Match when={deckData.error}>
              <div class="flex-grow">{t("loadCardsFailed")}</div>
            </Match>
            <Match when={deckData()}>
              {(deckData) => (
                <AllCards hideVersionSelect={props.hideVersionSelect}
                  characterBlacklist={props.characterBlacklist}
                  version={version()}
                  versionSpecified={versionSpecified()}
                  deck={props.deck ?? EMPTY_DECK}
                  actionCardLimit={local.actionCardLimit ?? STANDARD_DECK_CARD_COUNT}
                  onChangeDeck={props.onChangeDeck}
                  onSetVersion={setVersion}
                  onShowDeck={() => setShowCurrentDeck(true)}
                  {...deckData()}
                />
              )}
            </Match>
          </Switch>
          <div class="hidden @3xl:block b-r-1 b-gray-300" />
          <Show when={deckData()}>
            {(deckData) => (
              <CurrentDeck
                version={version()}
                deck={props.deck ?? EMPTY_DECK}
                actionCardLimit={local.actionCardLimit ?? STANDARD_DECK_CARD_COUNT}
                onChangeDeck={props.onChangeDeck}
                {...deckData()}
              />
            )}
          </Show>
        </div>
        <div
          class="absolute right-0 bottom-0 pointer-events-none z-50"
          style={{
            left: `${cardDataViewerOffsetX()}px`,
            top: `${cardDataViewerOffsetY()}px`,
          }}
        >
          <CardDataViewer />
        </div>
      </div>
    </DeckBuilderContext.Provider>
  );
}
