import { useEffect, useMemo, useState } from "react";
import { Button, Input } from "@aetherAssembly/ui";
import type {
  DatabaseCellValue,
  DatabaseData,
  DatabaseMeta,
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseRow,
} from "../../shared/ipc";
import { evaluateFormula, type FormulaValue } from "../lib/formula";

const EDITABLE_TYPES: DatabasePropertyType[] = [
  "title",
  "text",
  "number",
  "checkbox",
  "date",
  "select",
  "multi_select",
  "url",
  "email",
  "phone",
  "status",
  "people",
  "files",
  "formula",
  "relation",
  "rollup",
];

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

function cellText(value: DatabaseCellValue | FormulaValue): string {
  if (value === null) return "";
  if (Array.isArray(value))
    return value.map((item) => (item === null ? "" : String(item))).join(", ");
  return String(value);
}

interface DatabaseViewProps {
  databaseId: string;
  onDeleted: () => void;
}

export function DatabaseView({ databaseId, onDeleted }: DatabaseViewProps) {
  const [data, setData] = useState<DatabaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState("");
  const [newPropertyType, setNewPropertyType] = useState<DatabasePropertyType>("text");
  const [databaseOptions, setDatabaseOptions] = useState<DatabaseMeta[]>([]);
  const [relationDatabaseId, setRelationDatabaseId] = useState("");
  const [rollupRelationPropertyId, setRollupRelationPropertyId] = useState("");
  const [rollupTargetPropertyId, setRollupTargetPropertyId] = useState("");
  const [rollupFunction, setRollupFunction] =
    useState<NonNullable<DatabaseProperty["rollupFunction"]>>("show_original");
  const [relatedData, setRelatedData] = useState<Record<string, DatabaseData>>({});

  useEffect(() => {
    setData(null);
    setError(null);
    void Promise.all([
      window.driftleaf.databases.read(databaseId),
      window.driftleaf.databases.list(),
    ])
      .then(([database, databases]) => {
        setData(database);
        setDatabaseOptions(databases.filter((item) => item.id !== databaseId));
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not open database"),
      );
  }, [databaseId]);

  const rowsById = useMemo(() => new Map(data?.rows.map((row) => [row.id, row]) ?? []), [data]);
  const relationDatabaseIds = (data?.properties ?? [])
    .filter((property) => property.type === "relation" && property.relationDatabaseId)
    .map((property) => property.relationDatabaseId!);
  const relationDatabaseKey = [...new Set(relationDatabaseIds)].sort().join("|");

  useEffect(() => {
    if (!relationDatabaseKey) {
      setRelatedData({});
      return;
    }
    const ids = relationDatabaseKey.split("|");
    void Promise.all(ids.map((id) => window.driftleaf.databases.read(id)))
      .then((databases) =>
        setRelatedData(Object.fromEntries(databases.map((item) => [item.meta.id, item]))),
      )
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load related database"),
      );
  }, [relationDatabaseKey]);

  function updateCell(
    rowId: string,
    propertyId: string,
    value: DatabaseCellValue,
  ): DatabaseData | null {
    if (!data) return null;
    const next: DatabaseData = {
      ...data,
      rows: data.rows.map((row) =>
        row.id === rowId
          ? { ...row, values: { ...row.values, [propertyId]: value }, updatedAt: Date.now() }
          : row,
      ),
    };
    setData(next);
    return next;
  }

  async function save(nextData = data) {
    if (!nextData) return;
    setBusy(true);
    setError(null);
    try {
      await window.driftleaf.databases.update(databaseId, nextData.properties, nextData.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save database");
      const refreshed = await window.driftleaf.databases.read(databaseId).catch(() => null);
      if (refreshed) setData(refreshed);
    } finally {
      setBusy(false);
    }
  }

  async function addRow() {
    setError(null);
    try {
      const row = await window.driftleaf.databases.createRow(databaseId);
      setData((current) => (current ? { ...current, rows: [...current.rows, row] } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add row");
    }
  }

  async function deleteRow(rowId: string) {
    setError(null);
    try {
      await window.driftleaf.databases.deleteRow(databaseId, rowId);
      setData((current) =>
        current ? { ...current, rows: current.rows.filter((row) => row.id !== rowId) } : current,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete row");
    }
  }

  async function deleteDatabase() {
    if (
      !window.confirm(`Delete the "${data?.meta.title ?? "database"}" database and all its rows?`)
    ) {
      return;
    }
    setError(null);
    try {
      await window.driftleaf.databases.delete(databaseId);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete database");
    }
  }

  async function addProperty() {
    const name = newPropertyName.trim();
    if (!data || !name) return;
    if (data.properties.some((property) => property.name === name)) {
      setError("A property with that name already exists.");
      return;
    }
    const selectedRelationDatabase = databaseOptions.find(
      (database) => database.id === relationDatabaseId,
    );
    if (newPropertyType === "relation" && !selectedRelationDatabase) {
      setError("Choose the database this relation should link to.");
      return;
    }
    if (newPropertyType === "rollup") {
      const relationProperty = data.properties.find(
        (property) => property.id === rollupRelationPropertyId && property.type === "relation",
      );
      const linkedDatabase = relationProperty?.relationDatabaseId
        ? relatedData[relationProperty.relationDatabaseId]
        : undefined;
      if (
        !relationProperty ||
        !linkedDatabase?.properties.some((property) => property.id === rollupTargetPropertyId)
      ) {
        setError("Choose a relation and a property to roll up.");
        return;
      }
    }
    const options =
      newPropertyType === "select" ||
      newPropertyType === "status" ||
      newPropertyType === "multi_select"
        ? (window.prompt("Enter options separated by commas") ?? "")
            .split(",")
            .map((option) => option.trim())
            .filter(Boolean)
        : undefined;
    const property: DatabaseProperty = {
      id: crypto.randomUUID(),
      name,
      type: newPropertyType,
      ...(newPropertyType === "formula" ? { formula: "" } : {}),
      ...(options ? { options } : {}),
      ...(newPropertyType === "relation" && selectedRelationDatabase
        ? { relationDatabaseId: selectedRelationDatabase.id }
        : {}),
      ...(newPropertyType === "rollup"
        ? {
            rollupRelationPropertyId,
            rollupTargetPropertyId,
            rollupFunction,
          }
        : {}),
    };
    const properties = [...data.properties, property];
    const rows = data.rows.map((row) => ({
      ...row,
      values: {
        ...row.values,
        [property.id]: newPropertyType === "checkbox" ? false : null,
      },
    }));
    setData({ ...data, properties, rows });
    setNewPropertyName("");
    setError(null);
    try {
      await window.driftleaf.databases.update(databaseId, properties, rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add database property");
      const refreshed = await window.driftleaf.databases.read(databaseId).catch(() => null);
      if (refreshed) setData(refreshed);
    }
  }

  function updateFormula(propertyId: string) {
    if (!data) return;
    const property = data.properties.find((item) => item.id === propertyId);
    if (!property) return;
    const formula = window.prompt(
      'Enter a formula, for example: if(prop("Done"), "Complete", "Open")',
      property.formula ?? "",
    );
    if (formula === null) return;
    const properties = data.properties.map((item) =>
      item.id === propertyId ? { ...item, formula } : item,
    );
    setData({ ...data, properties });
    void window.driftleaf.databases
      .update(databaseId, properties, data.rows)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not save formula"),
      );
  }

  function rollupValue(row: DatabaseRow, property: DatabaseProperty): FormulaValue {
    const relation = data?.properties.find(
      (candidate) => candidate.id === property.rollupRelationPropertyId,
    );
    const linked = relation?.relationDatabaseId
      ? relatedData[relation.relationDatabaseId]
      : undefined;
    if (!relation || !linked) return null;
    const relationIds = row.values[relation.id];
    const linkedIds = Array.isArray(relationIds)
      ? relationIds
      : typeof relationIds === "string"
        ? relationIds.split(",").map((id) => id.trim())
        : [];
    const target = linked.properties.find(
      (candidate) => candidate.id === property.rollupTargetPropertyId,
    );
    if (!target) return null;
    const values = linked.rows
      .filter((linkedRow) => linkedIds.includes(linkedRow.id))
      .map((linkedRow) => linkedRow.values[target.id] ?? null)
      .filter((value) => value !== null);
    switch (property.rollupFunction) {
      case "count":
        return values.length;
      case "sum":
        return values.reduce<number>(
          (total, value) => total + (typeof value === "number" ? value : Number(value) || 0),
          0,
        );
      case "average":
        return values.length
          ? values.reduce<number>(
              (total, value) => total + (typeof value === "number" ? value : Number(value) || 0),
              0,
            ) / values.length
          : null;
      case "min":
        return values.length ? Math.min(...values.map(Number)) : null;
      case "max":
        return values.length ? Math.max(...values.map(Number)) : null;
      default:
        return values.map((value) => (Array.isArray(value) ? value.join(", ") : String(value)));
    }
  }

  function renderCell(rowId: string, property: DatabaseProperty) {
    const row = rowsById.get(rowId);
    if (!row || !data) return null;
    if (property.type === "formula") {
      let value: FormulaValue;
      try {
        value = formulaValue(data, row, property);
      } catch (err) {
        value = `#ERROR: ${err instanceof Error ? err.message : "Invalid formula"}`;
      }
      return (
        <div className="database__formula-cell" title={property.formula ?? "No formula set"}>
          {cellText(value)}
          <Button variant="ghost" size="sm" onClick={() => updateFormula(property.id)}>
            Formula
          </Button>
        </div>
      );
    }
    if (property.type === "rollup") {
      const value = rollupValue(row, property);
      return <span>{Array.isArray(value) ? value.join(", ") : cellText(value)}</span>;
    }
    if (property.type === "relation" && property.relationDatabaseId) {
      const linked = relatedData[property.relationDatabaseId];
      const ids = row.values[property.id];
      const selectedIds = Array.isArray(ids)
        ? ids
        : typeof ids === "string"
          ? ids
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean)
          : [];
      const titleProperty = linked?.properties.find((candidate) => candidate.type === "title");
      return (
        <select
          aria-label={property.name}
          multiple
          value={selectedIds}
          onChange={(event) => {
            const next = updateCell(
              row.id,
              property.id,
              Array.from(event.target.selectedOptions, (option) => option.value),
            );
            if (next) void save(next);
          }}
        >
          {linked?.rows.map((linkedRow) => (
            <option key={linkedRow.id} value={linkedRow.id}>
              {titleProperty ? cellText(linkedRow.values[titleProperty.id] ?? null) : linkedRow.id}
            </option>
          ))}
        </select>
      );
    }
    if (property.type === "multi_select" && property.options?.length) {
      const selected = row.values[property.id];
      const selectedValues = Array.isArray(selected)
        ? selected
        : typeof selected === "string"
          ? selected
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
      return (
        <select
          aria-label={property.name}
          multiple
          value={selectedValues}
          onChange={(event) => {
            const next = updateCell(
              row.id,
              property.id,
              Array.from(event.target.selectedOptions, (option) => option.value),
            );
            if (next) void save(next);
          }}
        >
          {property.options.map((option) => (
            <option value={option} key={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    if (["created_time", "last_edited_time"].includes(property.type)) {
      const value = row.values[property.id];
      const timestamp =
        typeof value === "string"
          ? Date.parse(value)
          : property.type === "created_time"
            ? row.createdAt
            : row.updatedAt;
      return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "";
    }
    if (property.type === "created_by" || property.type === "last_edited_by") {
      return cellText(row.values[property.id] ?? null);
    }
    if (property.type === "checkbox") {
      return (
        <input
          aria-label={property.name}
          type="checkbox"
          checked={row.values[property.id] === true}
          onChange={(event) => {
            const next = updateCell(row.id, property.id, event.target.checked);
            if (next) void save(next);
          }}
        />
      );
    }
    if (property.type === "select" || property.type === "status") {
      const options = property.options ?? [];
      return (
        <select
          aria-label={property.name}
          value={cellText(row.values[property.id] ?? null)}
          onChange={(event) => {
            const next = updateCell(row.id, property.id, event.target.value || null);
            if (next) void save(next);
          }}
        >
          <option value="">—</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    if (property.type === "date") {
      return (
        <input
          aria-label={property.name}
          type="date"
          value={cellText(row.values[property.id] ?? null).slice(0, 10)}
          onChange={(event) => updateCell(row.id, property.id, event.target.value || null)}
          onBlur={() => void save()}
        />
      );
    }
    const inputType = property.type === "number" ? "number" : "text";
    const value = row.values[property.id] ?? null;
    return (
      <input
        aria-label={property.name}
        type={inputType}
        value={cellText(value)}
        onChange={(event) =>
          updateCell(
            row.id,
            property.id,
            property.type === "number" && event.target.value !== ""
              ? Number(event.target.value)
              : event.target.value || null,
          )
        }
        onBlur={() => void save()}
      />
    );
  }

  if (!data)
    return (
      <section className="database">
        <p>{error ?? "Loading database…"}</p>
      </section>
    );

  const rollupRelation = data.properties.find(
    (property) => property.id === rollupRelationPropertyId && property.type === "relation",
  );
  const rollupTargetDatabase = rollupRelation?.relationDatabaseId
    ? relatedData[rollupRelation.relationDatabaseId]
    : undefined;

  return (
    <section className="database">
      <header className="database__header">
        <div>
          <h1>{data.meta.title}</h1>
          <p>{data.rows.length} rows · Table view</p>
        </div>
        <Button variant="primary" size="sm" loading={busy} onClick={() => void addRow()}>
          + Row
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void deleteDatabase()}>
          Delete database
        </Button>
      </header>
      <div className="database__table-wrap">
        <table className="database__table">
          <thead>
            <tr>
              {data.properties.map((property) => (
                <th key={property.id}>
                  {property.name}
                  <small>{property.type}</small>
                  {property.type === "formula" && (
                    <Button variant="ghost" size="sm" onClick={() => updateFormula(property.id)}>
                      Edit formula
                    </Button>
                  )}
                </th>
              ))}
              <th aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.id}>
                {data.properties.map((property) => (
                  <td key={property.id}>{renderCell(row.id, property)}</td>
                ))}
                <td>
                  <Button variant="ghost" size="sm" onClick={() => void deleteRow(row.id)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="database__add-property"
        onSubmit={(event) => {
          event.preventDefault();
          void addProperty();
        }}
      >
        <Input
          aria-label="New property name"
          placeholder="Property name"
          value={newPropertyName}
          onChange={(event) => setNewPropertyName(event.target.value)}
        />
        <select
          aria-label="New property type"
          value={newPropertyType}
          onChange={(event) => {
            setNewPropertyType(event.target.value as DatabasePropertyType);
            setError(null);
          }}
        >
          {EDITABLE_TYPES.map((type) => (
            <option value={type} key={type}>
              {type}
            </option>
          ))}
        </select>
        {newPropertyType === "relation" && (
          <select
            aria-label="Related database"
            value={relationDatabaseId}
            onChange={(event) => setRelationDatabaseId(event.target.value)}
          >
            <option value="">Link database…</option>
            {databaseOptions.map((database) => (
              <option key={database.id} value={database.id}>
                {database.title}
              </option>
            ))}
          </select>
        )}
        {newPropertyType === "rollup" && (
          <>
            <select
              aria-label="Relation property"
              value={rollupRelationPropertyId}
              onChange={(event) => {
                setRollupRelationPropertyId(event.target.value);
                setRollupTargetPropertyId("");
              }}
            >
              <option value="">Relation…</option>
              {data.properties
                .filter((property) => property.type === "relation")
                .map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
            </select>
            <select
              aria-label="Rollup property"
              value={rollupTargetPropertyId}
              onChange={(event) => setRollupTargetPropertyId(event.target.value)}
            >
              <option value="">Property…</option>
              {rollupTargetDatabase?.properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Rollup calculation"
              value={rollupFunction}
              onChange={(event) =>
                setRollupFunction(
                  event.target.value as NonNullable<DatabaseProperty["rollupFunction"]>,
                )
              }
            >
              {["show_original", "count", "sum", "average", "min", "max"].map((fn) => (
                <option value={fn} key={fn}>
                  {fn}
                </option>
              ))}
            </select>
          </>
        )}
        <Button variant="secondary" size="sm" type="submit">
          + Property
        </Button>
      </form>
      {error && <p className="database__error">{error}</p>}
    </section>
  );
}
