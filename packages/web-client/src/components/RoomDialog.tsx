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
  createMemo,
  Show,
  For,
  createEffect,
  onCleanup,
  JSX,
  splitProps,
} from "solid-js";
import { makePersisted } from "@solid-primitives/storage";
import {
  COMPETITION_PROFILE_ID,
  ROOM_RULES,
  getRoomDeckCardCount,
  type RoomRuleId,
} from "@gi-tcg/core";
import { CIRCULATION_DECK_CARD_COUNT, type DeckCardCount } from "@gi-tcg/typings";
import axios, { AxiosError } from "axios";
import { ToggleSwitch } from "./ToggleSwitch";
import { DeckInfoProps } from "./DeckBriefInfo";
import { getErrorMessage, roomIdToCode } from "../utils";
import { useNavigate } from "@solidjs/router";
import { useAuth } from "../auth";
import { useGuestDecks, useGuestInfo } from "../guest";
import type { ProfileList, ProfileSummary } from "../profiles";
import { useI18n } from "../i18n";
import { getDeckVersionKey, getDeckVersions } from "../deckVersions";

function SelectableDeckInfo(
  props: Pick<DeckInfoProps, "characters" | "name" | "versions"> &
    JSX.InputHTMLAttributes<HTMLInputElement>,
) {
  const { assetsManager, t } = useI18n();
  const [deckInfo, inputProps] = splitProps(props, [
    "characters",
    "name",
    "versions",
  ]);
  return (
    <label class="relative group block cursor-pointer min-w-0 w-full">
      <input
        type="radio"
        hidden
        class="peer"
        name="createRoomDeck"
        {...inputProps}
      />
      <div class="pl-8 pr-2">
        <div class="flex flex-row items-center gap-1">
          <For each={deckInfo.characters}>
            {(id) => (
              <img
                class="h-8 w-8 lg:h-12 lg:w-12 object-contain b-2 b-yellow-100 rounded-full"
                src={assetsManager().getImageUrlSync(id, {
                  type: "icon",
                })}
              />
            )}
          </For>
        </div>
      </div>
      <div class="pl-8 pr-2 py-1 break-words text-yellow-800 peer-checked:text-yellow-100 transition-colors">
        {deckInfo.name}
        <div class="text-xs tabular-nums">
          {t("deckVersionShort")} · {getDeckVersionKey(deckInfo.versions) || t("deckVersionDefault")}
        </div>
      </div>
      <div class="absolute top-3 left-0 hidden peer-checked:flex text-5 line-height-5 w-7 h-7 items-center justify-center text-red bg-white b-yellow-800 b-2 rounded-full">
        &#10003;
      </div>
      <div class="absolute top-5 bottom-0 left-4 right-1 bg-white border-yellow-800 b-1 group-hover:bg-yellow-100 group-[_]:peer-checked:bg-yellow-800 rounded-lg z--1 transition-colors" />
    </label>
  );
}

export interface RoomDialogProps {
  ref: HTMLDialogElement;
  settingsOnly?: boolean;
  joiningRoomInfo?: {
    id: number;
    config: TimeConfig & {
      profile: ProfileSummary;
      roomRules?: RoomRuleId[];
      private: boolean;
      watchable: boolean;
    };
  };
}

interface TimeConfig {
  nameKey?:
    | "timeConfigMinimal"
    | "timeConfigStandard"
    | "timeConfigDouble"
    | "timeConfigLong"
    | "timeConfigEndless";
  estimationTime?: number;
  initTotalActionTime: number;
  rerollTime: number;
  roundTotalActionTime: number;
  actionTime: number;
}

const BUFF_RULES = ROOM_RULES.filter((rule) => rule.polarity === "buff");
const DEBUFF_RULES = ROOM_RULES.filter(
  (rule) => rule.polarity === "debuff",
);

const TIME_CONFIGS: TimeConfig[] = [
  {
    nameKey: "timeConfigMinimal",
    estimationTime: 3,
    initTotalActionTime: 20,
    rerollTime: 25,
    roundTotalActionTime: 20,
    actionTime: 25,
  },
  {
    nameKey: "timeConfigStandard",
    estimationTime: 5,
    initTotalActionTime: 45,
    rerollTime: 40,
    roundTotalActionTime: 60,
    actionTime: 25,
  },
  {
    nameKey: "timeConfigDouble",
    estimationTime: 10,
    initTotalActionTime: 20,
    rerollTime: 60,
    roundTotalActionTime: 180,
    actionTime: 45,
  },
  {
    nameKey: "timeConfigLong",
    estimationTime: 20,
    initTotalActionTime: 60,
    rerollTime: 120,
    roundTotalActionTime: 300,
    actionTime: 90,
  },
  {
    nameKey: "timeConfigEndless",
    estimationTime: 60,
    initTotalActionTime: 60,
    rerollTime: 300,
    roundTotalActionTime: 180,
    actionTime: 300,
  },
];

