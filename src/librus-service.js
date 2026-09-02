import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LibrusSession } from "librus-sdk";
import * as v from "valibot";

import {
  clampLimit,
  containsAttachmentId,
  dateRange,
  filenameFromDisposition,
  filterDated,
  firstArray,
  mondayOf,
  publicChild,
  requireString,
  sanitizeFilename,
  weekStarts,
} from "./utils.js";

export class LibrusReadOnlyService {
  constructor(options = {}) {
    this.maxResults = options.maxResults ?? readPositiveInt("LIBRUS_MAX_RESULTS", 100, 1, 500);
    this.maxAttachmentBytes = options.maxAttachmentBytes ?? readPositiveInt(
      "LIBRUS_MAX_ATTACHMENT_BYTES", 10 * 1024 * 1024, 1024, 25 * 1024 * 1024,
    );
    this.attachmentDir = path.resolve(options.attachmentDir ?? process.env.LIBRUS_ATTACHMENT_DIR ?? "attachments");
    this.attachmentMode = options.attachmentMode ?? process.env.LIBRUS_ATTACHMENT_MODE ?? "file";
    if (!["file", "inline"].includes(this.attachmentMode)) {
      throw new Error('LIBRUS_ATTACHMENT_MODE musi mieć wartość "file" albo "inline".');
    }
    this.session = options.session ?? LibrusSession.fromEnv(process.env);
  }

  async listStudents() {
    const children = await this.session.listChildren();
    const students = await Promise.all(children.map(async (child) => {
      const classPayload = await this.classForChild(child);
      return publicChild(child, classPayload);
    }));
    return { students, count: students.length };
  }

  async classForChild(child, existingClient = null) {
    try {
      const client = existingClient ?? await this.session.forChild(child);
      if (typeof client.getClass !== "function") return null;
      return await client.getClass();
    } catch {
      // Brak metadanych klasy nie może zablokować pozostałych danych dziecka.
      return null;
    }
  }

  async resolveStudent(studentId) {
    const selector = requireString(studentId, "student_id", 200);
    const child = await this.session.resolveChild(selector);
    return child;
  }

  async clientFor(studentId, messages = false) {
    const child = await this.resolveStudent(studentId);
    const client = messages
      ? await this.session.forChildWiadomosci(child)
      : await this.session.forChild(child);
    return { child, client };
  }

  async getStudentProfile(studentId) {
    const { child, client } = await this.clientFor(studentId);
    const [profile, classPayload] = await Promise.all([
      client.getMe(),
      this.classForChild(child, client),
    ]);
    return { student: publicChild(child, classPayload), profile };
  }

  async getGrades(studentId, { dateFrom, dateTo, limit }) {
    const { child, client } = await this.clientFor(studentId);
    const payload = await client.getGrades();
    const rows = filterDated(firstArray(payload, ["Grades"]), dateFrom, dateTo).slice(0, limit);
    return { student: publicChild(child), date_from: dateFrom, date_to: dateTo, count: rows.length, grades: rows };
  }

  async getAttendance(studentId, { dateFrom, dateTo, limit }) {
    const { child, client } = await this.clientFor(studentId);
    const payload = await client.getAttendances();
    const rows = filterDated(firstArray(payload, ["Attendances"]), dateFrom, dateTo).slice(0, limit);
    return { student: publicChild(child), date_from: dateFrom, date_to: dateTo, count: rows.length, attendance: rows };
  }

  async getTimetable(studentId, { dateFrom, dateTo }) {
    const { child, client } = await this.clientFor(studentId);
    const weeks = [];
    for (const weekStart of weekStarts(dateFrom, dateTo)) {
      weeks.push({ week_start: weekStart, data: await client.getTimetableWeek(weekStart) });
    }
    return { student: publicChild(child), date_from: dateFrom, date_to: dateTo, weeks };
  }

