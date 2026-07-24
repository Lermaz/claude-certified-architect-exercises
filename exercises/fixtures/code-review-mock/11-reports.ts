export type ReportRow = {
  label: string;
  value: number;
};

export function formatLabels(rows: ReportRow[]): string[] {
  const labels: string[] = [];
  // Identical inefficient forEach as 03-users.ts — attention dilution artefact target
  rows.forEach((r) => {
    labels.push(r.label.toUpperCase());
  });
  return labels;
}

export function average(rows: ReportRow[]): number {
  let sum = 0;
  for (const r of rows) sum += r.value;
  return sum / rows.length; // div by zero when empty
}
