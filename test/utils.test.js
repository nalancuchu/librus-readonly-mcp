import test from "node:test";
import assert from "node:assert/strict";

import {
  containsAttachmentId,
  findAttachment,
  dateRange,
  filterDated,
  publicChild,
  sanitizeFilename,
  weekStarts,
} from "../src/utils.js";

test("dateRange odrzuca za szeroki zakres", () => {
  assert.throws(() => dateRange("2026-01-01", "2026-03-01", 31));
});

test("weekStarts zwraca tygodnie obejmujące zakres", () => {
  assert.deepEqual(weekStarts("2026-09-01", "2026-09-14"), ["2026-08-31", "2026-09-07", "2026-09-14"]);
});

test("filterDated przepuszcza rekordy bez daty i filtruje rekordy datowane", () => {
  const rows = [{ Date: "2026-09-02" }, { Date: "2026-08-20" }, { Id: 3 }];
  assert.deepEqual(filterDated(rows, "2026-09-01", "2026-09-10"), [rows[0], rows[2]]);
});

test("publicChild usuwa accessToken", () => {
  const result = publicChild(
    { id: 1, login: "abc", studentName: "A", accountIdentifier: "x", group: "g", state: "active", accessToken: "tajne" },
    { Class: { Id: 44, Number: 3, Symbol: "C" } },
  );
  assert.equal("accessToken" in result, false);
  assert.equal(result.class_id, 44);
  assert.equal(result.class_name, "3C");
});

test("sanitizeFilename blokuje traversal", () => {
  assert.equal(sanitizeFilename("../../sekret?.pdf"), "sekret_.pdf");
});

test("containsAttachmentId wymaga kontekstu pliku lub załącznika", () => {
  assert.equal(containsAttachmentId({ Attachments: [{ Id: 42 }] }, 42), true);
  assert.equal(containsAttachmentId({ Message: { Id: 42 } }, 42), false);
});

test("findAttachment zwraca dokładny obiekt załącznika", () => {
  const attachment = { id: "840702", filename: "plan.pdf" };
  assert.equal(findAttachment({ Message: { Id: "840702", attachments: [attachment] } }, "840702"), attachment);
  assert.equal(findAttachment({ Message: { Id: "840702" } }, "840702"), null);
});
