export function formatTokens(n: number) {
  return n >= 1000 ? `${(Math.round(n / 100) / 10).toLocaleString("es")} mil` : String(n);
}

export function formatUsd(n: number) {
  return `US$ ${n.toLocaleString("es", { minimumFractionDigits: n < 0.01 ? 4 : 2, maximumFractionDigits: n < 0.01 ? 4 : 2 })}`;
}