  async getCalendar(studentId, { dateFrom, dateTo, limit }) {
    const { child, client } = await this.clientFor(studentId);
    const [calendarIndex, classPayload, ...collectionResults] = await Promise.all([
      client.getCalendars(),
      this.classForChild(child, client),
      settleCollection("class_free_day", "ClassFreeDays", () => client.getClassFreeDays()),
      settleCollection("school_free_day", "SchoolFreeDays", () => client.getSchoolFreeDays()),
      settleCollection("teacher_free_day", "TeacherFreeDays", () => client.getTeacherFreeDays?.()),
      settleCollection("parent_teacher_conference", "ParentTeacherConferences", () => client.listParentTeacherConferences?.()),
    ]);
    const rootRefs = firstArray(calendarIndex, ["Calendars"]).map((reference) => ({ source: "calendar", reference }));
    const errors = collectionResults.flatMap((result) => result.errors);
    const firstLevel = await this.resolveCalendarReferences(client, uniqueCalendarReferences(rootRefs));
    errors.push(...firstLevel.errors);
    const nestedRefs = firstLevel.payloads.flatMap(({ payload }) => calendarReferencesFromPayload(payload));
    const nestedKeys = new Set(nestedRefs.map(calendarReferenceKey));
    const supplementalRefs = collectionResults.flatMap((result) => result.references)
      .filter((entry) => !nestedKeys.has(calendarReferenceKey(entry)));
    const leafPayloads = firstLevel.payloads.filter(({ payload }) => !hasCalendarReferences(payload));
    const secondLevel = await this.resolveCalendarReferences(
      client, uniqueCalendarReferences([...nestedRefs, ...supplementalRefs]),
    );
    errors.push(...secondLevel.errors);
    const events = [...leafPayloads, ...secondLevel.payloads]
      .flatMap(({ source, payload }) => calendarEventsFromPayload(payload).map((event) => ({ source, ...event })));
    const rows = filterDated(events, dateFrom, dateTo).slice(0, limit);
    return {
      student: publicChild(child, classPayload), date_from: dateFrom, date_to: dateTo,
      count: rows.length, events: rows, ...(errors.length > 0 ? { partial_errors: errors } : {}),
    };
  }

  async resolveCalendarReferences(client, entries) {
    const results = await Promise.allSettled(entries.map(async ({ source, reference }) => ({
      source, reference, payload: await this.calendarForReference(client, reference, source),
    })));
    const payloads = [];
    const errors = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") payloads.push(result.value);
      else errors.push(calendarReferenceError(entries[index]));
    });
    return { payloads, errors };
  }

  async calendarForReference(client, reference, source = "calendar") {
    const id = calendarReferenceId(reference);
    if (source === "calendar" && typeof client.getCalendar === "function") return client.getCalendar(id);
    if (typeof client.getJson !== "function") {
      throw new Error("Klient Librusa nie obsługuje pobierania szczegółów kalendarza.");
    }
    return client.getJson(calendarReferenceEndpoint(client, reference, source, id), v.looseObject({}));
  }

  async getHomework(studentId, { dateFrom, dateTo, limit }) {
    const { child, client } = await this.clientFor(studentId);
    const [homeworks, assignments] = await Promise.all([
      client.getHomeWorks(), client.getHomeworkAssignments(),
    ]);
    const rows = [
      ...firstArray(homeworks, ["HomeWorks"]).map((item) => ({ source: "homework", ...item })),
      ...firstArray(assignments, ["HomeWorkAssignments", "HomeworkAssignments"]).map((item) => ({ source: "assignment", ...item })),
    ];
    const filtered = filterDated(rows, dateFrom, dateTo).slice(0, limit);
    return { student: publicChild(child), date_from: dateFrom, date_to: dateTo, count: filtered.length, homework: filtered };
  }

  async getAnnouncements(studentId, { dateFrom, dateTo, limit }) {
    const { child, client } = await this.clientFor(studentId);
    const payload = await client.listSchoolNotices();
    const rows = filterDated(firstArray(payload, ["SchoolNotices"]), dateFrom, dateTo).slice(0, limit);
    return { student: publicChild(child), date_from: dateFrom, date_to: dateTo, count: rows.length, announcements: rows };
  }

  async listMessages(studentId, { page, limit }) {
    const { child, client } = await this.clientFor(studentId, true);
    const payload = await client.listMessages({ page, limit });
    const rows = firstArray(payload, ["Messages"]).slice(0, limit);
    return { student: publicChild(child), page, count: rows.length, messages: rows };
  }

  async getMessage(studentId, messageId) {
    const { child, client } = await this.clientFor(studentId, true);
    return { student: publicChild(child), message: await client.getMessage(requireString(String(messageId), "message_id", 100)) };
  }

  async downloadMessageAttachment(studentId, messageId, attachmentId) {
    const { child, client } = await this.clientFor(studentId, true);
    const safeMessageId = requireString(String(messageId), "message_id", 100);
    const safeAttachmentId = requireString(String(attachmentId), "attachment_id", 100);
    const message = await client.getMessage(safeMessageId);
    if (!containsAttachmentId(message, safeAttachmentId)) {
      throw new Error("Podany załącznik nie należy do wskazanej wiadomości albo Librus nie zwrócił jego identyfikatora.");
    }

    const binary = await client.getMessageAttachment(safeAttachmentId);
    const data = Buffer.isBuffer(binary.data) ? binary.data : Buffer.from(binary.data);
    if (data.length > this.maxAttachmentBytes) {
      throw new Error(`Załącznik przekracza limit ${this.maxAttachmentBytes} bajtów.`);
    }
    const original = filenameFromDisposition(binary.contentDisposition) ?? `zalacznik-${safeAttachmentId}.bin`;
    const fileName = `${sanitizeFilename(String(child.id))}-${sanitizeFilename(safeMessageId)}-${sanitizeFilename(original)}`;
    const sha256 = createHash("sha256").update(data).digest("hex");
    const metadata = {
      student: publicChild(child), message_id: safeMessageId, attachment_id: safeAttachmentId,
      filename: fileName, size_bytes: data.length,
      content_type: binary.contentType ?? "application/octet-stream", sha256,
    };
    if (this.attachmentMode === "inline") {
      return { ...metadata, encoding: "base64", data: data.toString("base64") };
    }

    await mkdir(this.attachmentDir, { recursive: true, mode: 0o700 });
    let storedFileName = fileName;
    const outputPath = path.join(this.attachmentDir, storedFileName);
    await writeFile(outputPath, data, { mode: 0o600, flag: "wx" }).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      const digest = createHash("sha256").update(data).digest("hex").slice(0, 12);
      storedFileName = `${digest}-${fileName}`;
      await writeFile(path.join(this.attachmentDir, storedFileName), data, { mode: 0o600, flag: "wx" });
    });
    return {
      ...metadata, filename: storedFileName, directory: this.attachmentDir,
    };
  }

  parseRange(args, maxDays = 62) {
    const { dateFrom, dateTo } = dateRange(args.date_from, args.date_to, maxDays);
    return { dateFrom, dateTo, limit: clampLimit(args.limit, this.maxResults) };
  }

  parseCalendarRange(args) {
    const { dateFrom, dateTo } = dateRange(args.date_from, args.date_to, 62);
    return { dateFrom, dateTo, limit: clampLimit(args.limit, Math.min(this.maxResults, 100)) };
  }
}

