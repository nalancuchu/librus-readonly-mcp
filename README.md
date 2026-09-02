# Librus Read-only MCP

Connector MCP do odczytu danych z Konta LIBRUS, działający lokalnie przez
`stdio` albo zdalnie przez Streamable HTTP. Obsługuje **wiele dzieci
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

## Wersja zdalna

Zdalny serwer korzysta ze standardowego transportu Streamable HTTP na ścieżce
`/mcp`. Endpoint `/health` służy wyłącznie do kontroli dostępności i nie łączy
się z Librusem.

Wymagane sekrety środowiskowe:

```text
LIBRUS_PORTAL_EMAIL=rodzic@example.com
LIBRUS_PORTAL_PASSWORD=haslo-do-konta-librus
MCP_ACCESS_TOKEN=co-najmniej-32-znakowy-losowy-sekret
```

Uruchomienie bez Dockera:

```bash
npm ci
npm run start:http
```

Uruchomienie kontenera:

```bash
docker build -t librus-readonly-mcp .
docker run --rm -p 3000:3000 \
  -e LIBRUS_PORTAL_EMAIL \
  -e LIBRUS_PORTAL_PASSWORD \
  -e MCP_ACCESS_TOKEN \
  librus-readonly-mcp
```

Adres MCP po wdrożeniu to `https://TWOJA-DOMENA/mcp`. W kliencie należy
przekazywać `MCP_ACCESS_TOKEN` jako nagłówek:

```text
Authorization: Bearer <MCP_ACCESS_TOKEN>
```

Serwer odmawia uruchomienia, jeśli token ma mniej niż 32 znaki. Tryb
`ALLOW_INSECURE_HTTP=true` służy wyłącznie do lokalnych testów i nie może być
używany w publicznym wdrożeniu.

Wersja zdalna nie zapisuje załączników na dysku serwera. Zwraca je zakodowane
Base64 wraz z nazwą, typem MIME, rozmiarem i SHA-256. Domyślny limit wynosi
10 MiB i można go obniżyć przez `LIBRUS_MAX_ATTACHMENT_BYTES`.

### Ważne ograniczenie uwierzytelniania

Bearer token chroni prywatny, jednoosobowy serwer i działa z klientami MCP,
które pozwalają skonfigurować własny nagłówek. Jeżeli konkretny host wymaga
pełnego OAuth 2.1 zamiast statycznego nagłówka, postaw przed serwerem bramę
OAuth/reverse proxy. Nie publikuj endpointu `/mcp` bez uwierzytelniania.

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
- zdalny endpoint wymaga stałoczasowo porównywanego Bearer tokenu i ma limit
  żądań;
- obraz Dockera działa jako nieuprzywilejowany użytkownik.

To nadal nieoficjalna integracja. Librus może zmienić endpointy lub regulamin.
Nie konfiguruj agresywnego odpytywania cyklicznego; używaj jej do prywatnego,
umiarkowanego odczytu własnego konta.
