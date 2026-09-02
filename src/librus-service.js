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
    const [calendarIndex, classFree, schoolFree] = await Promise.all([
      client.getCalendars(), client.getClassFreeDays(), client.getSchoolFreeDays(),
    ]);
    const calendarRefs = firstArray(calendarIndex, ["Calendars"]);
    const calendarPayloads = await Promise.all(calendarRefs.map((reference) => (
      this.calendarForReference(client, reference)
    )));
    const calendarEvents = calendarPayloads.flatMap(calendarEventsFromPayload);
    const events = [
      ...calendarEvents,
      ...firstArray(classFree, ["ClassFreeDays"]),
      ...firstArray(schoolFree, ["SchoolFreeDays"]),
    ];
    const rows = filterDated(events, dateFrom, dateTo).slice(0, limit);
    return { student: publicChild(child), date_from: dateFrom, date_to: dateTo, count: rows.length, events: rows };
  }

  async calendarForReference(client, reference) {
    const id = calendarReferenceId(reference);
    if (typeof client.getCalendar === "function") return client.getCalendar(id);
    if (typeof client.getJson !== "function") {
      throw new Error("Klient Librusa nie obsługuje pobierania szczegółów kalendarza.");
    }
    return client.getJson(`/Calendars/${encodeURIComponent(String(id))}`, v.looseObject({}));
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

function calendarEventsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["Calendar", "Calendars", "Events", "Entries"]) {
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
