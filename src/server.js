#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { LibrusReadOnlyService } from "./librus-service.js";
import { clampLimit, dateRange, requireObject, requireString } from "./utils.js";

const dateProps = {
  date_from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Początek zakresu, YYYY-MM-DD." },
  date_to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Koniec zakresu, YYYY-MM-DD." },
  limit: { type: "integer", minimum: 1, maximum: 500, description: "Maksymalna liczba rekordów." },
};

const studentProp = {
  student_id: { type: "string", minLength: 1, description: "Id lub login dziecka zwrócony przez list_students." },
};

const tools = [
  tool("list_students", "Lista wszystkich dzieci powiązanych z Kontem LIBRUS, wraz z identyfikatorem i nazwą klasy. Nie zwraca tokenów.", {}),
  tool("get_student_profile", "Profil jednego dziecka wraz z identyfikatorem i nazwą klasy.", studentProp, ["student_id"]),
  tool("get_grades", "Oceny dziecka w podanym zakresie dat.", { ...studentProp, ...dateProps }, ["student_id", "date_from", "date_to"]),
  tool("get_attendance", "Frekwencja dziecka w podanym zakresie dat.", { ...studentProp, ...dateProps }, ["student_id", "date_from", "date_to"]),
  tool("get_timetable", "Plan lekcji dziecka; zakres maksymalnie 31 dni, z zastępstwami zwracanymi przez Librus.", { ...studentProp, date_from: dateProps.date_from, date_to: dateProps.date_to }, ["student_id", "date_from", "date_to"]),
  tool("get_calendar", "Terminarz i dni wolne dziecka w podanym zakresie dat.", {
    ...studentProp, ...dateProps, limit: { ...dateProps.limit, maximum: 100 },
  }, ["student_id", "date_from", "date_to"]),
  tool("get_homework", "Zadania domowe i przypisane prace dziecka.", { ...studentProp, ...dateProps }, ["student_id", "date_from", "date_to"]),
  tool("get_announcements", "Ogłoszenia szkolne (oddzielne od wiadomości).", { ...studentProp, ...dateProps }, ["student_id", "date_from", "date_to"]),
  tool("list_messages", "Lista wiadomości dziecka, wyłącznie odczyt.", {
    ...studentProp,
    page: { type: "integer", minimum: 1, maximum: 1000 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  }, ["student_id"]),
  tool("get_message", "Treść pojedynczej wiadomości, wyłącznie odczyt.", {
    ...studentProp, message_id: { type: ["string", "number"], description: "Id wiadomości." },
  }, ["student_id", "message_id"]),
  tool("download_message_attachment", "Pobiera załącznik należący do wskazanej wiadomości do prywatnego katalogu lokalnego.", {
    ...studentProp,
    message_id: { type: ["string", "number"] },
    attachment_id: { type: ["string", "number"] },
  }, ["student_id", "message_id", "attachment_id"]),
];

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  };
}

export function createServer(service = new LibrusReadOnlyService()) {
  const server = new Server(
    { name: "librus-readonly-mcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: [
        "Prywatny connector LIBRUS tylko do odczytu, obsługujący wiele dzieci.",
        "Najpierw wywołaj list_students. Dla każdego kolejnego wywołania jawnie przekaż student_id właściwego dziecka; nigdy nie mieszaj danych dzieci.",
        "Wiadomości i ogłoszenia są osobnymi źródłami. Do treści wiadomości użyj get_message, a do załącznika download_message_attachment.",
        "Connector nie wysyła wiadomości, nie usprawiedliwia nieobecności i nie zmienia danych.",
        "Daty względne przelicz na YYYY-MM-DD w strefie Europe/Warsaw przed wywołaniem narzędzia.",
      ].join(" "),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await dispatch(service, request.params.name, requireObject(request.params.arguments ?? {}));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = safeError(error);
      process.stderr.write(`[librus-readonly-mcp] ${message}\n`);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }] };
    }
  });
  return server;
}

async function dispatch(service, name, args) {
  switch (name) {
    case "list_students": return service.listStudents();
    case "get_student_profile": return service.getStudentProfile(args.student_id);
    case "get_grades": return service.getGrades(args.student_id, service.parseRange(args));
    case "get_attendance": return service.getAttendance(args.student_id, service.parseRange(args));
    case "get_timetable": {
      const range = dateRange(args.date_from, args.date_to, 31);
      return service.getTimetable(args.student_id, range);
    }
    case "get_calendar": return service.getCalendar(args.student_id, service.parseCalendarRange(args));
    case "get_homework": return service.getHomework(args.student_id, service.parseRange(args));
    case "get_announcements": return service.getAnnouncements(args.student_id, service.parseRange(args));
    case "list_messages": return service.listMessages(args.student_id, {
      page: Number.isInteger(args.page) && args.page >= 1 && args.page <= 1000 ? args.page : 1,
      limit: clampLimit(args.limit, Math.min(service.maxResults, 100), 30),
    });
    case "get_message": return service.getMessage(args.student_id, args.message_id);
    case "download_message_attachment": return service.downloadMessageAttachment(args.student_id, args.message_id, args.attachment_id);
    default: throw new Error(`Nieznane narzędzie: ${name}`);
  }
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/(password|pass|token|cookie)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .slice(0, 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[librus-readonly-mcp] gotowy (stdio, read-only)\n");
}
