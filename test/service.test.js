import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LibrusReadOnlyService } from "../src/librus-service.js";

const children = [
  { id: 11, login: "ania", studentName: "Anna", accountIdentifier: "a", group: "1A", state: "active", accessToken: "token-a" },
  { id: 22, login: "jan", studentName: "Jan", accountIdentifier: "b", group: "2B", state: "active", accessToken: "token-b" },
];

function fakeSession(client) {
  return {
    async listChildren() { return children; },
    async resolveChild(selector) {
      const child = children.find((item) => String(item.id) === String(selector) || item.login === selector);
      if (!child) throw new Error("Brak dziecka");
      return child;
    },
    async forChild() { return client; },
    async forChildWiadomosci() { return client; },
  };
}

test("lista wielu dzieci nie ujawnia tokenów", async () => {
  const classes = new Map([[11, { Id: 101, Number: 1, Symbol: "A" }], [22, { Id: 202, Name: "2B" }]]);
  const session = fakeSession({});
  session.forChild = async (child) => ({ async getClass() { return { Class: classes.get(child.id) }; } });
  const service = new LibrusReadOnlyService({ session });
  const result = await service.listStudents();
  assert.equal(result.count, 2);
  assert.deepEqual(result.students.map((item) => item.student_name), ["Anna", "Jan"]);
  assert.deepEqual(result.students.map((item) => item.class_name), ["1A", "2B"]);
  assert.deepEqual(result.students.map((item) => item.class_id), [101, 202]);
  assert.equal(JSON.stringify(result).includes("token-a"), false);
});

test("każde pobranie jest jawnie przypisane do wybranego dziecka", async () => {
  const client = { async getGrades() { return { Grades: [{ Id: 1, AddDate: "2026-09-01" }] }; } };
  const service = new LibrusReadOnlyService({ session: fakeSession(client) });
  const result = await service.getGrades("22", { dateFrom: "2026-09-01", dateTo: "2026-09-02", limit: 10 });
  assert.equal(result.student.id, 22);
  assert.equal(result.count, 1);
});

test("terminarz rozwija odnośniki do kalendarza i nie zwraca ich jako events", async () => {
  const calls = [];
  const client = {
    async getCalendars() {
      return { Calendars: [{ Id: 101, Url: "https://api.librus.pl/2.0/Calendars/101" }] };
    },
    async getJson(endpoint, schema) {
      calls.push(endpoint);
      assert.ok(schema);
      return { Calendar: { Id: 101, Date: "2026-09-08", Description: "Sprawdzian z ułamków" } };
    },
    async getClassFreeDays() { return { ClassFreeDays: [] }; },
    async getSchoolFreeDays() { return { SchoolFreeDays: [] }; },
  };
  const service = new LibrusReadOnlyService({ session: fakeSession(client) });
  const result = await service.getCalendar("11", { dateFrom: "2026-09-01", dateTo: "2026-09-30", limit: 10 });

  assert.deepEqual(calls, ["/Calendars/101"]);
  assert.equal(result.count, 1);
  assert.equal(result.events[0].Description, "Sprawdzian z ułamków");
  assert.equal("Url" in result.events[0], false);
});

test("terminarz filtruje rozwinięte wpisy i dni wolne po dacie, a potem stosuje limit", async () => {
  const client = {
    async getCalendars() { return { Calendars: [{ Id: 1 }, { Id: 2 }, { Id: 3 }] }; },
    async getCalendar(id) {
      const dates = { 1: "2026-08-31", 2: "2026-09-10", 3: "2026-09-20" };
      return { Calendar: { Id: id, Date: dates[id] } };
    },
    async getClassFreeDays() { return { ClassFreeDays: [{ Id: 4, Date: "2026-09-15" }] }; },
    async getSchoolFreeDays() { return { SchoolFreeDays: [{ Id: 5, Date: "2026-10-01" }] }; },
  };
  const service = new LibrusReadOnlyService({ session: fakeSession(client) });
  const result = await service.getCalendar("11", { dateFrom: "2026-09-01", dateTo: "2026-09-30", limit: 2 });

  assert.deepEqual(result.events.map((event) => event.Id), [2, 3]);
  assert.equal(result.count, 2);
});

test("terminarz zwraca pusty wynik, gdy nie ma wpisów ani dni wolnych", async () => {
  const client = {
    async getCalendars() { return { Calendars: [] }; },
    async getClassFreeDays() { return { ClassFreeDays: [] }; },
    async getSchoolFreeDays() { return { SchoolFreeDays: [] }; },
  };
  const service = new LibrusReadOnlyService({ session: fakeSession(client) });
  const result = await service.getCalendar("11", { dateFrom: "2026-09-01", dateTo: "2026-09-30", limit: 10 });

  assert.deepEqual(result.events, []);
  assert.equal(result.count, 0);
});

test("błąd API podczas rozwijania kalendarza nie jest maskowany", async () => {
  const client = {
    async getCalendars() { return { Calendars: [{ Id: 101 }] }; },
    async getCalendar() { throw new Error("Synergia API request failed"); },
    async getClassFreeDays() { return { ClassFreeDays: [] }; },
    async getSchoolFreeDays() { return { SchoolFreeDays: [] }; },
  };
  const service = new LibrusReadOnlyService({ session: fakeSession(client) });

  await assert.rejects(
    service.getCalendar("11", { dateFrom: "2026-09-01", dateTo: "2026-09-30", limit: 10 }),
    /Synergia API request failed/,
  );
});

test("terminarze wielu dzieci używają osobnych klientów i zachowują student_id", async () => {
  const session = fakeSession(null);
  session.forChild = async (child) => ({
    async getCalendars() { return { Calendars: [{ Id: child.id * 10 }] }; },
    async getCalendar() { return { Calendar: { Id: child.id * 10, Date: "2026-09-12" } }; },
    async getClassFreeDays() { return { ClassFreeDays: [] }; },
    async getSchoolFreeDays() { return { SchoolFreeDays: [] }; },
  });
  const service = new LibrusReadOnlyService({ session });
  const range = { dateFrom: "2026-09-01", dateTo: "2026-09-30", limit: 10 };
  const [anna, jan] = await Promise.all([
    service.getCalendar("11", range),
    service.getCalendar("22", range),
  ]);

  assert.equal(anna.student.id, 11);
  assert.deepEqual(anna.events.map((event) => event.Id), [110]);
  assert.equal(jan.student.id, 22);
  assert.deepEqual(jan.events.map((event) => event.Id), [220]);
});

test("załącznik jest weryfikowany względem wiadomości i zapisywany prywatnie", async () => {
  const attachmentDir = await mkdtemp(path.join(os.tmpdir(), "librus-attachment-test-"));
  const client = {
    async getMessage() { return { Message: { Id: 8, Attachments: [{ Id: 9 }] } }; },
    async getMessageAttachment() {
      return { data: Buffer.from("test"), contentType: "text/plain", contentDisposition: 'attachment; filename="kartka.txt"' };
    },
  };
  const service = new LibrusReadOnlyService({ session: fakeSession(client), attachmentDir });
  const result = await service.downloadMessageAttachment("ania", 8, 9);
  assert.equal(result.size_bytes, 4);
  assert.equal(await readFile(path.join(attachmentDir, result.filename), "utf8"), "test");
  assert.equal(result.filename.includes(".."), false);
});
