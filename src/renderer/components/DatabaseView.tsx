import { draftWrites } from "../lib/draft-writes";
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal } from "@aetherAssembly/ui";
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

function parseDateValue(value: DatabaseCellValue | FormulaValue): Date | null {
  const text = cellText(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateKey(date) === text ? date : null;
}

function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function comparableValue(value: DatabaseCellValue | FormulaValue): string | number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return cellText(value).toLocaleLowerCase();
}

function DatabaseViewIcon({ type }: { type: DatabaseViewType }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {type === "table" && (
        <>
          <rect x="2.5" y="3" width="15" height="14" rx="1.5" />
          <path d="M2.5 7.5h15M7.5 7.5V17M12.5 7.5V17" />
        </>
      )}
      {type === "board" && (
        <>
          <rect x="2.5" y="3" width="4.5" height="14" rx="1" />
          <rect x="7.75" y="3" width="4.5" height="14" rx="1" />
          <rect x="13" y="3" width="4.5" height="14" rx="1" />
        </>
      )}
      {type === "calendar" && (
        <>
          <rect x="2.5" y="4" width="15" height="13" rx="1.5" />
          <path d="M6.5 2.5v3M13.5 2.5v3M2.5 8h15M6 11h2M10 11h2M6 14h2" />
        </>
      )}
      {type === "gallery" && (
        <>
          <rect x="2.5" y="3" width="6.5" height="6.5" rx="1" />
          <rect x="11" y="3" width="6.5" height="6.5" rx="1" />
          <rect x="2.5" y="11.5" width="6.5" height="5.5" rx="1" />
          <rect x="11" y="11.5" width="6.5" height="5.5" rx="1" />
        </>
      )}
      {type === "list" && (
        <>
          <path d="M7 4h10M7 8h10M7 12h10M7 16h10" />
          <circle cx="3.5" cy="4" r=".5" fill="currentColor" />
          <circle cx="3.5" cy="8" r=".5" fill="currentColor" />
          <circle cx="3.5" cy="12" r=".5" fill="currentColor" />
          <circle cx="3.5" cy="16" r=".5" fill="currentColor" />
        </>
      )}
      {type === "timeline" && (
        <>
          <path d="M3 5h14M3 10h14M3 15h14" />
          <rect x="5" y="3.5" width="5" height="3" rx="1" />
          <rect x="10" y="8.5" width="6" height="3" rx="1" />
          <rect x="4" y="13.5" width="7" height="3" rx="1" />
        </>
      )}
    </svg>
  );
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
  const [newPropertyOptions, setNewPropertyOptions] = useState("");
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
  const [calendarWeekAnchor, setCalendarWeekAnchor] = useState(() => new Date());
  const [calendarMode, setCalendarMode] = useState<"month" | "week">("month");
  const [newViewType, setNewViewType] = useState<DatabaseViewType | null>(null);
  const [newViewName, setNewViewName] = useState("");
  const [addingCalendarRow, setAddingCalendarRow] = useState(false);

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
    stageDatabase(next);
    return next;
  }

  function stageDatabase(nextData: DatabaseData) {
    draftWrites.set(`database:${databaseId}`, () => window.driftleaf.databases.update(
      databaseId, nextData.properties, nextData.rows, nextData.views, nextData.activeViewId,
    ));
  }

  async function save(nextData = data) {
    if (!nextData) return;
    stageDatabase(nextData);
    setBusy(true);
    setError(null);
    try {
      await draftWrites.flush();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save database; edits retained for retry");
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
      stageDatabase(nextData);
      await draftWrites.flush();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save database view");
    }
  }

  function updateActiveView(update: Partial<DatabaseViewDefinition>) {
    if (!data || !activeView) return;
    const nextViews = views.map((view) =>
      view.id === activeView.id ? { ...view, ...update } : view,
    );
    void persistViews(nextViews, activeViewId);
  }

  function addDatabaseView(type: DatabaseViewType, name: string) {
    if (!data) return;
    const view: DatabaseViewDefinition = {
      id: crypto.randomUUID(),
      name: name.trim(),
      type,
      sortDirection: "ascending",
      filters: [],
      ...(type === "board"
        ? { groupPropertyId: data.properties.find((property) => property.type === "status" || property.type === "select" || property.type === "checkbox")?.id }
        : {}),
      ...(type === "calendar"
        ? { datePropertyId: data.properties.find((property) => property.type === "date")?.id }
        : {}),
      ...(type === "timeline"
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
      await draftWrites.flush();
      const row = await window.driftleaf.databases.createRow(databaseId);
      setData((current) => (current ? { ...current, rows: [...current.rows, row] } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add row");
    }
  }

  async function addCalendarRow(date: Date, property: DatabaseProperty) {
    if (!data || busy || addingCalendarRow) return;
    setAddingCalendarRow(true);
    setError(null);
    try {
      await draftWrites.flush();
      const row = await window.driftleaf.databases.createRow(databaseId);
      const nextRow = {
        ...row,
        values: { ...row.values, [property.id]: localDateKey(date) },
      };
      const nextData = { ...data, rows: [...data.rows, nextRow] };
      setData(nextData);
      await save(nextData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add calendar row");
    } finally {
      setAddingCalendarRow(false);
    }
  }

  async function deleteRow(rowId: string) {
    setError(null);
    try {
      await draftWrites.flush();
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
      draftWrites.remove(`database:${databaseId}`);
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
      await draftWrites.flush();
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
      await draftWrites.flush();
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
        ? newPropertyOptions
            .split(/\r?\n|,/)
            .map((option) => option.trim())
            .filter((option, index, all) => option.length > 0 && all.indexOf(option) === index)
        : undefined;
    if (
      (newPropertyType === "select" ||
        newPropertyType === "status" ||
        newPropertyType === "multi_select") &&
      (!options || options.length === 0)
    ) {
      setError("Add at least one option, separated by commas or new lines.");
      return;
    }
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
    setNewPropertyOptions("");
    setNewFormula("");
    setError(null);
    setBusy(true);
    try {
      stageDatabase({ ...data, properties, rows });
      await draftWrites.flush();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add database property");
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
      stageDatabase(nextData);
      await draftWrites.flush();
      setEditingFormulaId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save formula");
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
      stageDatabase(nextData);
      await draftWrites.flush();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : failureMessage);
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
      endDatePropertyId: view.endDatePropertyId === propertyId ? undefined : view.endDatePropertyId,
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
  const endDateProperty = activeView?.endDatePropertyId
    ? data?.properties.find((property) => property.id === activeView.endDatePropertyId)
    : undefined;
  const calendarStart = new Date(calendarMonth);
  calendarStart.setDate(1 - calendarStart.getDay());
  const calendarDays = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(calendarStart);
    date.setDate(calendarStart.getDate() + index);
    return date;
  });
  const calendarWeekStart = new Date(calendarWeekAnchor);
  calendarWeekStart.setDate(calendarWeekAnchor.getDate() - calendarWeekAnchor.getDay());
  const visibleCalendarDays =
    calendarMode === "week"
      ? Array.from({ length: 7 }, (_, index) => {
          const date = new Date(calendarWeekStart);
          date.setDate(calendarWeekStart.getDate() + index);
          return date;
        })
      : calendarDays;
  const timelineDays = Array.from({ length: 42 }, (_, index) => {
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
            <DatabaseViewIcon type={view.type} />
            {view.name}
          </Button>
        ))}
        <label className="database__add-view">
          <span aria-hidden="true">+</span>
          <select
            aria-label="Add database view"
            value=""
            onChange={(event) => {
              const selectedType = event.currentTarget.value;
              const type = (["table", "board", "calendar", "gallery", "list", "timeline"] as const).find(
                (candidate) => candidate === selectedType,
              );
              if (!type) return;
              setNewViewType(type);
              setNewViewName(type[0].toUpperCase() + type.slice(1));
            }}
          >
            <option value="">Add view…</option>
            <option value="table">Table</option>
            <option value="board">Board</option>
            <option value="calendar">Calendar</option>
            <option value="gallery">Gallery</option>
            <option value="list">List</option>
            <option value="timeline">Timeline</option>
          </select>
        </label>
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
        {activeView?.type === "calendar" || activeView?.type === "timeline" ? (
          <label>
            {activeView.type === "calendar" ? "Date" : "Start date"}
            <select
              aria-label={activeView.type === "calendar" ? "Calendar date property" : "Timeline start date property"}
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
        {activeView?.type === "timeline" ? (
          <label>
            End date
            <select
              aria-label="Timeline end date property"
              value={activeView.endDatePropertyId ?? ""}
              onChange={(event) => updateActiveView({ endDatePropertyId: event.target.value || undefined })}
            >
              <option value="">No end date</option>
              {data.properties
                .filter((property) => property.type === "date" && property.id !== activeView.datePropertyId)
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
      ) : activeView.type === "timeline" ? (
        <section className="database__timeline">
          <header className="database__timeline-header">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Previous month"
              onClick={() =>
                setCalendarMonth(
                  new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1),
                )
              }
            >
              Previous month
            </Button>
            <h2>{calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Next month"
              onClick={() =>
                setCalendarMonth(
                  new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1),
                )
              }
            >
              Next month
            </Button>
          </header>
          {!dateProperty ? (
            <p className="database__empty-view">
              {data.properties.some((property) => property.type === "date")
                ? "Choose a start date property to show rows on this timeline."
                : "Add a date property, then choose it as the timeline start date."}
            </p>
          ) : (
            <div className="database__timeline-scroll">
              <div className="database__timeline-grid" role="table" aria-label="Database timeline">
                <div className="database__timeline-label" role="columnheader">
                  {titleProperty?.name ?? "Row"}
                </div>
                {timelineDays.map((date) => (
                  <div
                    className={`database__timeline-day${date.getMonth() === calendarMonth.getMonth() ? "" : " database__timeline-day--outside"}${localDateKey(date) === localDateKey(new Date()) ? " database__timeline-day--today" : ""}`}
                    key={localDateKey(date)}
                    role="columnheader"
                    title={date.toLocaleDateString()}
                  >
                    {date.getDate()}
                  </div>
                ))}
                {sortedRows.map((row) => {
                  const title = titleProperty
                    ? cellText(propertyValue(row, titleProperty)) || "Untitled"
                    : "Untitled";
                  const start = parseDateValue(propertyValue(row, dateProperty));
                  const end = endDateProperty
                    ? parseDateValue(propertyValue(row, endDateProperty))
                    : start;
                  const invalidRange = start !== null && end !== null && end < start;
                  const clippedStart =
                    start && start < timelineDays[0] ? timelineDays[0] : start;
                  const lastDay = timelineDays[timelineDays.length - 1];
                  const clippedEnd = end && end > lastDay ? lastDay : end;
                  const startIndex = clippedStart
                    ? dayNumber(clippedStart) - dayNumber(timelineDays[0])
                    : -1;
                  const endIndex = clippedEnd
                    ? dayNumber(clippedEnd) - dayNumber(timelineDays[0])
                    : -1;
                  const isVisible =
                    start !== null &&
                    end !== null &&
                    !invalidRange &&
                    end >= timelineDays[0] &&
                    start <= lastDay;
                  let dateMessage = "";
                  if (!start) dateMessage = "Missing or invalid start date";
                  else if (endDateProperty && !end) dateMessage = "Missing or invalid end date";
                  else if (invalidRange) dateMessage = "End date is before start date";
                  else if (!isVisible) dateMessage = "Outside visible month";
                  return (
                    <div className="database__timeline-row" role="row" key={row.id}>
                      <div className="database__timeline-row-title" role="rowheader">
                        <strong>{title}</strong>
                        {endDateProperty ? (
                          <small>
                            {cellText(propertyValue(row, dateProperty)) || "No start"} –{" "}
                            {cellText(propertyValue(row, endDateProperty)) || "No end"}
                          </small>
                        ) : (
                          <small>{cellText(propertyValue(row, dateProperty)) || "No date"}</small>
                        )}
                      </div>
                      {isVisible ? (
                        <div
                          className="database__timeline-bar"
                          style={{
                            gridColumn: `${Math.max(0, startIndex) + 2} / ${Math.min(41, endIndex) + 3}`,
                          }}
                          title={`${title}: ${localDateKey(start!)}${end! > start! ? ` – ${localDateKey(end!)}` : ""}`}
                          role="cell"
                        >
                          {title}
                        </div>
                      ) : (
                        <div className="database__timeline-message" role="cell">
                          {dateMessage}
                        </div>
                      )}
                    </div>
                  );
                })}
                {sortedRows.length === 0 && (
                  <p className="database__empty-view">No rows match this view.</p>
                )}
              </div>
            </div>
          )}
        </section>
      ) : activeView.type === "gallery" ? (
        <div className="database__gallery">
          {sortedRows.map((row) => (
            <article className="database__gallery-card" key={row.id}>
              {titleProperty && (
                <div className="database__gallery-property database__gallery-title">
                  <small>{titleProperty.name}</small>
                  {renderCell(row.id, titleProperty)}
                </div>
              )}
              {data.properties
                .filter((property) => property.id !== titleProperty?.id)
                .slice(0, 4)
                .map((property) => (
                  <div className="database__gallery-property" key={property.id}>
                    <small>{property.name}</small>
                    {renderCell(row.id, property)}
                  </div>
                ))}
              <Button variant="ghost" size="sm" onClick={() => void deleteRow(row.id)}>
                Delete row
              </Button>
            </article>
          ))}
          {sortedRows.length === 0 && <p className="database__empty-view">No rows match this view.</p>}
        </div>
      ) : activeView.type === "list" ? (
        <div className="database__list-view">
          {sortedRows.map((row) => (
            <article className="database__list-row" key={row.id}>
              {titleProperty && (
                <div className="database__list-property database__list-title">
                  <small>{titleProperty.name}</small>
                  {renderCell(row.id, titleProperty)}
                </div>
              )}
              {data.properties
                .filter((property) => property.id !== titleProperty?.id)
                .slice(0, 2)
                .map((property) => (
                  <div className="database__list-property" key={property.id}>
                    <small>{property.name}</small>
                    {renderCell(row.id, property)}
                  </div>
                ))}
              <Button variant="ghost" size="sm" onClick={() => void deleteRow(row.id)}>
                Delete row
              </Button>
            </article>
          ))}
          {sortedRows.length === 0 && <p className="database__empty-view">No rows match this view.</p>}
        </div>
      ) : (
        <section className="database__calendar">
          <header>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Previous ${calendarMode}`}
              onClick={() =>
                calendarMode === "week"
                  ? setCalendarWeekAnchor((current) => {
                      const previous = new Date(current);
                      previous.setDate(current.getDate() - 7);
                      return previous;
                    })
                  : setCalendarMonth(
                      new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1),
                    )
              }
            >
              Previous {calendarMode}
            </Button>
            <h2 aria-live="polite">
              {calendarMode === "month"
                ? calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })
                : `${calendarWeekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${visibleCalendarDays[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`}
            </h2>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const now = new Date();
                setCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                setCalendarWeekAnchor(now);
              }}
            >
              Today
            </Button>
            <div className="database__calendar-mode" role="group" aria-label="Calendar view mode">
              <Button
                variant={calendarMode === "week" ? "primary" : "ghost"}
                size="sm"
                aria-pressed={calendarMode === "week"}
                onClick={() => setCalendarMode("week")}
              >
                Week
              </Button>
              <Button
                variant={calendarMode === "month" ? "primary" : "ghost"}
                size="sm"
                aria-pressed={calendarMode === "month"}
                onClick={() => setCalendarMode("month")}
              >
                Month
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Next ${calendarMode}`}
              onClick={() =>
                calendarMode === "week"
                  ? setCalendarWeekAnchor((current) => {
                      const next = new Date(current);
                      next.setDate(current.getDate() + 7);
                      return next;
                    })
                  : setCalendarMonth(
                      new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1),
                    )
              }
            >
              Next {calendarMode}
            </Button>
          </header>
          {dateProperty ? (
            <div className={`database__calendar-grid${calendarMode === "week" ? " database__calendar-grid--week" : ""}`}>
              {calendarMode === "month" &&
                ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                  <strong className="database__calendar-weekday" key={day}>{day}</strong>
                ))}
              {visibleCalendarDays.map((date) => {
                const day = localDateKey(date);
                const rows = sortedRows.filter(
                  (row) => cellText(propertyValue(row, dateProperty)).slice(0, 10) === day,
                );
                const isCurrentMonth = date.getMonth() === calendarMonth.getMonth();
                return (
                  <div
                    className={`database__calendar-day${calendarMode === "month" && !isCurrentMonth ? " database__calendar-day--outside" : ""}${day === localDateKey(new Date()) ? " database__calendar-day--today" : ""}`}
                    key={day}
                  >
                    <strong className="database__calendar-day-heading">
                      {calendarMode === "week" && (
                        <span>{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
                      )}
                      {date.getDate()}
                    </strong>
                    {rows.map((row) => (
                      <article className="database__calendar-event" key={row.id}>
                        {titleProperty && (
                          <div className="database__calendar-event-title">
                            {renderCell(row.id, titleProperty)}
                          </div>
                        )}
                        <div className="database__calendar-event-date">
                          {renderCell(row.id, dateProperty)}
                        </div>
                        {data.properties
                          .filter(
                            (property) =>
                              property.id !== titleProperty?.id &&
                              property.id !== dateProperty.id &&
                              property.type !== "formula" &&
                              property.type !== "rollup",
                          )
                          .slice(0, 2)
                          .map((property) => (
                            <div className="database__calendar-event-property" key={property.id}>
                              <small>{property.name}</small>
                              {renderCell(row.id, property)}
                            </div>
                          ))}
                      </article>
                    ))}
                    {(calendarMode === "week" || isCurrentMonth) && dateProperty && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="database__calendar-add-row"
                        aria-label={`Add row on ${date.toLocaleDateString()}`}
                        title={`Add row on ${date.toLocaleDateString()}`}
                        disabled={busy || addingCalendarRow}
                        onClick={() => void addCalendarRow(date, dateProperty)}
                      >
                        + Add
                      </Button>
                    )}
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
        {(newPropertyType === "select" ||
          newPropertyType === "status" ||
          newPropertyType === "multi_select") && (
          <label className="database__property-options">
            Options
            <textarea
              aria-label="Property options"
              value={newPropertyOptions}
              onChange={(event) => setNewPropertyOptions(event.target.value)}
              placeholder={"To do, In progress, Done"}
              rows={2}
              required
            />
            <small>Separate options with commas or put each option on a new line.</small>
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
            setNewPropertyOptions("");
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
      <details className="database__property-manager">
        <summary>Manage properties ({data.properties.length})</summary>
        <ul>
          {data.properties.map((property) => (
            <li key={property.id}>
              <span>
                <strong>{property.name}</strong>
                <small>{property.type.replaceAll("_", " ")}</small>
              </span>
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
            </li>
          ))}
        </ul>
      </details>
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
      <Modal
        open={newViewType !== null}
        onClose={() => setNewViewType(null)}
        title={`Create ${newViewType ?? ""} view`}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!newViewType || !newViewName.trim()) return;
            addDatabaseView(newViewType, newViewName);
            setNewViewType(null);
            setNewViewName("");
          }}
        >
          <Input
            autoFocus
            label="View name"
            aria-label="View name"
            value={newViewName}
            onChange={(event) => setNewViewName(event.target.value)}
          />
          <div className="modal-actions">
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setNewViewType(null);
                setNewViewName("");
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={!newViewName.trim()}>
              Create view
            </Button>
          </div>
        </form>
      </Modal>
      {error && <p className="database__error">{error}</p>}
    </section>
  );
}
