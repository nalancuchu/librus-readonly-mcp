# Librus Read-only MCP

Lokalny connector MCP do odczytu danych z Konta LIBRUS. Obsługuje **wiele dzieci
powiązanych z jednym kontem rodzica** i nigdy nie udostępnia narzędzi do
wysyłania, usuwania ani modyfikowania danych.

## Dlaczego `librus-sdk`, a nie stary scraper `librus-api`

Projekt pierwotnie miał bazować bezpośrednio na pakiecie `librus-api`. Ten
pakiet loguje się jednak do jednej sesji Synergii i nie implementuje Multikonta
Konta LIBRUS. Connector używa więc nowszego `librus-sdk`, który wyrósł z tego
samego ekosystemu, ale obsługuje oficjalny przepływ portalu:

1. logowanie do `portal.librus.pl`;
2. odczyt wszystkich pozycji `SynergiaAccounts`;
3. osobny token i osobny klient dla każdego dziecka;
4. odczyt danych JSON z API Librusa zamiast kruchego parsowania HTML.

Każde narzędzie dotyczące danych wymaga `student_id`. Dzięki temu dane dzieci
nie są wybierane na podstawie „ostatnio aktywnego” konta.

## Dostępne narzędzia

- `list_students`
- `get_student_profile`
- `get_grades`
- `get_attendance`
- `get_timetable`
- `get_calendar`
- `get_homework`
- `get_announcements`
- `list_messages`
- `get_message`
- `download_message_attachment`

Wiadomości i ogłoszenia są osobnymi funkcjami. Connector nie zawiera
`send_message`, kasowania wiadomości, usprawiedliwiania ani innych operacji
zapisujących.

## Wymagania

- Node.js 22 lub nowszy;
- Konto LIBRUS rodzica z powiązanymi kontami dzieci;
- klient obsługujący lokalne serwery MCP przez `stdio`.

## Instalacja

```bash
npm install
cp .env.example .env
```

Nie wpisuj danych logowania w plikach konfiguracyjnych przekazywanych innym
osobom ani w repozytorium. Connector sam nie odczytuje `.env`; najbezpieczniej
wstrzyknąć sekrety przez menedżer sekretów klienta MCP albo zmienne środowiska.

Minimalne zmienne:

```text
LIBRUS_PORTAL_EMAIL=rodzic@example.com
LIBRUS_PORTAL_PASSWORD=haslo
```

Test uruchomienia:

```bash
npm test
npm run check
LIBRUS_PORTAL_EMAIL='...' LIBRUS_PORTAL_PASSWORD='...' npm start
```

Ostatnia komenda będzie czekała na protokół MCP na stdin; to prawidłowe.

## Przykładowa konfiguracja klienta MCP

Użyj bezwzględnej ścieżki do `src/server.js`:

```json
{
  "mcpServers": {
    "librus": {
      "command": "node",
      "args": ["/ABSOLUTNA/SCIEZKA/librus-readonly-mcp/src/server.js"],
      "env": {
        "LIBRUS_PORTAL_EMAIL": "rodzic@example.com",
        "LIBRUS_PORTAL_PASSWORD": "UZUPELNIJ_LOKALNIE",
        "LIBRUS_ATTACHMENT_DIR": "/ABSOLUTNA/PRYWATNA/SCIEZKA/librus-attachments"
      }
    }
  }
}
```

Najpierw wywołaj `list_students`, a potem przekazuj zwrócone `id` lub `login`
jako `student_id`.

## Załączniki

`download_message_attachment` wymaga jednocześnie `message_id` i
`attachment_id`. Przed pobraniem connector odczytuje wiadomość i sprawdza, czy
identyfikator załącznika faktycznie w niej występuje. Pliki:

- są zapisywane tylko w `LIBRUS_ATTACHMENT_DIR`;
- otrzymują bezpieczną nazwę bez sekwencji traversal;
- mają limit domyślnie 10 MiB i uprawnienia `0600`;
- nie nadpisują istniejących plików;
- w odpowiedzi zwracają rozmiar, typ MIME i SHA-256.

## Ograniczenia bezpieczeństwa

- brak narzędzi zapisujących;
- tokeny dzieci nigdy nie trafiają do odpowiedzi MCP;
- zakres planu lekcji: maksymalnie 31 dni;
- pozostałe zakresy dat: maksymalnie 62 dni;
- domyślny limit wyników: 100;
- logi trafiają wyłącznie na stderr i są dodatkowo redagowane;
- wersje zależności są przypięte, a `package-lock.json` powstaje przy instalacji.

To nadal nieoficjalna integracja. Librus może zmienić endpointy lub regulamin.
Nie konfiguruj agresywnego odpytywania cyklicznego; używaj jej do prywatnego,
umiarkowanego odczytu własnego konta.