type RoomMode = "standard" | "circulation" | "chaos";

const DEFAULT_ROOM_SETTINGS = {
  version: "",
  time: 1,
  isPublic: true,
  watchable: true,
  allowGuest: true,
  rules: [] as RoomRuleId[],
};

export function RoomDialog(props: RoomDialogProps) {
  const { t } = useI18n();
  const { status } = useAuth();
  const [guestInfo, setGuestInfo] = useGuestInfo();
  const [guestDecks] = useGuestDecks();
  const navigate = useNavigate();
  const editable = () => !props.joiningRoomInfo;
  let dialogEl: HTMLDialogElement;
  const closeDialog = () => {
    dialogEl.close();
  };
  const [defaults, setDefaults] = makePersisted(
    createSignal(DEFAULT_ROOM_SETTINGS),
    { name: "room-defaults" },
  );
  const [profiles] = createResource(() =>
    axios.get<ProfileList>("profiles").then(({ data }) => data),
  );
  const legacyProfile = (() => {
    try {
      const value = JSON.parse(localStorage.getItem("room-profile") ?? "null");
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  })();
  const savedRoomVersion = () => {
    const id = defaults().version || legacyProfile;
    return id.startsWith("deck-versions:") || id.startsWith("practice/")
      ? COMPETITION_PROFILE_ID
      : id;
  };
  const [roomVersion, setRoomVersion] = createSignal(savedRoomVersion());
  const [timeConfig, setTimeConfig] = createSignal(TIME_CONFIGS[defaults().time] ?? TIME_CONFIGS[1]);
  const [isPublic, setIsPublic] = createSignal(defaults().isPublic);
  const [watchable, setWatchable] = createSignal(defaults().watchable);
  const [allowGuest, setAllowGuest] = createSignal(defaults().allowGuest);
  const [selectedRules, setRoomRules] = createSignal(defaults().rules);
  const roomRules = () => props.joiningRoomInfo
    ? (props.joiningRoomInfo.config.roomRules ?? [])
    : selectedRules();
  const deckSize = createMemo(() => getRoomDeckCardCount(roomRules()));
  const roomMode = createMemo<RoomMode>(() => roomRules().includes("chaos")
    ? "chaos" : roomRules().includes("circulation") ? "circulation" : "standard");
  const selectRoomMode = (mode: RoomMode) => {
    const effects = roomRules().filter((rule) => rule !== "chaos" && rule !== "circulation");
    setRoomRules(mode === "chaos" ? ["chaos"] : mode === "circulation" ? ["circulation", ...effects] : effects);
  };
  const profile = createMemo(() => {
    if (props.joiningRoomInfo) {
      return props.joiningRoomInfo.config.profile;
    }
    const list = profiles();
    return list?.profiles.find((profile) => profile.id === roomVersion())
      ?? list?.profiles.find((profile) => profile.id === list.defaultProfileId);
  });
  const profileOptions = createMemo(() => profiles()?.profiles.toReversed() ?? []);
  const selectedVersionOption = () => profile()?.id ?? roomVersion();
  const [availableDecks, setAvailableDecks] = createSignal<DeckInfoProps[]>([]);
  const matchingDecks = createMemo(() => availableDecks().filter((deck) => {
    if (deck.cards.length !== deckSize()) {
      return false;
    }
    if (!editable()) {
      return true;
    }
    const versions = getDeckVersions(deck.versions);
    const selected = profile();
    if (versions.length > 0) {
      return selected?.id === (versions.length > 1 ? COMPETITION_PROFILE_ID : `official/${versions[0]}`);
    }
    return selected?.id === profiles()?.defaultProfileId || selected?.id.startsWith("official/") === false;
  }));
  const [loadingDecks, setLoadingDecks] = createSignal(true);
  const [selectedDeck, setSelectedDeck] = createSignal<number | null>(null);
  const selectedDeckInfo = createMemo(() =>
    matchingDecks().find((deck) => deck.id === selectedDeck()),
  );
  const [entering, setEntering] = createSignal(false);
  const toggleRule = (id: RoomRuleId) => {
    if (!editable()) {
      return;
    }
    const current = roomRules();
    setRoomRules(current.includes(id) ? current.filter((rule) => rule !== id) : [...current, id]);
  };

  const resetRoomSettings = () => {
    if (editable()) {
      const saved = defaults();
      setRoomVersion(savedRoomVersion());
      setTimeConfig(TIME_CONFIGS[saved.time] ?? TIME_CONFIGS[1]);
      setIsPublic(saved.isPublic);
      setWatchable(saved.watchable);
      setAllowGuest(saved.allowGuest);
      setRoomRules(saved.rules);
    }
  };

  const saveRoomSettings = () => {
    setDefaults({
      version: roomVersion() || profile()?.id || "",
      time: TIME_CONFIGS.indexOf(timeConfig()),
      isPublic: isPublic(),
      watchable: watchable(),
      allowGuest: allowGuest(),
      rules: roomRules(),
    });
    closeDialog();
  };

  const updateAvailableDecks = async (
    profileId: string,
    deckSize: DeckCardCount,
    signal: AbortSignal,
  ) => {
    setLoadingDecks(true);
    const { type } = status();
    try {
      let decks: DeckInfoProps[] = [];
      if (type === "user") {
        const { data } = await axios.get("decks", {
          params: { profileId, deckSize },
          signal,
        });
        decks = data.data;
      } else if (type === "guest") {
        const guest = guestDecks();
        const { data } = await axios.post<{ matches: boolean[] }>(
          "decks/filter",
          {
            profileId,
            deckSize,
            decks: guest.map(({ characters, cards, versions }) => ({
              characters,
              cards,
              versions: versions ?? void 0,
            })),
          },
          { signal },
        );
        decks = guest.filter((_, index) => data.matches[index]);
      }
      if (signal.aborted) {
        return;
      }
      setAvailableDecks(decks);
      if (!decks.some((deck) => deck.id === selectedDeck())) {
        setSelectedDeck(null);
      }
    } catch (e) {
      if (signal.aborted) {
        return;
      }
      setAvailableDecks([]);
      setSelectedDeck(null);
      if (e instanceof AxiosError) {
        alert(getErrorMessage(e));
      }
      console.error(e);
    }
    setLoadingDecks(false);
  };

  createEffect(() => {
    const profileId = profile()?.id;
    if (!props.settingsOnly && profileId) {
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      updateAvailableDecks(profileId, deckSize(), controller.signal);
    }
  });

  const enterRoom = async () => {
    const deck = selectedDeckInfo();
    const currentProfile = profile();
    if (!deck || !currentProfile || loadingDecks() || entering()) {
      return;
    }
    setEntering(true);
    const { type, name, id } = status();
    const guestDeck = {
      characters: deck.characters,
      cards: deck.cards,
      versions: deck.versions ?? undefined,
    };
    try {
      let roomId = props.joiningRoomInfo?.id;
      let playerId = id ?? null;
      let response;
      if (typeof roomId === "undefined") {
        const payload: any = {
          profileId: currentProfile.id,
          ...timeConfig(),
          private: !isPublic(),
          watchable: watchable(),
          allowGuest: type === "guest" || allowGuest(),
          roomRules: roomRules(),
        };
        if (type === "guest") {
          payload.name = name;
          payload.deck = guestDeck;
          payload.avatarUrl = guestInfo()?.avatarUrl;
        } else if (type === "user") {
          payload.hostDeckId = deck.id;
        }
        const { data } = await axios.post("rooms", payload);
        response = data;
        roomId = response.room.id as number;
      } else {
        let payload;
        if (type === "guest") {
          payload = {
            deck: guestDeck,
            name,
            avatarUrl: guestInfo()?.avatarUrl,
          };
        } else if (type === "user") {
          payload = {
            deckId: deck.id,
          };
        }
        const { data } = await axios.post(`rooms/${roomId}/players`, payload);
        response = data;
      }
      if (response.accessToken) {
        localStorage.setItem("accessToken", response.accessToken);
      }
      if (response.playerId) {
        playerId = response.playerId;
        setGuestInfo((info) => info && { ...info, id: response.playerId });
      }
      const roomCode = roomIdToCode(roomId);
      navigate(`/rooms/${roomCode}?player=${playerId}&action=1`);
    } catch (e) {
      if (e instanceof Error) {
        alert(getErrorMessage(e));
      }
      console.error(e);
    } finally {
      setEntering(false);
    }
  };

  const modeName = (mode: RoomMode) => t(mode === "standard" ? "standardMode" : `rule_${mode}_name`);

  return (
    <dialog
      ref={(el) => (dialogEl = el) && (props.ref as any)?.(el)}
      onClose={resetRoomSettings}
      aria-label={t(props.settingsOnly ? "roomDefaults" : "roomConfig")}
      class="room-settings-dialog max-h-unset max-w-unset h-100dvh w-100dvw overflow-auto p-3 pt-[calc(0.75rem+var(--root-padding-top))] md:p-5 md:m-auto md:h-auto md:max-h-[90dvh] md:w-[min(56rem,94vw)] md:rounded-xl md:shadow-xl"
    >
      <div class="mx-auto flex flex-col gap-3 max-w-4xl">
        <h3 class="text-xl font-bold">{t(props.settingsOnly ? "roomDefaults" : "roomConfig")}</h3>
        <div class="grid min-w-0 gap-3 mb-18 md:mb-0" classList={{ "md:grid-cols-[minmax(0,1fr)_minmax(16rem,1fr)]": !props.settingsOnly }}>
          <section class="min-w-0 grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg bg-slate-50 p-3">
            <label class="min-w-0 flex flex-col gap-1 text-sm font-semibold">
              {t("roomVersion")}
              <select
                class="w-full min-w-0 border border-slate-300 rounded-md bg-white px-2 h-10 text-sm font-normal"
                value={selectedVersionOption()}
                onChange={(event) => {
                  setSelectedDeck(null);
                  setRoomVersion(event.currentTarget.value);
                }}
                disabled={!editable()}
              >
                <Show when={!editable()} fallback={
                  <>
                    <For each={profileOptions()}>
                      {(option) => (
                        <option value={option.id} selected={option.id === selectedVersionOption()}>
                          {option.id === COMPETITION_PROFILE_ID ? t("competitionVersion") : option.name}
                        </option>
                      )}
                    </For>
                  </>
                }>
                  <option value={profile()?.id}>{profile()?.id === COMPETITION_PROFILE_ID ? t("competitionVersion") : profile()?.name}</option>
                </Show>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-sm font-semibold">
              {t("roomGameMode")}
              <select
                class="border border-slate-300 rounded-md bg-white px-2 h-10 text-sm font-normal"
                value={roomMode()}
                onChange={(event) => selectRoomMode(event.currentTarget.value as RoomMode)}
                disabled={!editable()}
              >
                <For each={["standard", "circulation", "chaos"] as const}>
                  {(mode) => <option value={mode}>{modeName(mode)}</option>}
                </For>
              </select>
            </label>
            <Show when={roomMode() !== "standard"}>
              <p class="col-span-2 text-xs text-slate-600 leading-normal">{t(`rule_${roomMode() as "circulation" | "chaos"}_desc`)}</p>
            </Show>
          </section>
          <Show when={!props.settingsOnly}>
            <section class="min-w-0 md:col-start-2 md:row-start-1 md:row-span-2">
              <h4 class="text-base font-semibold mb-2">{t("chooseDeck")}</h4>
                <Show when={profile() && !loadingDecks()} fallback={<p role="status" class="text-sm text-slate-600">{t("loading")}</p>}>
                <ul class="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2 max-h-65dvh overflow-auto p-1">
                  <For each={matchingDecks()} fallback={
                    <li class="col-span-full text-sm text-slate-600">
                      {t(deckSize() === CIRCULATION_DECK_CARD_COUNT ? "noCirculationDeckForProfile" : "noDeckForProfile")}
                    </li>
                  }>
                    {(deck) => (
                      <li>
                        <SelectableDeckInfo
                          characters={deck.characters}
                          name={deck.name}
                          versions={deck.versions}
                          checked={selectedDeck() === deck.id}
                          onChange={(event) => event.currentTarget.checked && setSelectedDeck(deck.id)}
                        />
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          </Show>
          <div class="min-w-0 flex flex-col gap-2">
            <Show when={roomMode() !== "chaos"}>
              <details class="rounded-lg border border-slate-200 px-3 py-2" open={props.settingsOnly}>
                <summary class="cursor-pointer font-semibold">
                  {t("roomEffects")}
                  <Show when={roomRules().some((rule) => rule !== "circulation")}>
                    <span class="ml-2 text-sm text-slate-600">({roomRules().filter((rule) => rule !== "circulation").length})</span>
                  </Show>
                </summary>
                <For each={[
                  { label: t("specialRulesBuff"), rules: BUFF_RULES },
                  { label: t("specialRulesDebuff"), rules: DEBUFF_RULES },
                ]}>
                  {(group) => (
                    <>
                      <h5 class="mt-3 mb-1 text-sm font-semibold text-slate-700">{group.label}</h5>
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        <For each={group.rules}>
                          {(rule) => (
                            <button
                              type="button"
                              class="rounded-lg border border-slate-200 p-2 text-left aria-pressed:border-blue-500 aria-pressed:bg-blue-50"
                              aria-pressed={roomRules().includes(rule.id)}
                              disabled={!editable()}
                              onClick={() => toggleRule(rule.id)}
                            >
                              <span class="block font-semibold text-sm">{t(`rule_${rule.id}_name`)}</span>
                              <span class="block text-xs text-slate-600">{t(`rule_${rule.id}_desc`)}</span>
                            </button>
                          )}
                        </For>
                      </div>
                    </>
                  )}
                </For>
              </details>
            </Show>
            <details class="rounded-lg border border-slate-200 px-3 py-2" open={props.settingsOnly}>
              <summary class="cursor-pointer font-semibold">{t("roomAdvancedSettings")}</summary>
              <label class="mt-2 flex flex-wrap items-center gap-2 text-sm">
                {t("thinkingTime")}
                <Show when={editable()} fallback={
                  <span>{props.joiningRoomInfo?.config.roundTotalActionTime} + {props.joiningRoomInfo?.config.actionTime}</span>
                }>
                  <select
                    class="h-9 px-2 border border-slate-300 rounded-md"
                    value={TIME_CONFIGS.indexOf(timeConfig())}
                    onChange={(event) => setTimeConfig(TIME_CONFIGS[Number(event.currentTarget.value)])}
                  >
                    <For each={TIME_CONFIGS}>
                      {(config, index) => <option value={index()}>{t(config.nameKey!)}</option>}
                    </For>
                  </select>
                </Show>
              </label>
              <div class="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600">
                <span>{t("initTotalActionTime", { seconds: (props.joiningRoomInfo?.config ?? timeConfig()).initTotalActionTime })}</span>
                <span>{t("rerollTime", { seconds: (props.joiningRoomInfo?.config ?? timeConfig()).rerollTime })}</span>
                <span>{t("roundTotalActionTime", { seconds: (props.joiningRoomInfo?.config ?? timeConfig()).roundTotalActionTime })}</span>
                <span>{t("actionTime", { seconds: (props.joiningRoomInfo?.config ?? timeConfig()).actionTime })}</span>
              </div>
              <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                <div class="flex items-center gap-1.5 text-sm">
                  {t("publicRoom")}
                  <ToggleSwitch
                    aria-label={t("publicRoom")}
                    checked={props.joiningRoomInfo ? !props.joiningRoomInfo.config.private : isPublic()}
                    onChange={(event) => setIsPublic(event.currentTarget.checked)}
                    disabled={!editable()}
                  />
                </div>
                <div class="flex items-center gap-1.5 text-sm">
                  {t("watchable")}
                  <ToggleSwitch
                    aria-label={t("watchable")}
                    checked={props.joiningRoomInfo?.config.watchable ?? watchable()}
                    onChange={(event) => setWatchable(event.currentTarget.checked)}
                    disabled={!editable()}
                  />
                </div>
                <Show when={editable() && !guestInfo()}>
                  <div class="flex items-center gap-1.5 text-sm">
                    {t("allowGuestJoin")}
                    <ToggleSwitch aria-label={t("allowGuestJoin")} checked={allowGuest()} onChange={(event) => setAllowGuest(event.currentTarget.checked)} />
                  </div>
                </Show>
              </div>
              <Show when={guestInfo() || (editable() && allowGuest())}>
                <p class="mt-2 text-xs text-slate-600">
                  {t("guestRecordWarning", {
                    suggestion: editable() && !guestInfo() ? t("disableGuestJoin") : t("useGithubLogin"),
                  })}
                </p>
              </Show>
            </details>
          </div>
        </div>
        <div class="fixed md:static left-0 right-0 bottom-0 bg-white border-t md:border-0 border-slate-200 px-3 pt-2 pb-[calc(0.5rem+var(--root-padding-bottom))] md:p-0 flex justify-end gap-2">
          <button type="button" class="btn btn-ghost-red min-h-10" onClick={closeDialog}>
            {t("cancel")}
          </button>
          <Show when={props.settingsOnly} fallback={
            <button
              type="button"
              class="btn btn-solid-green min-h-10"
              onClick={enterRoom}
              disabled={!selectedDeckInfo() || entering() || loadingDecks() || !profile()}
            >
              {entering() ? t("joiningRoom") : !selectedDeckInfo() ? t("selectDeckFirst")
                : editable() ? t("createRoomPlain") : t("joinRoomPlain")}
            </button>
          }>
            <button type="button" class="btn btn-solid-green min-h-10" onClick={saveRoomSettings}>
              {t("saveRoomDefaults")}
            </button>
          </Show>
        </div>
      </div>
    </dialog>
  );
}
