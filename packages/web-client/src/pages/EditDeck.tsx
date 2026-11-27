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

import {
  createSignal,
  createResource,
  Switch,
  Match,
  Show,
  For,
  createEffect,
  onCleanup,
  type Accessor,
} from "solid-js";
import { VERSIONS } from "@gi-tcg/core";
import {
  fetchProfile,
  type ProfileDetail,
  type ProfileSummary,
} from "../profiles";
import { Layout } from "../layouts/Layout";
import axios, { AxiosError } from "axios";
import {
  CIRCULATION_DECK_CARD_COUNT,
  STANDARD_DECK_CARD_COUNT,
  type Deck,
  type DeckCardCount,
} from "@gi-tcg/typings";
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";
import { useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { DeckBuilder } from "@gi-tcg/deck-builder";
import "@gi-tcg/deck-builder/style.css";
import { AutoResizeText } from "@gi-tcg/web-ui-core";
import { useGuestDecks } from "../guest";
import { DeckInfo } from "./Decks";
import { useAuth } from "../auth";
import { unwrap } from "solid-js/store";
import { copyShareCode, getErrorMessage } from "../utils";
import { useI18n } from "../i18n";
import { TextFieldEdit } from "../components/TextFieldEdit";
import { getDeckVersions } from "../deckVersions";

function VersionOptions(props: {
  versions: Accessor<readonly string[]>;
  onChange: (versions: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <button type="button" class="text-sm underline p-1" onClick={() => props.onChange([])}>
        {t("deckVersionDefault")}
      </button>
      <div class="grid grid-cols-4 gap-1">
        <For each={VERSIONS.toReversed()}>
          {(version) => (
            <button
              type="button"
              class="min-h-9 rounded-md border border-slate-200 px-1 text-sm tabular-nums aria-pressed:border-blue-500 aria-pressed:bg-blue-100 aria-pressed:font-semibold"
              aria-pressed={props.versions().includes(version)}
              onClick={() => props.onChange(props.versions().includes(version)
                ? props.versions().filter((selected) => selected !== version)
                : [...props.versions(), version])}
            >
              {version}
            </button>
          )}
        </For>
      </div>
    </>
  );
}

export default function EditDeck() {
  const { t, locale, assetsManager } = useI18n();
  const params = useParams();
  const { status } = useAuth();
  const [guestDecks, { addGuestDeck, updateGuestDeck }] = useGuestDecks();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = params.id === "new";
  const deckId = Number(params.id);
  const [deckName, setDeckName] = createSignal<string>(
    searchParams.name ?? t("newDeck"),
  );
  const [previewVersions, setPreviewVersions] = createSignal<string[]>([]);
  const [draftVersions, setDraftVersions] = createSignal<string[]>([]);
  const [previewSingle, setPreviewSingle] = createSignal<string | null>(null);
  const [previewDetail, setPreviewDetail] = createSignal<ProfileDetail | null>(null);
  const [previewState, setPreviewState] = createSignal<"idle" | "loading" | "ready" | "error">("idle");
  let versionDialog!: HTMLDialogElement;
  let leaveDialog!: HTMLDialogElement;
  const [uploading, setUploading] = createSignal(false);
  const [uploadDone, setUploadDone] = createSignal(false);
  const [deckValue, setDeckValue] = createSignal<Deck>({
    characters: [],
    cards: [],
  });
  const [deckSize, setDeckSize] = createSignal<DeckCardCount>(STANDARD_DECK_CARD_COUNT);
  const setDeck = (deck: Deck) => {
    setDeckValue(deck);
    setDeckSize(deck.cards.length === CIRCULATION_DECK_CARD_COUNT
      ? CIRCULATION_DECK_CARD_COUNT : STANDARD_DECK_CARD_COUNT);
  };
  const [userDeckData] = createResource(
    () => !isNew && status().type === "user",
    () => axios.get<DeckInfo>(`decks/${deckId}`).then((r) => r.data),
  );
  let deckLoaded = false;

  createEffect(() => {
    const vs = previewVersions();
    if (vs.length === 0) {
      setPreviewSingle(null);
      setPreviewDetail(null);
      setPreviewState("idle");
      return;
    }
    // 单选 = 普通（直接用该版本的数据）；多选 = 比赛版本（合并卡池）
    if (vs.length === 1) {
      setPreviewDetail(null);
      setPreviewSingle(vs[0]);
      setPreviewState("ready");
      return;
    }
    setPreviewSingle(null);
    setPreviewState("loading");
    const request = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { data } = await axios.post<ProfileSummary>(
          "profiles/merge",
          { versions: vs },
          { signal: request.signal },
        );
        const detail = await fetchProfile(data);
        if (request.signal.aborted) {
          return;
        }
        setPreviewDetail(detail);
        setPreviewState("ready");
      } catch {
        if (!request.signal.aborted) {
          setPreviewState("error");
        }
      }
    }, 400);
    onCleanup(() => {
      clearTimeout(timer);
      request.abort();
    });
  });

  createEffect(() => {
    if (isNew || deckLoaded) {
      return;
    }
    let deckInfo = userDeckData.error ? void 0 : userDeckData();
    const { type } = status();
    if (type === "guest") {
      const found = guestDecks().find((d) => d.id === deckId);
      if (!found) {
        throw new Error(t("deckNotFound"));
      }
      deckInfo = found;
    }
    if (deckInfo) {
      deckLoaded = true;
      setDeck(unwrap(deckInfo));
      setDeckName(deckInfo.name);
      let versions = deckInfo.versions;
      if (versions == null) {
        try {
          const legacy = JSON.parse(localStorage.getItem(`deck-versions:${deckId}`) ?? "null");
          if (Array.isArray(legacy)) {
            versions = legacy;
          }
        } catch {
          // A legacy local preference is optional.
        }
      }
      setPreviewVersions(getDeckVersions(versions));
    }
  });

  const [dirty, setDirty] = createSignal(false);
  const changeVersions = (versions: string[]) => {
    const selected = getDeckVersions(versions);
    if (selected.join() !== previewVersions().join()) {
      setDirty(true);
      setPreviewVersions(selected);
    }
  };
  const leave = () => navigate("/decks", { replace: true });
  const navigateBack = () => {
    if (dirty() && (!isNew || deckValue().characters.length + deckValue().cards.length > 0)) {
      leaveDialog.showModal();
    } else {
      leave();
    }
  };

  const valid = () => {
    const deck = deckValue();
    return deck.characters.length === 3 && deck.cards.length === deckSize();
  };
  const canSave = () => valid() && previewState() !== "loading" && previewState() !== "error" && !uploading();

  const importCode = () => {
    const input = window.prompt(t("inputShareCode"));
    if (input === null) {
      return;
    }
    try {
      const deck = DEFAULT_ASSETS_MANAGER.decode(input);
      setDeck(deck);
      setDirty(true);
    } catch (e) {
      if (e instanceof Error) {
        window.alert(e.message);
      }
      console.error(e);
    }
  };

  const exportCode = async () => {
    try {
      const deck = deckValue();
      const code = DEFAULT_ASSETS_MANAGER.encode(deck);
      await copyShareCode(code, t);
    } catch (e) {
      if (e instanceof Error) {
        window.alert(e.message);
      }
      console.error(e);
    }
  };

  const saveName = async (newName: string) => {
    const oldName = deckName();
    const { type } = status();
    if (!isNew) {
      try {
        if (type === "guest") {
          await updateGuestDeck(deckId, { name: newName });
        } else if (type === "user") {
          await axios.patch(`decks/${deckId}`, { name: newName });
        }
        setDeckName(newName);
        return true;
      } catch (e) {
        if (e instanceof AxiosError) {
          alert(getErrorMessage(e));
          setDeckName(oldName);
        }
        console.error(e);
      }
      return false;
    } else {
      setDeckName(newName);
      return true;
    }
  };

  const saveDeck = async () => {
    if (!canSave()) {
      return false;
    }
    const deckInfo = {
      ...deckValue(),
      name: deckName(),
      versions: previewVersions(),
    };
    const { type } = status();
    try {
      setUploading(true);
      if (isNew) {
        if (type === "guest") {
          await addGuestDeck(deckInfo);
        } else if (type === "user") {
          await axios.post("decks", deckInfo);
        }
        setDirty(false);
      } else {
        if (type === "guest") {
          await updateGuestDeck(deckId, deckInfo);
        } else if (type === "user") {
          await axios.patch(`decks/${deckId}`, deckInfo);
        }
        setDirty(false);
        setUploadDone(true);
        setTimeout(() => setUploadDone(false), 500);
      }
      return true;
    } catch (e) {
      if (e instanceof AxiosError) {
        alert(getErrorMessage(e));
      }
      console.error(e);
      return false;
    } finally {
      setUploading(false);
    }
  };

  const selectedVersions = () => previewVersions().length
    ? previewVersions().join(" / ")
    : t("deckVersionDefault");

  return (
    <Layout fitViewport>
      <div class="container mx-auto h-full flex flex-col px-2 @container">
        <div class="flex flex-row flex-wrap items-center gap-1 md:gap-3 mb-3 md:mb-5 min-h-0">
          <TextFieldEdit
            value={deckName()}
            saveText={t("save")}
            cancelText={t("cancel")}
            class="text-xl md:text-2xl font-bold"
            onSave={saveName}
          />
          <div class="flex flex-row flex-1 gap-1 md:gap-3 text-3.2 md:text-3.5">
            <button type="button" class="btn btn-outline-blue" onClick={importCode} disabled={uploading()}>
              {t("importShareCode")}
            </button>
            <button type="button" class="btn btn-outline" onClick={exportCode} disabled={!valid() || uploading()}>
              {t("generateShareCode")}
            </button>
            <button
              type="button"
              class="flex-shrink-0 btn btn-solid-green min-w-15 md:min-w-22 max-w-20% py-0 px-1"
              aria-label={t("saveDeck")}
              aria-busy={uploading()}
              disabled={!canSave()}
              onClick={async () => {
                if (await saveDeck() && isNew) {
                  leave();
                }
              }}
            >
              <Switch>
                <Match when={uploading()}>
                  <i class="i-mdi-loading animate-spin" />
                </Match>
                <Match when={uploadDone()}>
                  <i class="i-mdi-check" />
                </Match>
                <Match when={true}>
                  <AutoResizeText minFontSize={10}>{t("saveDeck")}</AutoResizeText>
                </Match>
              </Switch>
            </button>
            <span class="flex-grow" />
            <button
              type="button"
              class="flex-shrink-0 btn btn-outline-red min-w-15 max-w-20% py-0 px-1"
              onClick={navigateBack}
              disabled={uploading()}
            >
              <AutoResizeText minFontSize={10}>{t("back")}</AutoResizeText>
            </button>
          </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2 mb-2 text-sm">
          <select
            aria-label={t("deckMode")}
            class="h-9 rounded-md border border-slate-300 px-2"
            value={deckSize()}
            onChange={(e) => {
              setDeckSize(e.currentTarget.value === String(CIRCULATION_DECK_CARD_COUNT)
                ? CIRCULATION_DECK_CARD_COUNT
                : STANDARD_DECK_CARD_COUNT);
              setDirty(true);
            }}
          >
            <option value={STANDARD_DECK_CARD_COUNT}>
              {t("deckModeStandard", { count: STANDARD_DECK_CARD_COUNT })}
            </option>
            <option value={CIRCULATION_DECK_CARD_COUNT}>
              {t("deckModeCirculation", { count: CIRCULATION_DECK_CARD_COUNT })}
            </option>
          </select>
          <span class="tabular-nums" classList={{ "text-red-700": deckValue().cards.length > deckSize() }}>
            {deckValue().cards.length} / {deckSize()}
          </span>
          <button
            type="button"
            aria-haspopup="dialog"
            class="flex-1 sm:flex-initial min-w-0 sm:max-w-[32rem] truncate text-left h-9 rounded-md border border-slate-300 px-2"
            title={selectedVersions()}
            onClick={() => {
              setDraftVersions([...previewVersions()]);
              versionDialog.showModal();
            }}
          >
            {t("deckVersionShort")} · {selectedVersions()}
          </button>
          <Show when={previewState() === "loading"}>
            <span role="status" class="text-xs text-slate-600">{t("loading")}</span>
          </Show>
        </div>
        <Switch>
          <Match when={userDeckData.loading || previewState() === "loading"}>{t("loading")}</Match>
          <Match when={status().type !== "guest" && userDeckData.error}>
            {t("loadFailed", { message: getErrorMessage(userDeckData.error) })}
          </Match>
          <Match when={previewState() === "error"}>
            {t("deckVersionLoadFailed")}
            <button type="button" class="ml-2 underline" onClick={() => setPreviewVersions([...previewVersions()])}>
              {t("retry")}
            </button>
          </Match>
          <Match when={status().type !== "notLogin"}>
            <DeckBuilder
              class="w-full min-h-0 flex-1"
              assetsManager={assetsManager(previewDetail() ?? previewSingle() ?? undefined)}
              hideVersionSelect
              characterBlacklist={previewDetail()?.deck?.blacklist}
              locale={locale()}
              deck={deckValue()}
              actionCardLimit={deckSize()}
              onChangeDeck={(deck) => {
                setDeckValue(deck);
                setDirty(true);
              }}
            />
          </Match>
        </Switch>
      </div>
      <dialog ref={versionDialog} aria-label={t("deckVersion")} class="deck-editor-dialog m-auto w-[min(94vw,28rem)] rounded-xl bg-white p-4 shadow-xl">
        <h3 class="font-bold text-lg">{t("deckVersion")}</h3>
        <p class="text-sm text-slate-600 mt-1">{t("deckVersionHint")}</p>
        <div class="mt-2 max-h-[50dvh] overflow-y-auto">
          <VersionOptions versions={draftVersions} onChange={setDraftVersions} />
        </div>
        <div class="flex flex-wrap justify-end gap-2 mt-3">
          <button type="button" class="btn btn-ghost" onClick={() => versionDialog.close()}>{t("cancel")}</button>
          <button type="button" class="btn btn-solid-blue" onClick={() => {
            changeVersions(draftVersions());
            versionDialog.close();
          }}>{t("applyDeckVersions")}</button>
        </div>
      </dialog>
      <dialog ref={leaveDialog} aria-label={t("leaveDeckTitle")} class="deck-editor-dialog m-auto w-[min(94vw,29rem)] rounded-xl bg-white p-4 shadow-xl">
        <h3 class="font-bold text-lg">{t("leaveDeckTitle")}</h3>
        <p class="text-sm mt-2">{valid() ? t("leaveDeckUnsaved") : t("leaveDeckIncomplete", { count: deckSize() })}</p>
        <div class="flex flex-wrap justify-end gap-2 mt-4">
          <button type="button" class="btn btn-ghost" autofocus onClick={() => leaveDialog.close()}>{t("continueEditing")}</button>
          <button type="button" class="btn btn-outline-red" disabled={uploading()} onClick={leave}>{t("discardAndBack")}</button>
          <Show when={canSave()}>
            <button type="button" class="btn btn-solid-green" onClick={async () => {
              if (await saveDeck()) {
                leave();
              }
            }}>{t("saveAndBack")}</button>
          </Show>
        </div>
      </dialog>
    </Layout>
  );
}
