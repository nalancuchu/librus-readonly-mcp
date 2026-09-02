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
