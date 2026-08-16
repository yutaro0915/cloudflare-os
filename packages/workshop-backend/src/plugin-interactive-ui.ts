import type {UserPluginInteractiveDocument} from "@gadgets/workshop-shared/api";

const MAX_INTERACTIVE_DOCUMENT_BYTES = 128 * 1024;
const ACTION_ID = /^[a-z0-9](?:[a-z0-9:._-]{0,126}[a-z0-9])?$/;
const ITEM_ID = /^[a-z0-9](?:[a-z0-9:._-]{0,126}[a-z0-9])?$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key));
}

function isDenseArray(value: unknown, maxLength: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > maxLength || Object.keys(value).length !== value.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function boundedText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maxLength &&
    (allowEmpty || value.trim().length > 0);
}

/** Validates untrusted interactive renderer output and returns an owned closed snapshot. */
export function snapshotUserPluginInteractiveDocument(
    value: unknown): UserPluginInteractiveDocument | null {
  if (
    !isPlainRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "title", "form", "columns"]) ||
    value.schemaVersion !== 1 || !boundedText(value.title, 120) ||
    !isDenseArray(value.columns, 8)
  ) return null;
  const form = value.form;
  if (
    form !== null && (!isPlainRecord(form) ||
      !hasOnlyKeys(form, ["actionId", "label", "placeholder", "maxLength"]) ||
      typeof form.actionId !== "string" || !ACTION_ID.test(form.actionId) ||
      !boundedText(form.label, 80) || !boundedText(form.placeholder, 120, true) ||
      !Number.isInteger(form.maxLength) || (form.maxLength as number) < 1 ||
      (form.maxLength as number) > 500)
  ) return null;
  let totalItems = 0;
  const columns = [] as UserPluginInteractiveDocument["columns"];
  const columnIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const candidate of value.columns) {
    if (
      !isPlainRecord(candidate) || !hasOnlyKeys(candidate, ["columnId", "title", "items"]) ||
      typeof candidate.columnId !== "string" || !ITEM_ID.test(candidate.columnId) ||
      columnIds.has(candidate.columnId) || !boundedText(candidate.title, 80) ||
      !isDenseArray(candidate.items, 128)
    ) return null;
    columnIds.add(candidate.columnId);
    totalItems += candidate.items.length;
    if (totalItems > 256) return null;
    const items = [] as UserPluginInteractiveDocument["columns"][number]["items"];
    for (const item of candidate.items) {
      if (
        !isPlainRecord(item) || !hasOnlyKeys(item, ["itemId", "title", "actions"]) ||
        typeof item.itemId !== "string" || !ITEM_ID.test(item.itemId) ||
        itemIds.has(item.itemId) || !boundedText(item.title, 500) ||
        !isDenseArray(item.actions, 16)
      ) return null;
      itemIds.add(item.itemId);
      const actions = [] as UserPluginInteractiveDocument["columns"][number]["items"][number]["actions"];
      for (const action of item.actions) {
        if (
          !isPlainRecord(action) || !hasOnlyKeys(action, ["actionId", "label", "tone"]) ||
          typeof action.actionId !== "string" || !ACTION_ID.test(action.actionId) ||
          !boundedText(action.label, 80) ||
          (action.tone !== "neutral" && action.tone !== "danger")
        ) return null;
        actions.push({actionId: action.actionId, label: action.label, tone: action.tone});
      }
      items.push({itemId: item.itemId, title: item.title, actions});
    }
    columns.push({columnId: candidate.columnId, title: candidate.title, items});
  }
  const snapshot: UserPluginInteractiveDocument = {
    schemaVersion: 1,
    title: value.title,
    form: form === null ? null : {
      actionId: form.actionId as string,
      label: form.label as string,
      placeholder: form.placeholder as string,
      maxLength: form.maxLength as number,
    },
    columns,
  };
  if (
    new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
      MAX_INTERACTIVE_DOCUMENT_BYTES
  ) return null;
  return structuredClone(snapshot);
}

/** Checks one bounded foreground action before it reaches an isolated reducer. */
export function isValidPluginUiAction(
    actionId: string, input: string | null): boolean {
  return ACTION_ID.test(actionId) &&
    (input === null || (input.length <= 500 && input.trim().length > 0));
}
