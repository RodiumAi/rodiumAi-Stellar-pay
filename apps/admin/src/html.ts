/**
 * Server-rendered HTML with escaping by default: every value interpolated into `html`…``
 * is escaped unless it is itself an `Html` fragment (built by `html` or `raw`). Values from
 * the database (order ids, memos, webhook errors) can never inject markup.
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES.get(c) ?? c);
}

export type Interpolation = Html | string | number | bigint | boolean | null | undefined;

function render(value: Interpolation | readonly Interpolation[]): string {
  if (Array.isArray(value)) return (value as readonly Interpolation[]).map(render).join('');
  if (value instanceof Html) return value.value;
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export function html(
  strings: TemplateStringsArray,
  ...values: readonly (Interpolation | readonly Interpolation[])[]
): Html {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

/** Trusted markup only (constants in this codebase), never data. */
export function raw(value: string): Html {
  return new Html(value);
}
