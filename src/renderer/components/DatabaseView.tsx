import { useEffect, useMemo, useState } from "react";
import { Button, Input } from "@aetherAssembly/ui";
import type {
  DatabaseCellValue,
  DatabaseData,
  DatabaseExportFormat,
  DatabaseMeta,
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseRow,
  DatabaseViewDefinition,
  DatabaseViewType,
} from "../../shared/ipc";
import { evaluateFormula, type FormulaValue } from "../../shared/formula";

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

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function comparableValue(value: DatabaseCellValue | FormulaValue): string | number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return cellText(value).toLocaleLowerCase();
}

interface DatabaseViewProps {
  databaseId: string;
  onDeleted: () => void;
  onRenamed: (meta: DatabaseMeta) => void;
}

export function DatabaseView({ databaseId, onDeleted, onRenamed }: DatabaseViewProps) {
  const [data, setData] = useState<DatabaseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingDatabase, setRenamingDatabase] = useState(false);
  const [databaseTitleDraft, setDatabaseTitleDraft] = useState("");
  const [renamingPropertyId, setRenamingPropertyId] = useState<string | null>(null);
  const [propertyNameDraft, setPropertyNameDraft] = useState("");
  const [propertyEditorOpen, setPropertyEditorOpen] = useState(false);
  const [newPropertyName, setNewPropertyName] = useState("");
  const [newPropertyType, setNewPropertyType] = useState<DatabasePropertyType>("text");
  const [newFormula, setNewFormula] = useState("");
  const [editingFormulaId, setEditingFormulaId] = useState<string | null>(null);
  const [formulaDraft, setFormulaDraft] = useState("");
  const [databaseOptions, setDatabaseOptions] = useState<DatabaseMeta[]>([]);
  const [relationDatabaseId, setRelationDatabaseId] = useState("");
  const [rollupRelationPropertyId, setRollupRelationPropertyId] = useState("");
  const [rollupTargetPropertyId, setRollupTargetPropertyId] = useState("");
  const [rollupFunction, setRollupFunction] =
    useState<NonNullable<DatabaseProperty["rollupFunction"]>>("show_original");
  const [relatedData, setRelatedData] = useState<Record<string, DatabaseData>>({});
  const [quickFilter, setQuickFilter] = useState("");
  const [filterPropertyId, setFilterPropertyId] = useState("");
  const [filterValue, setFilterValue] = useState("");
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    setData(null);
    setError(null);
    setRenamingDatabase(false);
    setRenamingPropertyId(null);
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
  const views = data?.views ?? [{ id: "table", name: "Table", type: "table" as const }];
  const activeView =
    views.find((view) => view.id === data?.activeViewId) ?? views[0];
  const activeViewId = activeView?.id ?? "table";
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
      await window.driftleaf.databases.update(
        databaseId,
        nextData.properties,
        nextData.rows,
        nextData.views,
        nextData.activeViewId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save database");
      const refreshed = await window.driftleaf.databases.read(databaseId).catch(() => null);
      if (refreshed) setData(refreshed);
    } finally {
      setBusy(false);
    }
  }

  async function persistViews(nextViews: DatabaseViewDefinition[], nextActiveViewId: string) {
    if (!data) return;
    const nextData = { ...data, views: nextViews, activeViewId: nextActiveViewId };
    setData(nextData);
    setError(null);
    try {
      await window.driftleaf.databases.update(
        databaseId,
        nextData.properties,
        nextData.rows,
        nextViews,
        nextActiveViewId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save database view");
      const refreshed = await window.driftleaf.databases.read(databaseId).catch(() => null);
      if (refreshed) setData(refreshed);
    }
  }

  function updateActiveView(update: Partial<DatabaseViewDefinition>) {
    if (!data || !activeView) return;
    const nextViews = views.map((view) =>
      view.id === activeView.id ? { ...view, ...update } : view,
    );
    void persistViews(nextViews, activeViewId);
  }

  function addDatabaseView(type: DatabaseViewType) {
    if (!data) return;
    const name = window.prompt(`Name this ${type} view`, type[0].toUpperCase() + type.slice(1));
    if (!name?.trim()) return;
    const view: DatabaseViewDefinition = {
      id: crypto.randomUUID(),
      name: name.trim(),
      type,
      sortDirection: "ascending",
      filters: [],
      ...(type === "board"
        ? { groupPropertyId: data.properties.find((property) => property.type === "status" || property.type === "select")?.id }
        : {}),
      ...(type === "calendar"
        ? { datePropertyId: data.properties.find((property) => property.type === "date")?.id }
        : {}),
    };
    void persistViews([...views, view], view.id);
  }

  function applyFilter() {
    if (!filterPropertyId) return;
    updateActiveView({
      filters: [
        ...(activeView?.filters ?? []).filter((filter) => filter.propertyId !== filterPropertyId),
        { propertyId: filterPropertyId, operator: "contains", value: filterValue },
      ],
    });
  }

  function removeFilter(propertyId: string) {
    updateActiveView({
      filters: (activeView?.filters ?? []).filter((filter) => filter.propertyId !== propertyId),
    });
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

  async function renameDatabase(titleDraft: string) {
    if (!data || busy) return;
    const title = titleDraft.trim();
    if (!title) {
      setError("Database name cannot be empty.");
      return;
    }
    if (title === data.meta.title) {
      setRenamingDatabase(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta = await window.driftleaf.databases.rename(databaseId, title);
      setData((current) => (current ? { ...current, meta } : current));
      setRenamingDatabase(false);
      onRenamed(meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename database");
    } finally {
      setBusy(false);
    }
  }

  async function exportDatabase(format: DatabaseExportFormat) {
    if (!window.confirm(
      `Export this database as an unencrypted ${format.toUpperCase()} file? The exported file can be read by anyone with access to its location.`,
    )) {
      return;
    }
    setError(null);
    try {
      await window.driftleaf.databases.export(databaseId, format);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export database");
    }
  }

  async function addProperty() {
    const name = newPropertyName.trim();
    if (!data || !name) return;
    if (busy) return;
    if (data.properties.some((property) => property.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError("A property with that name already exists.");
      return;
    }
    if (newPropertyType === "formula" && !newFormula.trim()) {
      setError("Enter a formula for this calculated property.");
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
      ...(newPropertyType === "formula" ? { formula: newFormula.trim() } : {}),
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
    setNewFormula("");
    setError(null);
    setBusy(true);
    try {
      await window.driftleaf.databases.update(
        databaseId,
        properties,
        rows,
        data.views,
        data.activeViewId,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add database property");
      const refreshed = await window.driftleaf.databases.read(databaseId).catch(() => null);
      if (refreshed) setData(refreshed);
    } finally {
      setBusy(false);
    }
  }

  function updateFormula(propertyId: string) {
    if (!data) return;
    const property = data.properties.find((item) => item.id === propertyId);
    if (!property) return;
    setEditingFormulaId(propertyId);
    setFormulaDraft(property.formula ?? "");
  }

  async function saveFormula() {
    if (!data || !editingFormulaId || busy) return;
    const formula = formulaDraft.trim();
    if (!formula) {
      setError("Enter a formula before saving.");
      return;
    }
    const properties = data.properties.map((item) =>
      item.id === editingFormulaId ? { ...item, formula } : item,
    );
    const nextData = { ...data, properties };
    setData(nextData);
    setError(null);
    setBusy(true);
    try {
      await window.driftleaf.databases.update(
        databaseId,
        properties,
        data.rows,
        data.views,
        data.activeViewId,
      );
      setEditingFormulaId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save formula");
      const refreshed = await window.driftleaf.databases.read(databaseId).catch(() => null);
      if (refreshed) setData(refreshed);
    } finally {
      setBusy(false);
    }
  }

  async function persistDatabase(
    nextData: DatabaseData,
    failureMessage: string,
  ): Promise<boolean> {
    setData(nextData);
    setError(null);
    setBusy(true);
    try {
      await window.driftleaf.databases.update(
        databaseId,
        nextData.properties,
        nextData.rows,
        nextData.views,
        nextData.activeViewId,
      );
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : failureMessage);
      const refreshed = await window.driftleaf.databases.read(databaseId).catch(() => null);
      if (refreshed) setData(refreshed);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function renameProperty(propertyId: string, nameDraft: string) {
    if (!data || busy) return;
    const property = data.properties.find((item) => item.id === propertyId);
    if (!property) return;
    const name = nameDraft.trim();
    if (!name) {
      setError("Property name cannot be empty.");
      return;
    }
    if (name === property.name) {
      setRenamingPropertyId(null);
      return;
    }
    if (data.properties.some((item) => item.id !== propertyId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setError("A property with that name already exists.");
      return;
    }
    const escapedName = property.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const reference = new RegExp(`(prop\\(\\s*")${escapedName}("\\s*\\))`, "g");
    const properties = data.properties.map((item) => ({
      ...item,
      name: item.id === propertyId ? name : item.name,
      ...(item.type === "formula"
        ? { formula: (item.formula ?? "").replace(reference, (_match, before: string, after: string) => `${before}${name}${after}`) }
        : {}),
    }));
    if (await persistDatabase({ ...data, properties }, "Could not rename database property")) {
      setRenamingPropertyId(null);
    }
  }

  async function removeProperty(propertyId: string) {
    if (!data || busy) return;
    const property = data.properties.find((item) => item.id === propertyId);
    if (!property || property.type === "title") return;
    const dependentFormula = data.properties.find(
      (item) =>
        item.type === "formula" &&
        item.id !== propertyId &&
        new RegExp(`prop\\(\\s*"${property.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\)`).test(
          item.formula ?? "",
        ),
    );
    if (dependentFormula) {
      setError(`Remove or update the "${dependentFormula.name}" formula before deleting this property.`);
      return;
    }
    const dependentRollup = data.properties.find(
      (item) => item.type === "rollup" && item.rollupRelationPropertyId === propertyId,
    );
    if (dependentRollup) {
      setError(`Remove the "${dependentRollup.name}" rollup before deleting this relation.`);
      return;
    }
    if (!window.confirm(`Delete the "${property.name}" property and its values from every row?`)) {
      return;
    }
    const properties = data.properties.filter((item) => item.id !== propertyId);
    const rows = data.rows.map((row) => {
      const values = { ...row.values };
      delete values[propertyId];
      return { ...row, values };
    });
    const views = (data.views ?? []).map((view) => ({
      ...view,
      sortPropertyId: view.sortPropertyId === propertyId ? undefined : view.sortPropertyId,
      groupPropertyId: view.groupPropertyId === propertyId ? undefined : view.groupPropertyId,
      datePropertyId: view.datePropertyId === propertyId ? undefined : view.datePropertyId,
      filters: (view.filters ?? []).filter((filter) => filter.propertyId !== propertyId),
    }));
    await persistDatabase(
      { ...data, properties, rows, views },
      "Could not delete database property",
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
      .map((linkedRow) => {
        if (target.type !== "formula") return linkedRow.values[target.id] ?? null;
        try {
          return formulaValue(linked, linkedRow, target);
        } catch (formulaError) {
          return `#ERROR: ${formulaError instanceof Error ? formulaError.message : "Invalid formula"}`;
        }
      })
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

  function propertyValue(row: DatabaseRow, property: DatabaseProperty): FormulaValue {
    if (property.type === "formula") {
      try {
        return formulaValue(data!, row, property);
      } catch (err) {
        return `#ERROR: ${err instanceof Error ? err.message : "Invalid formula"}`;
      }
    }
    if (property.type === "rollup") return rollupValue(row, property);
    return row.values[property.id] ?? null;
  }

  const normalizedQuickFilter = quickFilter.trim().toLocaleLowerCase();
  const filteredRows = (data?.rows ?? []).filter((row) => {
    if (
      normalizedQuickFilter &&
      !data!.properties.some((property) =>
        cellText(propertyValue(row, property)).toLocaleLowerCase().includes(normalizedQuickFilter),
      )
    ) {
      return false;
    }
    return (activeView?.filters ?? []).every((filter) => {
      const property = data!.properties.find((item) => item.id === filter.propertyId);
      if (!property) return true;
      const value = cellText(propertyValue(row, property)).trim();
      if (filter.operator === "is_empty") return !value;
      if (filter.operator === "is_not_empty") return !!value;
      if (filter.operator === "equals") {
        return value.toLocaleLowerCase() === filter.value.toLocaleLowerCase();
      }
      return value.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase());
    });
  });
  const sortProperty = activeView?.sortPropertyId
    ? data?.properties.find((property) => property.id === activeView.sortPropertyId)
    : undefined;
  const sortedRows = [...filteredRows].sort((left, right) => {
    if (!sortProperty) return 0;
    const a = comparableValue(propertyValue(left, sortProperty));
    const b = comparableValue(propertyValue(right, sortProperty));
    const result =
      typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return activeView?.sortDirection === "descending" ? -result : result;
  });
  const groupProperty = activeView?.groupPropertyId
    ? data?.properties.find((property) => property.id === activeView.groupPropertyId)
    : undefined;
  const groupLabel = (row: DatabaseRow) => {
    const value = groupProperty ? cellText(propertyValue(row, groupProperty)) : "";
    return value || "No value";
  };
  const boardGroups = groupProperty
    ? [
        ...new Set([
          ...(groupProperty.options ?? []),
          ...sortedRows.map(groupLabel),
        ]),
      ]
    : [];
  const dateProperty = activeView?.datePropertyId
    ? data?.properties.find((property) => property.id === activeView.datePropertyId)
    : undefined;
  const calendarStart = new Date(calendarMonth);
  calendarStart.setDate(1 - calendarStart.getDay());
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + index);
    return date;
  });

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
        <fieldset className="database__multi-value" aria-label={property.name}>
          {linked?.rows.map((linkedRow) => {
            const selected = selectedIds.includes(linkedRow.id);
            return (
              <label key={linkedRow.id}>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => {
                    const nextIds = selected
                      ? selectedIds.filter((id) => id !== linkedRow.id)
                      : [...selectedIds, linkedRow.id];
                    const next = updateCell(row.id, property.id, nextIds);
                    if (next) void save(next);
                  }}
                />
                {titleProperty
                  ? cellText(linkedRow.values[titleProperty.id] ?? null)
                  : linkedRow.id}
              </label>
            );
          })}
          {linked?.rows.length === 0 && <small>No rows in linked database.</small>}
        </fieldset>
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
        <fieldset className="database__multi-value" aria-label={property.name}>
          {property.options.map((option) => {
            const checked = selectedValues.includes(option);
            return (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const nextValues = checked
                      ? selectedValues.filter((value) => value !== option)
                      : [...selectedValues, option];
                    const next = updateCell(row.id, property.id, nextValues);
                    if (next) void save(next);
                  }}
                />
                {option}
              </label>
            );
          })}
        </fieldset>
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
  const titleProperty = data.properties.find((property) => property.type === "title");

  return (
    <section className="database">
      <header className="database__header">
        <div>
          {renamingDatabase ? (
            <form
              className="database__rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                void renameDatabase(databaseTitleDraft);
              }}
            >
              <Input
                aria-label="Database name"
                autoFocus
                value={databaseTitleDraft}
                onChange={(event) => setDatabaseTitleDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setRenamingDatabase(false);
                }}
              />
              <Button type="submit" variant="primary" size="sm" disabled={busy}>
                Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setRenamingDatabase(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <h1>{data.meta.title}</h1>
          )}
          <p>
            {filteredRows.length} of {data.rows.length} rows · {activeView?.name ?? "Table"}
            {busy ? " · Saving…" : ""}
          </p>
        </div>
        {!renamingDatabase && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setDatabaseTitleDraft(data.meta.title);
              setRenamingDatabase(true);
            }}
          >
            Rename database
          </Button>
        )}
        <Button variant="primary" size="sm" loading={busy} onClick={() => void addRow()}>
          + Row
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void exportDatabase("csv")}>
          Export CSV
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void exportDatabase("json")}>
          Export JSON
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void deleteDatabase()}>
          Delete database
        </Button>
      </header>
      <div className="database__view-tabs" role="tablist" aria-label="Database views">
        {views.map((view) => (
          <Button
            key={view.id}
            variant={view.id === activeViewId ? "primary" : "ghost"}
            size="sm"
            role="tab"
            aria-selected={view.id === activeViewId}
            onClick={() => void persistViews(views, view.id)}
          >
            {view.name}
          </Button>
        ))}
        {(["table", "board", "calendar"] as const).map((type) => (
          <Button
            key={type}
            variant="ghost"
            size="sm"
            onClick={() => addDatabaseView(type)}
            aria-label={`Add ${type} view`}
          >
            + {type}
          </Button>
        ))}
      </div>
      <div className="database__view-controls">
        <Input
          aria-label="Search database rows"
          placeholder="Search rows…"
          value={quickFilter}
          onChange={(event) => setQuickFilter(event.target.value)}
        />
        <label>
          Sort
          <select
            aria-label="Sort database rows"
            value={activeView?.sortPropertyId ?? ""}
            onChange={(event) =>
              updateActiveView({
                sortPropertyId: event.target.value || undefined,
                sortDirection: activeView?.sortDirection ?? "ascending",
              })
            }
          >
            <option value="">Default order</option>
            {data.properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Sort ${activeView?.sortDirection === "descending" ? "ascending" : "descending"}`}
          onClick={() =>
            updateActiveView({
              sortDirection: activeView?.sortDirection === "descending" ? "ascending" : "descending",
            })
          }
        >
          {activeView?.sortDirection === "descending" ? "Descending" : "Ascending"}
        </Button>
        {activeView?.type === "table" || activeView?.type === "board" ? (
          <label>
            Group
            <select
              aria-label="Group database rows"
              value={activeView.groupPropertyId ?? ""}
              onChange={(event) => updateActiveView({ groupPropertyId: event.target.value || undefined })}
            >
              <option value="">No grouping</option>
              {data.properties
                .filter((property) => property.type === "select" || property.type === "status" || property.type === "checkbox")
                .map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        {activeView?.type === "calendar" ? (
          <label>
            Date
            <select
              aria-label="Calendar date property"
              value={activeView.datePropertyId ?? ""}
              onChange={(event) => updateActiveView({ datePropertyId: event.target.value || undefined })}
            >
              <option value="">Choose date property</option>
              {data.properties
                .filter((property) => property.type === "date")
                .map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <label>
          Filter
          <select
            aria-label="Filter property"
            value={filterPropertyId}
            onChange={(event) => setFilterPropertyId(event.target.value)}
          >
            <option value="">Choose property…</option>
            {data.properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
        <Input
          aria-label="Filter value"
          placeholder="Contains…"
          value={filterValue}
          onChange={(event) => setFilterValue(event.target.value)}
        />
        <Button variant="secondary" size="sm" onClick={applyFilter} disabled={!filterPropertyId}>
          Add filter
        </Button>
      </div>
      {(activeView?.filters ?? []).length > 0 && (
        <div className="database__active-filters" aria-label="Active filters">
          {(activeView?.filters ?? []).map((filter) => (
            <Button
              key={filter.propertyId}
              variant="ghost"
              size="sm"
              onClick={() => removeFilter(filter.propertyId)}
            >
              {data.properties.find((property) => property.id === filter.propertyId)?.name} contains
              “{filter.value}” ×
            </Button>
          ))}
        </div>
      )}
      {activeView?.type === "table" ? (
      <div className="database__table-wrap">
        <table className="database__table">
          <thead>
            <tr>
              {data.properties.map((property) => (
                <th key={property.id}>
                  {renamingPropertyId === property.id ? (
                    <form
                      className="database__rename-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void renameProperty(property.id, propertyNameDraft);
                      }}
                    >
                      <Input
                        aria-label={`Name for ${property.name}`}
                        autoFocus
                        value={propertyNameDraft}
                        onChange={(event) => setPropertyNameDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setRenamingPropertyId(null);
                        }}
                      />
                      <Button type="submit" variant="primary" size="sm" disabled={busy}>
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setRenamingPropertyId(null)}
                      >
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    property.name
                  )}
                  <small>{property.type === "formula" ? "calculated · read-only" : property.type.replaceAll("_", " ")}</small>
                  {property.type === "formula" && (
                    <Button variant="ghost" size="sm" onClick={() => updateFormula(property.id)}>
                      Edit formula
                    </Button>
                  )}
                  {renamingPropertyId !== property.id && (
                    <div className="database__property-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setPropertyNameDraft(property.name);
                          setRenamingPropertyId(property.id);
                        }}
                      >
                        Rename
                      </Button>
                      {property.type !== "title" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void removeProperty(property.id)}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                  )}
                </th>
              ))}
              <th aria-label="Row actions" />
            </tr>
          </thead>
          <tbody>
            {groupProperty
              ? [...new Set(sortedRows.map(groupLabel))].flatMap((group) => [
                  <tr className="database__group-heading" key={`group-${group}`}>
                    <th colSpan={data.properties.length + 1}>{group}</th>
                  </tr>,
                  ...sortedRows
                    .filter((row) => groupLabel(row) === group)
                    .map((row) => (
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
                    )),
                ])
              : sortedRows.map((row) => (
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
      ) : activeView.type === "board" ? (
        <div className="database__board">
          {groupProperty
            ? boardGroups.map((group) => (
                <section className="database__board-column" key={group}>
                  <h2>{group}</h2>
                  {sortedRows
                    .filter((row) => groupLabel(row) === group)
                    .map((row) => (
                      <article className="database__board-card" key={row.id}>
                        <strong>{titleProperty ? cellText(propertyValue(row, titleProperty)) : "Untitled"}</strong>
                        {data.properties
                          .filter((property) => property.id !== titleProperty?.id && property.id !== groupProperty.id)
                          .slice(0, 3)
                          .map((property) => (
                            <div key={property.id}>
                              <small>{property.name}</small>
                              {renderCell(row.id, property)}
                            </div>
                          ))}
                        <Button variant="ghost" size="sm" onClick={() => void deleteRow(row.id)}>
                          Delete row
                        </Button>
                      </article>
                    ))}
                </section>
              ))
            : <p>Choose a select, status, or checkbox property to group this board.</p>}
        </div>
      ) : (
        <section className="database__calendar">
          <header>
            <Button variant="ghost" size="sm" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>
              Previous month
            </Button>
            <h2>{calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
            <Button variant="ghost" size="sm" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>
              Next month
            </Button>
          </header>
          {dateProperty ? (
            <div className="database__calendar-grid">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                <strong className="database__calendar-weekday" key={day}>{day}</strong>
              ))}
              {calendarDays.map((date) => {
                const day = localDateKey(date);
                const rows = sortedRows.filter(
                  (row) => cellText(propertyValue(row, dateProperty)).slice(0, 10) === day,
                );
                return (
                  <div
                    className={`database__calendar-day${date.getMonth() === calendarMonth.getMonth() ? "" : " database__calendar-day--outside"}`}
                    key={day}
                  >
                    <strong>{date.getDate()}</strong>
                    {rows.map((row) => (
                      <article className="database__calendar-event" key={row.id}>
                        {titleProperty ? cellText(propertyValue(row, titleProperty)) : "Untitled"}
                        {renderCell(row.id, dateProperty)}
                      </article>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : <p>Choose a date property to show rows on this calendar.</p>}
        </section>
      )}
      <form
        className="database__add-property"
        hidden={!propertyEditorOpen}
        onSubmit={(event) => {
          event.preventDefault();
          void addProperty();
        }}
      >
        <strong>Add property</strong>
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
              {type === "formula" ? "Formula (calculated)" : type.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        {newPropertyType === "formula" && (
          <label className="database__formula-editor">
            Formula expression
            <textarea
              aria-label="New formula expression"
              value={newFormula}
              onChange={(event) => setNewFormula(event.target.value)}
              placeholder={'if(prop("Done"), "Complete", "Open")'}
              rows={3}
            />
            <small>
              Calculated for every row; use <code>prop("Property name")</code> to refer to a
              property. Formula results are read-only.
            </small>
            {newFormula.trim() && data.rows[0] && (
              <small>
                Preview:{" "}
                {(() => {
                  try {
                    const sampleRow = data.rows[0];
                    return cellText(
                      evaluateFormula(newFormula, (name) => {
                        const referenced = data.properties.find((item) => item.name === name);
                        if (!referenced) throw new Error(`Unknown property: ${name}`);
                        return propertyValue(sampleRow, referenced);
                      }),
                    );
                  } catch (previewError) {
                    return `Formula needs attention: ${previewError instanceof Error ? previewError.message : "invalid expression"}`;
                  }
                })()}
              </small>
            )}
          </label>
        )}
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
        <Button variant="secondary" size="sm" type="submit" disabled={busy}>
          {newPropertyType === "formula" ? "+ Add calculated property" : "+ Add property"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => {
            setPropertyEditorOpen(false);
            setNewPropertyName("");
            setNewFormula("");
            setError(null);
          }}
        >
          Cancel
        </Button>
      </form>
      {!propertyEditorOpen && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setPropertyEditorOpen(true)}
          aria-label="Add a property"
        >
          + Add property
        </Button>
      )}
      {editingFormulaId && (
        <section className="database__formula-editor" aria-label="Edit formula">
          <label>
            Formula for{" "}
            <strong>
              {data.properties.find((property) => property.id === editingFormulaId)?.name}
            </strong>
            <textarea
              aria-label="Formula expression"
              value={formulaDraft}
              onChange={(event) => setFormulaDraft(event.target.value)}
              rows={4}
            />
          </label>
          <p>
            Formula columns calculate a result for each row. They do not store editable cell
            values.
          </p>
          <div>
            <Button variant="primary" size="sm" loading={busy} onClick={() => void saveFormula()}>
              Save formula
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingFormulaId(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </section>
      )}
      {error && <p className="database__error">{error}</p>}
    </section>
  );
}
