import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LibrusSession } from "librus-sdk";
import * as v from "valibot";

import {
  clampLimit,
  dateRange,
  filenameFromDisposition,
  findAttachment,
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
    this.attachmentPollAttempts = options.attachmentPollAttempts ?? 10;
    this.attachmentPollDelayMs = options.attachmentPollDelayMs ?? 500;
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
    const attachment = findAttachment(message, safeAttachmentId);
    if (!attachment) {
      throw new Error("Podany załącznik nie należy do wskazanej wiadomości albo Librus nie zwrócił jego identyfikatora.");
    }

    const binary = await this.getMessageAttachment(client, safeMessageId, safeAttachmentId);
    const data = Buffer.isBuffer(binary.data) ? binary.data : Buffer.from(binary.data);
    assertDownloadedAttachment(data, binary.contentType);
    if (data.length > this.maxAttachmentBytes) {
      throw new Error(`Załącznik przekracza limit ${this.maxAttachmentBytes} bajtów.`);
    }
    const original = attachmentFilename(attachment)
      ?? filenameFromDisposition(binary.contentDisposition)
      ?? `zalacznik-${safeAttachmentId}.bin`;
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

  async getMessageAttachment(client, messageId, attachmentId) {
    const backend = client.messageBackend;
    if (!backend || typeof backend.fetchImpl !== "function" || typeof backend.wiadomosciBaseUrl !== "string") {
      return client.getMessageAttachment(attachmentId);
    }

    const endpoint = new URL(
      `/api/attachments/${encodeURIComponent(attachmentId)}/messages/${encodeURIComponent(messageId)}`,
      backend.wiadomosciBaseUrl,
    ).toString();
    const request = async (retryAfterUnauthorized) => {
      if (!backend.authenticated && typeof backend.authenticate === "function") await backend.authenticate();
      const response = await backend.fetchImpl(endpoint, {
        method: "GET",
        headers: {
          accept: "application/octet-stream, */*",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/62.0",
        },
      });
      if (response.status === 401 && retryAfterUnauthorized && typeof backend.authenticate === "function") {
        await response.arrayBuffer();
        backend.authenticated = false;
        await backend.authenticate();
        return request(false);
      }
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error(`Wiadomosci API request failed (HTTP ${response.status}).`);
      }
      const contentType = response.headers.get("content-type");
      if (!isJsonContentType(contentType)) return binaryResponse(response, contentType);

      const downloadUrl = downloadUrlFromJson(await response.arrayBuffer());
      await this.waitForAttachmentReady(backend, downloadUrl);
      const finalUrl = finalAttachmentUrl(downloadUrl);
      const downloadResponse = await followAttachmentRedirects(backend, finalUrl);
      if (downloadResponse.status === 401 && retryAfterUnauthorized && typeof backend.authenticate === "function") {
        await downloadResponse.arrayBuffer();
        backend.authenticated = false;
        await backend.authenticate();
        return request(false);
      }
      if (!downloadResponse.ok) {
        await downloadResponse.arrayBuffer();
        throw new Error(`Pobieranie pliku z Librusa nie powiodło się (HTTP ${downloadResponse.status}).`);
      }
      if (downloadResponse.url) safeLibrusUrl(downloadResponse.url);
      return binaryResponse(downloadResponse, downloadResponse.headers.get("content-type"));
    };
    return request(true);
  }

  async waitForAttachmentReady(backend, downloadUrl) {
    const sourceUrl = safeLibrusUrl(downloadUrl);
    const key = sourceUrl.searchParams.get("singleUseKey");
    if (!key) throw new Error("Odnośnik załącznika nie zawiera klucza jednorazowego.");
    const checkUrl = new URL("https://sandbox.librus.pl/index.php?action=CSCheckKey");
    for (let attempt = 1; attempt <= this.attachmentPollAttempts; attempt += 1) {
      const response = await backend.fetchImpl(checkUrl.toString(), {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/62.0",
        },
        body: new URLSearchParams({ singleUseKey: key }).toString(),
      });
      if (!response.ok) {
        await response.arrayBuffer();
        throw new Error(`Sprawdzenie gotowości pliku w Librusie nie powiodło się (HTTP ${response.status}).`);
      }
      if (attachmentIsReady(await response.arrayBuffer())) return;
      if (attempt < this.attachmentPollAttempts) await wait(this.attachmentPollDelayMs);
    }
    throw new Error("Plik załącznika nie był gotowy w wyznaczonym czasie.");
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

