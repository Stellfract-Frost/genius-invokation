import { createMemo, For } from "solid-js";
import type { DeckInfo } from "../pages/Decks";
import { getDeckVersionKey } from "../deckVersions";
import { useI18n } from "../i18n";

export const ALL_DECK_VERSIONS = "*";

export function DeckVersionFilter(props: {
  decks: readonly DeckInfo[];
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const versions = createMemo(() => [...new Set(
    props.decks.map((deck) => getDeckVersionKey(deck.versions)),
  )].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));

  return (
    <select
      aria-label={t("filterDeckVersions")}
      class="min-w-0 max-w-full h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
    >
      <option value={ALL_DECK_VERSIONS}>{t("allDeckVersions")}</option>
      <For each={versions()}>
        {(version) => (
          <option value={version}>{version || t("deckVersionDefault")}</option>
        )}
      </For>
    </select>
  );
}
