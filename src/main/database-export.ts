import type {
  DatabaseCellValue,
  DatabaseData,
  DatabaseExportFormat,
  DatabaseProperty,
  DatabaseRow,
} from "../shared/ipc";
import { evaluateFormula, type FormulaValue } from "../shared/formula";
import type { Vault } from "./vault";
import { readDatabase } from "./vault";

function asText(value: DatabaseCellValue | FormulaValue): string {
  if (value === null) return "";
  return Array.isArray(value)
    ? value.map((item) => (item === null ? "" : String(item))).join(", ")
    : String(value);
}

function formulaValue(
  data: DatabaseData,
  row: DatabaseRow,
  property: DatabaseProperty,
  visited = new Set<string>(),
): FormulaValue {
  if (property.type !== "formula") return row.values[property.id] ?? null;
  if (visited.has(property.id)) throw new Error("Formula dependency cycle");
  const nextVisited = new Set(visited).add(property.id);
  return evaluateFormula(property.formula ?? "", (name) => {
    const referenced = data.properties.find((candidate) => candidate.name === name);
    if (!referenced) throw new Error(`Unknown property: ${name}`);
    return formulaValue(data, row, referenced, nextVisited);
  });
}

function quoteCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function exportCsv(data: DatabaseData): string {
  const lines = [
    data.properties.map((property) => quoteCsv(property.name)).join(","),
    ...data.rows.map((row) =>
      data.properties
        .map((property) => {
          if (property.type === "formula") {
            try {
              return quoteCsv(asText(formulaValue(data, row, property)));
            } catch (error) {
              const message = error instanceof Error ? error.message : "Invalid formula";
              return quoteCsv(`#ERROR: ${message}`);
            }
          }
          return quoteCsv(asText(row.values[property.id] ?? null));
        })
        .join(","),
    ),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export async function exportDatabase(
  vault: Vault,
  id: string,
  format: DatabaseExportFormat,
): Promise<{ title: string; content: string }> {
  const data = await readDatabase(vault, id);
  if (format === "csv") {
    return { title: data.meta.title, content: exportCsv(data) };
  }
  if (format !== "json") throw new Error("Unsupported database export format");
  return {
    title: data.meta.title,
    content: JSON.stringify(
      {
        format: "driftleaf/database-v1",
        title: data.meta.title,
        properties: data.properties,
        rows: data.rows,
        views: data.views,
        activeViewId: data.activeViewId,
      },
      null,
      2,
    ),
  };
}