function attachmentFilename(attachment) {
  for (const key of ["filename", "FileName", "name", "Name"]) {
    if (typeof attachment[key] === "string" && attachment[key].trim() !== "") return attachment[key].trim();
  }
  return null;
}

function isJsonContentType(contentType) {
  return typeof contentType === "string" && /(^|\s|;)application\/(?:[^;]+\+)?json(?:\s|;|$)/i.test(contentType);
}

function downloadUrlFromJson(arrayBuffer) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(arrayBuffer).toString("utf8"));
  } catch {
    throw new Error("Librus zwrócił niepoprawną odpowiedź JSON dla załącznika.");
  }
  const rawUrl = payload?.data?.downloadLink;
  if (payload?.data?.status !== "ok" || typeof rawUrl !== "string") {
    throw new Error("Librus nie zwrócił odnośnika do pobrania załącznika.");
  }
  return safeLibrusUrl(rawUrl.replaceAll("&amp;", "&")).toString();
}

function safeLibrusUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new Error("Librus zwrócił niepoprawny odnośnik do pobrania załącznika.");
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password
    || (url.hostname !== "librus.pl" && !url.hostname.endsWith(".librus.pl"))) {
    throw new Error("Librus zwrócił niedozwolony odnośnik do pobrania załącznika.");
  }
  return url;
}

function finalAttachmentUrl(downloadUrl) {
  const url = safeLibrusUrl(downloadUrl);
  if (url.searchParams.get("action") !== "CSTryToDownload") {
    throw new Error("Librus zwrócił nieobsługiwany odnośnik do pobrania załącznika.");
  }
  url.searchParams.set("action", "CSDownload");
  return url.toString();
}

function attachmentIsReady(arrayBuffer) {
  const text = Buffer.from(arrayBuffer).toString("utf8");
  try {
    const payload = JSON.parse(text);
    return payload?.status === "ready" || payload?.data?.status === "ready";
  } catch {
    return /\bready\b/i.test(text);
  }
}

function attachmentRequestOptions() {
  return {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/octet-stream, */*",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/62.0",
    },
  };
}

async function followAttachmentRedirects(backend, initialUrl) {
  let url = safeLibrusUrl(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await backend.fetchImpl(url.toString(), attachmentRequestOptions());
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    await response.arrayBuffer();
    if (!location) throw new Error("Przekierowanie załącznika nie zawiera adresu docelowego.");
    url = safeLibrusUrl(new URL(location, url).toString());
  }
  throw new Error("Librus zwrócił zbyt wiele przekierowań podczas pobierania załącznika.");
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function binaryResponse(response, contentType) {
  return {
    data: await response.arrayBuffer(),
    contentDisposition: response.headers.get("content-disposition"),
    contentType,
  };
}

function assertDownloadedAttachment(data, contentType) {
  if (data.length === 0) throw new Error("Librus zwrócił pusty załącznik.");
  const normalizedType = String(contentType ?? "").toLowerCase();
  const prefix = data.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (isJsonContentType(normalizedType) || normalizedType.includes("text/html")
    || prefix.startsWith("{") || prefix.startsWith("[")
    || prefix.startsWith("<!doctype html") || prefix.startsWith("<html")) {
    throw new Error("Librus nie zwrócił pliku załącznika.");
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
