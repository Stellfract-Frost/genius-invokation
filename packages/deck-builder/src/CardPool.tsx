import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { useDeckBuilderContext } from "./DeckBuilder";

export function CardPool<T extends { id: number }>(props: {
  cards: readonly T[];
  children: (card: Accessor<T>) => JSX.Element;
}) {
  const { t } = useDeckBuilderContext();
  let viewport!: HTMLDivElement;
  const [layout, setLayout] = createSignal({ columns: 4, count: 12 });
  const [page, setPage] = createSignal(0);
  const pages = () => Math.max(1, Math.ceil(props.cards.length / layout().count));
  const current = () => Math.min(page(), pages() - 1);
  const cards = createMemo(() => {
    const size = layout().count;
    return props.cards.slice(current() * size, (current() + 1) * size);
  });

  onMount(() => {
    const observer = new ResizeObserver(([{ contentRect: { width, height } }]) => {
      if (width === 0 || height === 0) {
        return;
      }
      const gap = 8;
      const minCardWidth = width < 340 ? 66 : 74;
      const columns = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
      const cardWidth = (width - (columns - 1) * gap) / columns;
      const rows = Math.max(1, Math.floor((height + gap) / (cardWidth * 12 / 7 + gap)));
      setLayout({ columns, count: columns * rows });
    });
    observer.observe(viewport);
    onCleanup(() => observer.disconnect());
  });

  createEffect(on(() => props.cards, () => setPage(0), { defer: true }));
  createEffect(() => {
    current();
    viewport.scrollTop = 0;
  });

  return (
    <>
      <div ref={viewport} class="flex-1 min-h-0 overflow-auto [scrollbar-width:thin]">
        <Show when={cards().length} fallback={<p class="p-3 text-sm text-gray-600">{t("noMatchingCards")}</p>}>
          <ul
            class="grid items-start gap-2"
            style={{ "grid-template-columns": `repeat(${layout().columns}, minmax(0, 1fr))` }}
          >
            <Key each={cards()} by="id">{props.children}</Key>
          </ul>
        </Show>
      </div>
      <nav aria-label={t("cardPages")} class="flex shrink-0 justify-center items-center gap-3 pt-1.5">
        <button type="button" class="h-9 rounded-lg b-1 px-3 disabled:opacity-35" disabled={current() === 0} onClick={() => setPage(current() - 1)}>
          {t("previousPage")}
        </button>
        <span aria-live="polite" class="min-w-14 text-center text-sm tabular-nums">{current() + 1} / {pages()}</span>
        <button type="button" class="h-9 rounded-lg b-1 px-3 disabled:opacity-35" disabled={current() + 1 >= pages()} onClick={() => setPage(current() + 1)}>
          {t("nextPage")}
        </button>
      </nav>
    </>
  );
}
