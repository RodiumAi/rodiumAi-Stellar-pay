/** Served at `<base>/admin.css` (CSP allows styles from 'self' only, no inline styles). */
export const ADMIN_CSS = `
:root{--bg:#fff;--fg:#0a0a0a;--muted:#f5f5f5;--muted-fg:#707070;--card:#fff;--border:#e8e8e8;
--accent:#eb6118;--accent-text:#b8460b;--ok:#16a34a;--warn:#b45309;--bad:#c2410c;--radius:8px;
--font:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--fg:#f5f5f5;--muted:#1f1f1f;--muted-fg:#8a8a8a;
--card:#141414;--border:#292929;--accent-text:#f28a4f;--ok:#4ade80;--warn:#fbbf24;--bad:#fb923c;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--font)}
a{color:inherit}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;padding:12px 16px;border-bottom:1px solid var(--border)}
.brand{font-weight:600;text-decoration:none}.brand span{color:var(--accent-text);font-weight:500}
.net{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--border)}
.net-mainnet{border-color:var(--accent);color:var(--accent-text)}
.top nav{display:flex;gap:4px;flex-wrap:wrap}
.top nav a,.tabs a{padding:4px 10px;border-radius:var(--radius);text-decoration:none;color:var(--muted-fg)}
.top nav a[aria-current],.tabs a[aria-current]{background:var(--muted);color:var(--fg)}
.who{margin-left:auto;color:var(--muted-fg);font-size:13px}
main{max-width:1200px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0 16px}h2{font-size:16px;margin:28px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:12px}
.stat{border:1px solid var(--border);border-radius:var(--radius);padding:12px;background:var(--card)}
.stat span{display:block;color:var(--muted-fg);font-size:12px}.stat strong{font-size:16px;font-weight:600}
.stat.ok strong{color:var(--ok)}.stat.warn strong{color:var(--warn)}.stat.bad strong{color:var(--bad)}
.scroll{overflow-x:auto;border:1px solid var(--border);border-radius:var(--radius)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap;vertical-align:top}
th{color:var(--muted-fg);font-weight:500;background:var(--muted)}tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:var(--mono);font-size:12px}
.err{white-space:normal;max-width:360px;word-break:break-word;color:var(--muted-fg)}
.badge{font-size:12px;padding:1px 8px;border-radius:999px;background:var(--muted)}
.s-confirmed,.s-delivered,.s-matched{color:var(--ok)}
.s-pending,.s-underpaid,.s-unmatched{color:var(--warn)}
.s-expired,.s-ignored{color:var(--muted-fg)}
.s-late_paid,.s-dead,.s-refunded{color:var(--bad)}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 20px;margin:0}
.facts dt{color:var(--muted-fg)}.facts dd{margin:0;word-break:break-all}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.filters input,.filters select,.filters button{font:inherit;padding:6px 10px;border:1px solid var(--border);
border-radius:var(--radius);background:var(--card);color:var(--fg)}
.filters input{flex:1;min-width:220px}.filters button{cursor:pointer}
.tabs{display:flex;gap:4px;margin-bottom:12px}
.muted,.empty{color:var(--muted-fg)}.pager{margin-top:12px}
`;
