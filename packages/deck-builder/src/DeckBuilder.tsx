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
  createSignal,
  createEffect,
  createMemo,
  Show,
  createResource,
  Switch,
  Match,
} from "solid-js";
import { AllCards } from "./AllCards";
import { CurrentDeck } from "./CurrentDeck";
import { STANDARD_DECK_CARD_COUNT, type Deck } from "@gi-tcg/typings";
import { createCardDataViewer } from "@gi-tcg/card-data-viewer";
import {
  DEFAULT_ASSETS_MANAGER,
  type AssetsManager,
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
  let detailsDialog!: HTMLDialogElement;
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
  const [centerDetails, setCenterDetails] = createSignal(false);
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

  return (
    <DeckBuilderContext.Provider
      value={{
        assetsManager,
        locale,
        t,
        showCard: (e, type, id) => {
          const trigger = e.currentTarget as HTMLElement;
          const modal =
            window.matchMedia("(pointer: coarse)").matches ||
            getComputedStyle(trigger).getPropertyValue("--inline-card-details").trim() !== "1";
          setCenterDetails(modal);
          if (type === "actionCard") {
            showCard(id);
          } else {
            showCharacter(id);
          }
          if (modal) {
            if (!detailsDialog.open) {
              detailsDialog.showModal();
            }
            return;
          }

          const rect = trigger.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          // 在左侧卡牌旁边显示，给右侧卡牌的详情留出足够宽度。
          if (rect.left - containerRect.left < 320) {
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
        },
      }}
    >
      <div
        class={`gi-tcg-deck-builder @container groupxxx reset ${local.class}`}
        ref={container}
      >
        <div
          class="w-full h-full flex flex-col @3xl:flex-row @3xl:[--inline-card-details:1] items-stretch gap-0 @3xl:gap-3 select-none"
          {...rest}
          bool:data-deck-expanded={showCurrentDeck()}
          onClick={() => hide()}
        >
          <Switch>
            <Match when={deckData.loading}>
              <div class="flex-grow">{t("loadingCards")}</div>
            </Match>
            <Match when={deckData.error}>
              <div class="flex-grow">{t("loadCardsFailed")}</div>
            </Match>
            <Match when={deckData()}>
              {(deckData) => (
                <>
                  <Show when={showCurrentDeck()}>
                    <div class="@3xl:hidden flex shrink-0 items-center justify-between mb-2">
                      <span class="font-semibold">{t("currentDeck")}</span>
                      <button type="button" class="h-8 rounded-lg b-1 px-2 text-sm" onClick={() => setShowCurrentDeck(false)}>
                        {t("cardPool")}
                      </button>
                    </div>
                  </Show>
                  <AllCards
                    hideVersionSelect={props.hideVersionSelect}
                    characterBlacklist={props.characterBlacklist}
                    version={version()}
                    versionSpecified={versionSpecified()}
                    deck={props.deck ?? EMPTY_DECK}
                    actionCardLimit={local.actionCardLimit ?? STANDARD_DECK_CARD_COUNT}
                    onChangeDeck={props.onChangeDeck}
                    onSetVersion={setVersion}
                    {...deckData()}
                  />
                  <div class="hidden @3xl:block b-r-1 b-gray-300" />
                  <CurrentDeck
                    version={version()}
                    deck={props.deck ?? EMPTY_DECK}
                    actionCardLimit={local.actionCardLimit ?? STANDARD_DECK_CARD_COUNT}
                    onChangeDeck={props.onChangeDeck}
                    onExpand={() => setShowCurrentDeck(true)}
                    {...deckData()}
                  />
                </>
              )}
            </Match>
          </Switch>
        </div>
        <div
          class="absolute right-0 bottom-0 pointer-events-none z-50"
          style={{
            left: `${cardDataViewerOffsetX()}px`,
            top: `${cardDataViewerOffsetY()}px`,
          }}
        >
          <Show when={!centerDetails()}>
            <CardDataViewer />
          </Show>
        </div>
        <dialog
          ref={detailsDialog}
          class="card-details-dialog"
          aria-label={t("cardDetails")}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              detailsDialog.close();
            }
          }}
          onClose={() => {
            if (!detailsDialog.open) {
              hide();
            }
          }}
        >
          <div class="flex justify-end shrink-0 pb-2">
            <button type="button" autofocus class="h-8 rounded-lg b-1 px-3 text-sm" onClick={() => detailsDialog.close()}>
              {t("close")}
            </button>
          </div>
          <div class="card-details-content">
            <Show when={centerDetails()}>
              <CardDataViewer />
            </Show>
          </div>
        </dialog>
      </div>
    </DeckBuilderContext.Provider>
  );
}
