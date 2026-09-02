import path from "node:path";

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

export function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Argumenty narzędzia muszą być obiektem.");
  }
  return value;
}

export function requireString(value, name, maxLength = 200) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${name} jest wymagane.`);
  }
  if (value.length > maxLength) throw new InputError(`${name} jest zbyt długie.`);
  return value.trim();
}

export function optionalInteger(value, name, { min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${name} musi być liczbą całkowitą od ${min} do ${max}.`);
  }
  return value;
}

export function isoDate(value, name) {
  const text = requireString(value, name, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new InputError(`${name} musi mieć format YYYY-MM-DD.`);
  }
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== text) {
    throw new InputError(`${name} nie jest poprawną datą.`);
  }
  return text;
}

export function dateRange(from, to, maxDays = 31) {
  const dateFrom = isoDate(from, "date_from");
  const dateTo = isoDate(to, "date_to");
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  const days = Math.floor((end - start) / 86400000) + 1;
  if (days < 1) throw new InputError("date_to nie może być wcześniejsze niż date_from.");
  if (days > maxDays) throw new InputError(`Zakres dat nie może przekraczać ${maxDays} dni.`);
  return { dateFrom, dateTo, start, end, days };
}

export function clampLimit(requested, configuredMax, fallback = 50) {
  return optionalInteger(requested, "limit", {
    min: 1,
    max: configuredMax,
    fallback: Math.min(fallback, configuredMax),
  });
}

export function mondayOf(dateText) {
  const d = new Date(`${dateText}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
}

export function weekStarts(dateFrom, dateTo) {
  const starts = [];
  let cursor = new Date(`${mondayOf(dateFrom)}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  while (cursor <= end) {
    starts.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return starts;
}

const DATE_KEYS = [
  "Date", "date", "AddDate", "StartDate", "EndDate", "Deadline",
  "LessonDate", "EventDate", "From", "To", "TimeFrom", "TimeTo",
];

function normalizeDate(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/(\d{4})[-.](\d{2})[-.](\d{2})|(?:(\d{2})[.](\d{2})[.](\d{4}))/);
  if (!match) return null;
  return match[1]
    ? `${match[1]}-${match[2]}-${match[3]}`
    : `${match[6]}-${match[5]}-${match[4]}`;
}

export function objectDates(item) {
  if (!item || typeof item !== "object") return [];
  const dates = [];
  for (const key of DATE_KEYS) {
    const parsed = normalizeDate(item[key]);
    if (parsed) dates.push(parsed);
  }
  return dates;
}

export function filterDated(items, dateFrom, dateTo) {
  return items.filter((item) => {
    const dates = objectDates(item);
    return dates.length === 0 || dates.some((date) => date >= dateFrom && date <= dateTo);
  });
}

export function firstArray(payload, preferredKeys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

export function sanitizeFilename(name) {
  const base = path.basename(String(name || "zalacznik.bin"))
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return base || "zalacznik.bin";
}

export function filenameFromDisposition(disposition) {
  if (typeof disposition !== "string") return null;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1]); } catch { return encoded[1]; }
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain?.[1] ?? null;
}

export function containsAttachmentId(value, attachmentId) {
  const target = String(attachmentId);
  const seen = new Set();
  function visit(node, key = "", inAttachment = false) {
    const attachmentContext = inAttachment || /attachment|file|zalacz/i.test(key);
    if (node === null || node === undefined) return false;
    if (typeof node !== "object") {
      return attachmentContext && /(^id$|attachment|file|zalacz)/i.test(key) && String(node) === target;
    }
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((entry) => visit(entry, key, attachmentContext));
    return Object.entries(node).some(([childKey, child]) => visit(child, childKey, attachmentContext));
  }
  return visit(value);
}

export function publicChild(child, classPayload = null) {
  const schoolClass = classPayload?.Class ?? classPayload?.class ?? classPayload;
  return {
    id: child.id,
    login: child.login,
    student_name: child.studentName,
    account_identifier: child.accountIdentifier,
    group: child.group,
    class_id: classValue(schoolClass, ["Id", "id", "Identifier", "identifier"]) ?? child.group ?? null,
    class_name: className(schoolClass),
    state: child.state,
    scopes: child.scopes ?? [],
  };
}

function className(schoolClass) {
  if (!schoolClass || typeof schoolClass !== "object" || Array.isArray(schoolClass)) return null;
  const explicit = classValue(schoolClass, ["Name", "name", "ClassName", "className", "FullName", "fullName"]);
  if (explicit !== null) return String(explicit);

  const number = classValue(schoolClass, ["Number", "number"]);
  const symbol = classValue(schoolClass, ["Symbol", "symbol", "ShortName", "shortName"]);
  if (number !== null && symbol !== null) {
    const numberText = String(number).trim();
    const symbolText = String(symbol).trim();
    return symbolText.toLocaleLowerCase("pl-PL").startsWith(numberText.toLocaleLowerCase("pl-PL"))
      ? symbolText
      : `${numberText}${symbolText}`;
  }
  if (symbol !== null) return String(symbol);
  if (number !== null) return String(number);
  return null;
}

function classValue(schoolClass, keys) {
  if (!schoolClass || typeof schoolClass !== "object" || Array.isArray(schoolClass)) return null;
  for (const key of keys) {
    const value = schoolClass[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