const CALENDAR_COLLECTIONS = {
  HomeWorks: "homework", SchoolFreeDays: "school_free_day", ClassFreeDays: "class_free_day",
  TeacherFreeDays: "teacher_free_day", Substitutions: "substitution",
  ParentTeacherConferences: "parent_teacher_conference",
};

const SOURCE_PATHS = {
  calendar: "/Calendars", homework: "/HomeWorks", school_free_day: "/Calendars/SchoolFreeDays",
  class_free_day: "/Calendars/ClassFreeDays", teacher_free_day: "/Calendars/TeacherFreeDays",
  substitution: "/Calendars/Substitutions", parent_teacher_conference: "/ParentTeacherConferences",
};

function settleCollection(source, key, load) {
  return Promise.resolve().then(load).then(
    (payload) => ({ references: firstArray(payload, [key]).map((reference) => ({ source, reference })), errors: [] }),
    () => ({ references: [], errors: [{ source, error: "Nie udało się pobrać kolekcji z Librusa." }] }),
  );
}

function calendarReferencesFromPayload(payload) {
  const containers = [payload, payload?.Calendar].filter((value) => value && typeof value === "object");
  return containers.flatMap((container) => Object.entries(CALENDAR_COLLECTIONS).flatMap(([key, source]) => (
    Array.isArray(container[key]) ? container[key].map((reference) => ({ source, reference })) : []
  )));
}

function hasCalendarReferences(payload) {
  return calendarReferencesFromPayload(payload).length > 0;
}

function uniqueCalendarReferences(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = calendarReferenceKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function calendarReferenceKey({ source, reference }) {
  return `${source}:${reference?.Id ?? reference?.id ?? reference?.Url ?? "missing"}`;
}

function calendarReferenceId(reference) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("Librus zwrócił niepoprawny odnośnik do kalendarza.");
  }
  const id = reference.Id ?? reference.id;
  if ((typeof id !== "string" && typeof id !== "number") || String(id).trim() === "") {
    throw new Error("Odnośnik do kalendarza zwrócony przez Librusa nie zawiera identyfikatora.");
  }
  return id;
}

function calendarReferenceEndpoint(client, reference, source, id) {
  if (typeof reference.Url === "string" && typeof client.apiBaseUrl === "string") {
    try {
      const url = new URL(reference.Url);
      const apiUrl = new URL(client.apiBaseUrl);
      if (url.origin === apiUrl.origin && /^\/\d+\.\d+\//.test(url.pathname)) return url.toString();
    } catch { /* użyj bezpiecznie zbudowanej ścieżki */ }
  }
  const basePath = SOURCE_PATHS[source];
  if (!basePath) throw new Error("Nieznany typ odnośnika terminarza.");
  return `${basePath}/${encodeURIComponent(String(id))}`;
}

function calendarReferenceError({ source, reference }) {
  let id = null;
  try { id = calendarReferenceId(reference); } catch { /* identyfikator pozostaje pusty */ }
  return { source, id, error: "Nie udało się pobrać szczegółów wpisu z Librusa." };
}

function calendarEventsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of [
    "Calendar", "Calendars", "Event", "Events", "Entry", "Entries", "HomeWork",
    "SchoolFreeDay", "ClassFreeDay", "TeacherFreeDay", "Substitution", "ParentTeacherConference",
  ]) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === "object") return [payload[key]];
  }
  return [];
}

function readPositiveInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} musi być liczbą całkowitą od ${min} do ${max}.`);
  }
  return value;
}
