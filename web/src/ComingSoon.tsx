const TEXT: Record<string, { title: string; text: string }> = {
  market: {
    title: 'Public market',
    text: 'Members will list materials and crafted items here, and anyone in the org can browse and buy.',
  },
  contracts: {
    title: 'Contracts',
    text: 'A board where members pick up contracts to farm materials for the org.',
  },
  crafted: {
    title: 'Crafted items',
    text: 'Look through the items members have crafted, with the quality of the materials used.',
  },
};

/** Placeholder for the pages that are planned but not built yet. */
export default function ComingSoon({ page }: { page: string }) {
  const t = TEXT[page] ?? { title: page, text: '' };
  return (
    <section className="coming-soon">
      <h2>{t.title}</h2>
      <p>{t.text}</p>
      <p className="muted">Coming soon.</p>
    </section>
  );
}
