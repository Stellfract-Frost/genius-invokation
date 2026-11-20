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
  onMount,
} from "solid-js";
import { VERSIONS } from "@gi-tcg/core";
import {
  fetchProfile,
  type ProfileDetail,
  type ProfileSummary,
} from "../profiles";
import { Layout } from "../layouts/Layout";
import axios, { AxiosError } from "axios";
import type { Deck } from "@gi-tcg/typings";
import { DEFAULT_ASSETS_MANAGER } from "@gi-tcg/assets-manager";
import { useParams, useSearchParams } from "@solidjs/router";
import { DeckBuilder } from "@gi-tcg/deck-builder";
import "@gi-tcg/deck-builder/style.css";
import { useGuestDecks } from "../guest";
import { DeckInfo } from "./Decks";
import { useAuth } from "../auth";
import { unwrap } from "solid-js/store";
import { copyShareCode, getErrorMessage } from "../utils";
import { useI18n } from "../i18n";
import { TextFieldEdit } from "../components/TextFieldEdit";
import { AutoResizeText } from "@gi-tcg/web-ui-core";

export default function EditDeck() {
  const { t, locale, assetsManager } = useI18n();
  const params = useParams();
  const { status } = useAuth();
  const [guestDecks, { addGuestDeck, updateGuestDeck }] = useGuestDecks();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNew = params.id === "new";
  const deckId = Number(params.id);
  const [deckName, setDeckName] = createSignal<string>(
    searchParams.name ?? t("newDeck"),
  );
  // 版本预览：可多选，按合并后的卡池渲染
  const [previewVersions, setPreviewVersions] = createSignal<string[]>([]);
  const [previewProfile, setPreviewProfile] = createSignal<ProfileSummary | null>(null);
  const [previewSingle, setPreviewSingle] = createSignal<string | null>(null);
  const [previewDetail, setPreviewDetail] = createSignal<ProfileDetail | null>(null);
  const [previewState, setPreviewState] = createSignal<"idle" | "loading" | "ready" | "error">("idle");
  // 版本随牌组记忆：同一牌组再次打开时回填
  const versionKey = () => `deck-versions:${params.id ?? "new"}`;
  let versionsLoaded = false;
  const pruneByVersion = (base: string) => {
    const mgr = assetsManager(base);
    const idx = (x: string) => VERSIONS.indexOf(x as never);
    const ok = (id: number) => {
      try {
        const d: any = mgr.getDataSync(id);
        const since: string | undefined = d?.sinceVersion;
        return !since || idx(since) <= idx(base);
      } catch {
        return true;
      }
    };
    const cur = deckValue();
    const characters = cur.characters.filter(ok);
    const cards = cur.cards.filter(ok);
    if (
      characters.length !== cur.characters.length ||
      cards.length !== cur.cards.length
    ) {
      setDeckValue({ characters, cards });
      setDirty(true);
    }
  };

  // 新牌组保存后，把版本从 "new" 迁移到真实牌组 id，否则再打开就丢了
  const migrateVersionStorage = (toId?: number) => {
    if (!toId) return;
    try {
      const raw = localStorage.getItem("deck-versions:new");
      if (raw) {
        localStorage.setItem(`deck-versions:${toId}`, raw);
        localStorage.removeItem("deck-versions:new");
      }
    } catch {
      /* ignore */
    }
  };

  const togglePreviewVersion = (v: string) => {
    const cur = previewVersions();
    setPreviewVersions(cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  };
  const [uploading, setUploading] = createSignal(false);
  const [uploadDone, setUploadDone] = createSignal(false);
  const [deckValue, setDeckValue] = createSignal<Deck>({
    characters: [],
    cards: [],
  });
  const [userDeckData] = createResource(() =>
    isNew ? void 0 : axios.get(`decks/${deckId}`).then((r) => r.data),
  );

  onMount(() => {
    try {
      const raw = localStorage.getItem(versionKey());
      if (raw) setPreviewVersions(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    versionsLoaded = true;
  });

  createEffect(() => {
    const vs = previewVersions();
    if (!versionsLoaded) return;
    if (vs.length === 0) {
      setPreviewProfile(null);
      setPreviewSingle(null);
      setPreviewDetail(null);
      setPreviewState("idle");
      return;
    }
    // 单选 = 普通（直接用该版本的数据）；多选 = 比赛版本（合并卡池）
    if (vs.length === 1) {
      setPreviewProfile(null);
      setPreviewDetail(null);
      setPreviewSingle(vs[0]);
      setPreviewState("ready");
      pruneByVersion(vs[0]);
      return;
    }
    setPreviewSingle(null);
    setPreviewState("loading");
    const timer = setTimeout(async () => {
      try {
        const { data } = await axios.post<ProfileSummary>("profiles/merge", { versions: vs });
        setPreviewProfile(data);
        setPreviewDetail(await fetchProfile(data));
        setPreviewState("ready");
        pruneByVersion(data.baseVersion);
      } catch {
        setPreviewState("error");
      }
    }, 400);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const vs = previewVersions();
    if (!versionsLoaded) return;
    try {
      localStorage.setItem(versionKey(), JSON.stringify(vs));
    } catch {
      /* ignore */
    }
  });

  createEffect(() => {
    if (isNew) {
      return;
    }
    let deckInfo: DeckInfo = userDeckData.error ? void 0 : userDeckData();
    const { type } = status();
    if (type === "guest") {
      const found = guestDecks().find((d) => d.id === deckId);
      if (!found) {
        throw new Error(t("deckNotFound"));
      }
      deckInfo = found;
    }
    if (deckInfo) {
      setDeckValue(unwrap(deckInfo));
      setDeckName(deckInfo.name);
      const savedVersions = (deckInfo as any).versions as string[] | null | undefined;
      if (Array.isArray(savedVersions) && savedVersions.length > 0) {
        setPreviewVersions(savedVersions);
      }
      const saved = (deckInfo as any).versions as string[] | null | undefined;
      if (Array.isArray(saved) && saved.length > 0) {
        setPreviewVersions(saved);
      }
      setSearchParams({ name: null }, { replace: true });
    }
  });

  const [dirty, setDirty] = createSignal(false);

  // useBeforeLeave(async (e) => {
  //   if (dirty()) {
  //     e.preventDefault();
  //     if (window.confirm("您有未保存的更改，是否保存？")) {
  //       await saveDeck();
  //     }
  //     e.retry(true);
  //   }
  // });
  const navigateBack = async () => {
    if (dirty()) {
      if (window.confirm(t("unsavedChangesConfirm"))) {
        await saveDeck();
      }
    }
    history.back();
  };

  const valid = () => {
    const deck = deckValue();
    return deck.characters.length === 3 && deck.cards.length === 30;
  };

  const importCode = () => {
    const input = window.prompt(t("inputShareCode"));
    if (input === null) {
      return;
    }
    try {
      const deck = DEFAULT_ASSETS_MANAGER.decode(input);
      setDeckValue(deck);
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
    const deckInfo = {
      ...deckValue(),
      name: deckName(),
      versions: previewVersions(),
    } as any;
    const { type } = status();
    try {
      setUploading(true);
      if (isNew) {
        if (type === "guest") {
          const created = await addGuestDeck(deckInfo);
          migrateVersionStorage((created as any)?.id);
        } else if (type === "user") {
          const res = await axios.post("decks", deckInfo);
          migrateVersionStorage((res.data as any)?.id);
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

  return (
    <Layout>
      <div class="container mx-auto h-full flex flex-col px-2 @container">
        <div class="flex flex-row flex-wrap items-center gap-1 md:gap-3 mb-3 md:mb-5 min-h-0">
          <TextFieldEdit
            value={deckName()}
            saveText={t("save")}
            cancelText={t("cancel")}
            class="text-xl md:text-2xl font-bold "
            onSave={saveName}
          />
          <div class="flex flex-row flex-1 gap-1 md:gap-3 text-3.2 md:text-3.5">
            <button class="btn btn-outline-blue" onClick={importCode}>
              {t("importShareCode")}
            </button>
            <button class="btn btn-outline" onClick={exportCode}>
              {t("generateShareCode")}
            </button>
            <button
              class="flex-shrink-0 btn btn-solid-green min-w-15 md:min-w-22 max-w-20% py-0 px-1"
              disabled={!valid() || uploading()}
              onClick={async () => {
                if (await saveDeck()) {
                  if (isNew) {
                    navigateBack();
                  }
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
                  <AutoResizeText minFontSize={10}>
                    {t("saveDeck")}
                  </AutoResizeText>
                </Match>
              </Switch>
            </button>
            <span class="flex-grow" />
            <button
              class="flex-shrink-0 btn btn-outline-red min-w-15 max-w-20% py-0 px-1"
              onClick={() => navigateBack()}
            >
              <AutoResizeText minFontSize={10}>{t("back")}</AutoResizeText>
            </button>
          </div>
        </div>
        <div class="rounded-lg b-1 b-gray-400/50 p-3 mb-3 md:mb-4">
          <div class="flex flex-row flex-wrap items-center gap-2 mb-2">
            <span class="font-bold text-3.4 md:text-3.6">{t("deckVersion")}</span>
            <span class="text-3 opacity-60">{t("deckVersionHint")}</span>
            <span class="flex-grow" />
            <Show when={previewVersions().length > 0}>
              <button
                type="button"
                class="text-3 underline opacity-70"
                onClick={() => setPreviewVersions([])}
              >
                {t("deckVersionClear")}
              </button>
            </Show>
          </div>
          <div class="flex flex-row flex-wrap gap-1.5">
            <For each={VERSIONS}>
              {(v) => (
                <button
                  type="button"
                  class="text-3 px-2 py-1 rounded b-1"
                  classList={{
                    "b-amber-500 bg-amber-500/20": previewVersions().includes(v),
                    "b-gray-400/40": !previewVersions().includes(v),
                  }}
                  onClick={() => togglePreviewVersion(v)}
                >
                  {v}
                </button>
              )}
            </For>
          </div>
          <Show when={previewVersions().length > 0}>
            <div class="text-3 mt-2">
              本牌组版本：<span class="font-bold">{previewVersions().join(" / ")}</span>
            </div>
          </Show>
          <div class="text-3 mt-2 opacity-70">
            <Switch>
              <Match when={previewState() === "loading"}>{t("loading")}</Match>
              <Match when={previewState() === "error"}>{t("loadFailed", { message: "" })}</Match>
              <Match when={previewState() === "ready"}>
                {previewProfile()
                  ? `${previewProfile()!.name} · base ${previewProfile()!.baseVersion}`
                  : `普通 · ${previewSingle() ?? ""}`}
              </Match>
              <Match when={true}>{t("deckVersionNone")}</Match>
            </Switch>
          </div>
        </div>
        <Switch>
          <Match when={userDeckData.loading}>{t("loading")}</Match>
          <Match when={status().type !== "guest" && userDeckData.error}>
            {t("loadFailed", {
              message: getErrorMessage(userDeckData.error),
            })}
          </Match>
          <Match when={status().type !== "notLogin"}>
            <DeckBuilder
              class={`h-[calc(100dvh-9rem)] @3xl:h-auto w-full flex-grow min-h-0`}
              assetsManager={assetsManager(previewDetail() ?? previewSingle() ?? undefined)}
              locale={locale()}
              deck={deckValue()}
              onChangeDeck={(v) => (setDeckValue(v), setDirty(true))}
            />
          </Match>
        </Switch>
      </div>
    </Layout>
  );
}
