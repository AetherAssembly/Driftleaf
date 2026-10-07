import { randomUUID } from "node:crypto";
import type {
  DatabaseCellValue,
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseRow,
} from "../shared/ipc";

export interface ParsedDatabase {
  title: string;
  properties: DatabaseProperty[];
  rows: DatabaseRow[];
}

interface PropertyHint {
  type: DatabasePropertyType;
}

function scalar(value: unknown): DatabaseCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
  }
  return JSON.stringify(value);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        field += char;
      }
    } else if (quoteClosed && char === ",") {
      row.push(field);
      field = "";
      quoteClosed = false;
    } else if (quoteClosed && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      field = "";
      quoteClosed = false;
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
    } else if (quoteClosed && /\s/.test(char)) {
      continue;
    } else if (quoteClosed) {
      throw new Error("CSV contains characters after a quoted field");
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === '"') {
      throw new Error("CSV contains an unexpected quote");
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function inferType(values: unknown[]): DatabasePropertyType {
  const present = values.filter((value) => value !== null && value !== undefined && value !== "");
  if (present.length === 0) return "text";
  if (
    present.every(
      (value) =>
        typeof value === "boolean" ||
        /^(true|false|yes|no|checked|unchecked)$/i.test(String(value)),
    )
  ) {
    return "checkbox";
  }
  if (
    present.every(
      (value) => typeof value === "number" || /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)),
    )
  ) {
    return "number";
  }
  if (
    present.every((value) => {
      const stringValue = String(value);
      return (
        /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(stringValue) &&
        Number.isFinite(Date.parse(stringValue))
      );
    })
  ) {
    return "date";
  }
  if (
    present.every((value) => {
      try {
        const url = new URL(String(value));
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    })
  ) {
    return "url";
  }
  return "text";
}

function parseTypedValue(value: unknown, type: DatabasePropertyType): DatabaseCellValue {
  if (value === null || value === undefined || value === "") return null;
  if (type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  if (type === "checkbox") {
    if (typeof value === "boolean") return value;
    if (/^(true|yes|1|checked)$/i.test(String(value))) return true;
    if (/^(false|no|0|unchecked)$/i.test(String(value))) return false;
  }
  if (type === "multi_select" && typeof value === "string") {
    return value.split(/\s*,\s*/).filter(Boolean);
  }
  return scalar(value);
}

function makeDatabase(
  title: string,
  names: string[],
  sourceRows: Array<Record<string, unknown>>,
  hints: Record<string, PropertyHint> = {},
): ParsedDatabase {
  if (names.length === 0) throw new Error("Data has no columns");
  const propertyNames = names.map((name, index) => name.trim() || `Property ${index + 1}`);
  const uniqueNames = new Set<string>();
  for (const name of propertyNames) {
    if (uniqueNames.has(name)) throw new Error(`Duplicate column name: ${name}`);
    uniqueNames.add(name);
  }
  const hintedTitleIndex = propertyNames.findIndex((name) => hints[name]?.type === "title");
  const matchedTitleIndex = propertyNames.findIndex((name) => /^(name|title)$/i.test(name));
  const titleIndex = hintedTitleIndex >= 0 ? hintedTitleIndex : matchedTitleIndex;
  const resolvedTitleIndex = titleIndex >= 0 ? titleIndex : 0;
  const properties: DatabaseProperty[] = propertyNames.map((name, index) => ({
    id: randomUUID(),
    name,
    type:
      index === resolvedTitleIndex
        ? "title"
        : (hints[name]?.type ?? inferType(sourceRows.map((row) => row[name]))),
    ...(["select", "status", "multi_select"].includes(hints[name]?.type ?? "")
      ? {
          options: [
            ...new Set(
              sourceRows
                .flatMap((row) => {
                  const value = row[name];
                  if (hints[name]?.type === "multi_select" && typeof value === "string") {
                    return value.split(/\s*,\s*/);
                  }
                  return Array.isArray(value) ? value : value == null ? [] : [value];
                })
                .filter((value): value is string => typeof value === "string" && value.length > 0),
            ),
          ],
        }
      : {}),
  }));
  const now = Date.now();
  const rows: DatabaseRow[] = sourceRows.map((source) => {
    const values: Record<string, DatabaseCellValue> = {};
    for (const property of properties) {
      const value = source[property.name];
      values[property.id] =
        property.type === "title"
          ? value == null
            ? ""
            : String(value)
          : parseTypedValue(value, property.type);
    }
    return { id: randomUUID(), values, createdAt: now, updatedAt: now };
  });
  return { title, properties, rows };
}

export function parseCsvDatabase(text: string, title: string): ParsedDatabase {
  const matrix = parseCsv(text.replace(/^\uFEFF/, ""));
  if (matrix.length === 0) throw new Error("CSV is empty");
  const headers = matrix[0].map((header) => header.trim());
  if (headers.some((header) => !header)) throw new Error("CSV has an empty column name");
  const sourceRows = matrix.slice(1).map((line) => {
    if (line.length !== headers.length) {
      throw new Error(`CSV row has ${line.length} columns; expected ${headers.length}`);
    }
    const source: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      source[header] = line[index] ?? "";
    });
    return source;
  });
  const hints: Record<string, PropertyHint> = {};
  for (const header of headers) {
    if (/^(tags|labels|categories)$/i.test(header)) hints[header] = { type: "multi_select" };
    else if (/^(status|priority|category|type)$/i.test(header)) hints[header] = { type: "select" };
    else if (/^(url|website|link)$/i.test(header)) hints[header] = { type: "url" };
    else if (/^(email|e-mail)$/i.test(header)) hints[header] = { type: "email" };
    else if (/^(phone|phone number)$/i.test(header)) hints[header] = { type: "phone" };
  }
  return makeDatabase(title, headers, sourceRows, hints);
}

function notionValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.title)) {
    return object.title
      .map((part) =>
        part && typeof part === "object"
          ? ((part as Record<string, unknown>).plain_text ??
            ((part as Record<string, unknown>).text as Record<string, unknown> | undefined)
              ?.content ??
            "")
          : "",
      )
      .join("");
  }
  if (Array.isArray(object.rich_text)) {
    return object.rich_text
      .map((part) =>
        part && typeof part === "object"
          ? ((part as Record<string, unknown>).plain_text ??
            ((part as Record<string, unknown>).text as Record<string, unknown> | undefined)
              ?.content ??
            "")
          : "",
      )
      .join("");
  }
  for (const key of ["select", "status"]) {
    const choice = object[key];
    if (choice && typeof choice === "object")
      return (choice as Record<string, unknown>).name ?? null;
  }
  if (Array.isArray(object.multi_select)) {
    return object.multi_select.map((choice) =>
      choice && typeof choice === "object"
        ? String((choice as Record<string, unknown>).name ?? "")
        : String(choice),
    );
  }
  if (object.checkbox !== undefined) return object.checkbox;
  if (object.number !== undefined) return object.number;
  if (object.url !== undefined) return object.url;
  if (object.email !== undefined) return object.email;
  if (object.phone_number !== undefined) return object.phone_number;
  if (object.date && typeof object.date === "object")
    return (object.date as Record<string, unknown>).start ?? null;
  if (object.formula && typeof object.formula === "object") {
    return (
      (object.formula as Record<string, unknown>).string ??
      (object.formula as Record<string, unknown>).number ??
      (object.formula as Record<string, unknown>).boolean ??
      null
    );
  }
  if (Array.isArray(object.relation)) {
    return object.relation.map((item) =>
      item && typeof item === "object" ? String((item as Record<string, unknown>).id ?? "") : "",
    );
  }
  if (Array.isArray(object.people))
    return object.people.map((person) =>
      person && typeof person === "object"
        ? String(
            (person as Record<string, unknown>).name ??
              (person as Record<string, unknown>).id ??
              "",
          )
        : "",
    );
  if (Array.isArray(object.files))
    return object.files.map((file) =>
      file && typeof file === "object"
        ? String(
            (file as Record<string, unknown>).name ?? (file as Record<string, unknown>).url ?? "",
          )
        : "",
    );
  if (object.created_time || object.last_edited_time)
    return object.created_time ?? object.last_edited_time;
  return value;
}

function notionPropertyHint(value: unknown): PropertyHint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const type = typeof object.type === "string" ? object.type : "";
  const typeMap: Record<string, DatabasePropertyType> = {
    title: "title",
    rich_text: "text",
    number: "number",
    checkbox: "checkbox",
    date: "date",
    select: "select",
    multi_select: "multi_select",
    status: "status",
    url: "url",
    email: "email",
    phone_number: "phone",
    created_time: "created_time",
    created_by: "created_by",
    last_edited_time: "last_edited_time",
    last_edited_by: "last_edited_by",
  };
  const inferred =
    typeMap[type] ??
    (Array.isArray(object.title) ? "title" : undefined) ??
    (Array.isArray(object.rich_text) ? "text" : undefined) ??
    (object.checkbox !== undefined ? "checkbox" : undefined) ??
    (object.number !== undefined ? "number" : undefined) ??
    (object.date !== undefined ? "date" : undefined) ??
    (object.select !== undefined ? "select" : undefined) ??
    (object.multi_select !== undefined ? "multi_select" : undefined) ??
    (object.status !== undefined ? "status" : undefined) ??
    (object.url !== undefined ? "url" : undefined) ??
    (object.email !== undefined ? "email" : undefined) ??
    (object.phone_number !== undefined ? "phone" : undefined);
  return inferred ? { type: inferred } : undefined;
}

function normalizeJsonRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON database rows must be objects");
  }
  const record = value as Record<string, unknown>;
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : record;
  return Object.fromEntries(
    Object.entries(properties).map(([key, cell]) => [key, notionValue(cell)]),
  );
}

export function parseJsonDatabase(text: string, title: string): ParsedDatabase {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  let rows: unknown[];
  if (Array.isArray(parsed)) {
    rows = parsed;
  } else if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const collection = [object.data, object.results, object.records].find(Array.isArray);
    rows = Array.isArray(collection) ? collection : [parsed];
  } else {
    throw new Error("JSON must contain an object or an array of objects");
  }
  if (rows.length === 0) throw new Error("JSON database has no rows to infer columns from");
  const sourceRows = rows.map(normalizeJsonRow);
  const names = [...new Set(sourceRows.flatMap((row) => Object.keys(row)))];
  const hints: Record<string, PropertyHint> = {};
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const properties =
      record.properties &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
        ? (record.properties as Record<string, unknown>)
        : record;
    for (const [name, value] of Object.entries(properties)) {
      if (hints[name]) continue;
      const hint = notionPropertyHint(value);
      if (hint) hints[name] = hint;
    }
  }
  return makeDatabase(title, names, sourceRows, hints);
}
