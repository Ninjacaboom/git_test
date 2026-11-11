import { pageList } from './paging';

type Props = {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
};

/** Row of page numbers with Previous and Next. Hidden when everything fits on one page. */
export default function Pagination({ page, totalPages, onChange }: Props) {
  if (totalPages <= 1) return null;

  return (
    <nav className="pagination" aria-label="Pages">
      <button className="page-btn" onClick={() => onChange(page - 1)} disabled={page <= 1}>
        ‹ Prev
      </button>

      {pageList(page, totalPages).map((p, i) =>
        p === 'gap' ? (
          <span key={`gap-${i}`} className="page-gap" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={p}
            className={p === page ? 'page-btn active' : 'page-btn'}
            onClick={() => onChange(p)}
            aria-current={p === page ? 'page' : undefined}
            aria-label={`Page ${p}`}
          >
            {p}
          </button>
        ),
      )}

      <button className="page-btn" onClick={() => onChange(page + 1)} disabled={page >= totalPages}>
        Next ›
      </button>
    </nav>
  );
}
