import assert from "node:assert/strict";
import test from "node:test";
import { Client, APIErrorCode, APIResponseError } from "@notionhq/client";
import * as notionSDK from "@notionhq/client";
import { createLoader } from "./load-module.mjs";

function setup({
  secret,
  storedToken,
  authorizeError,
  initializeClient = true,
  respond = () => ({ object: "user", id: "bot" }),
} = {}) {
  const requests = [];
  const toasts = [];
  const events = [];
  const storage = {};
  let tokens = storedToken ? { accessToken: storedToken } : undefined;
  const api = {
    getPreferenceValues: () => ({ notion_token: secret }),
    OAuth: {
      RedirectMethod: { Web: "web" },
      PKCEClient: class {
        async getTokens() {
          return tokens;
        }
        async removeTokens() {
          events.push("remove");
          tokens = undefined;
        }
        async setTokens(options) {
          events.push("restore");
          tokens = { ...options, updatedAt: new Date() };
        }
      },
    },
    Toast: { Style: { Failure: "failure", Success: "success", Animated: "animated" } },
    LocalStorage: {
      getItem: async (key) => storage[key],
      setItem: async (key, value) => {
        storage[key] = value;
      },
      removeItem: async (key) => {
        delete storage[key];
      },
    },
    showToast: async (toast) => {
      toasts.push(toast);
    },
    openExtensionPreferences: async () => {
      events.push("preferences");
    },
    launchCommand: async (options) => {
      events.push(options);
    },
    LaunchType: { UserInitiated: "user" },
    Color: {},
    Icon: {},
  };
  const load = createLoader({
    "@raycast/api": api,
    "@raycast/utils": {
      withAccessToken: () => (fn) => fn,
      OAuthService: class {
        constructor(options) {
          Object.assign(this, options);
        }
        async authorize() {
          events.push("authorize");
          if (authorizeError) throw authorizeError;
          tokens = { accessToken: "fresh-token" };
          return "fresh-token";
        }
      },
    },
    "@notionhq/client": {
      ...notionSDK,
      Client: class extends Client {
        constructor(options) {
          super({
            ...options,
            maxRetries: 0,
            logger: () => {},
            fetch: async (url, init) => {
              const request = {
                url: String(url),
                body: init.body ? JSON.parse(init.body) : undefined,
                headers: init.headers,
              };
              requests.push(request);
              const response = await respond(request);
              return new Response(JSON.stringify(response.body ?? response), { status: response.status ?? 200 });
            },
          });
        }
      },
    },
  });
  const oauth = load("src/utils/notion/oauth.ts");
  if (initializeClient) oauth.notionService.onAuthorize({ token: storedToken || "test-token" });
  return { load, oauth, requests, toasts, events };
}

const richText = (...parts) => parts.map((plain_text) => ({ type: "text", plain_text, text: { content: plain_text } }));
const notionPage = (id, ...title) => ({
  object: "page",
  id,
  properties: { Name: { id: "title", type: "title", title: richText(...title) } },
});
const dataSource = (id, ...title) => ({
  object: "data_source",
  id,
  title: richText(...title),
  last_edited_time: "2026-09-25T00:00:00Z",
  icon: null,
});
const list = (results, next_cursor = null) => ({ object: "list", results, next_cursor, has_more: !!next_cursor });

test("formatted links retain a Markdown fallback and a rich HTML link", () => {
  const { formatPageLink } = createLoader()("src/utils/formatPageLink.ts");
  assert.deepEqual(formatPageLink("Meeting notes", "https://notion.so/page"), {
    text: "[Meeting notes](https://notion.so/page)",
    html: '<a href="https://notion.so/page">Meeting notes</a>',
  });
  const link = formatPageLink('A [draft] & "B" <C>', "https://notion.so/page(a)?x=1&y=2");
  assert.equal(link.text, '[A \\[draft\\] & "B" \\<C\\>](https://notion.so/page%28a%29?x=1&y=2)');
  assert.equal(
    link.html,
    '<a href="https://notion.so/page(a)?x=1&amp;y=2">A [draft] &amp; &quot;B&quot; &lt;C&gt;</a>',
  );
});

test("page and database titles retain all rich-text segments, including after an empty first segment", () => {
  const { load } = setup();
  const { pageMapper } = load("src/utils/notion/global.ts");
  assert.equal(pageMapper(notionPage("page", "", "Marketing ", "meeting notes")).title, "Marketing meeting notes");
  assert.equal(pageMapper(dataSource("source", "Marketing ", "meetings")).title, "Marketing meetings");
  assert.equal(pageMapper(notionPage("empty")).title, "Untitled");
});

test("server search matches survive stale pinned titles and duplicate recent entries", () => {
  const { getSearchSections } = createLoader()("src/utils/searchSections.ts");
  const current = { id: "1", title: "Current meeting" };
  const sections = getSearchSections(
    "meeting",
    [current, { id: "2", title: "Other meeting" }],
    [{ id: "1", title: "Old title" }],
    [{ id: "2", title: "Other meeting" }],
  );
  assert.deepEqual(
    sections.map((section) => section.pages.map((page) => page.id)),
    [[], ["2"], ["1"]],
  );
  const empty = getSearchSections("", [current], [current], [current]);
  assert.deepEqual(
    empty.map((section) => section.pages.length),
    [1, 0, 0],
  );
});

test("search preserves the server cursor and complete title for UI and AI callers", async () => {
  const { load, requests } = setup({ respond: () => list([notionPage("1", "Meeting ", "notes")], "next") });
  const { search } = load("src/utils/notion/page/index.ts");
  const result = await search("notes", "previous", 25);
  assert.equal(result.pages[0].title, "Meeting notes");
  assert.equal(result.nextCursor, "next");
  assert.equal(result.hasMore, true);
  assert.equal(requests[0].body.query, "notes");
  assert.equal(requests[0].body.start_cursor, "previous");
});

test("page pickers follow cursors through empty intermediate pages", async () => {
  const { load, requests } = setup({
    respond: ({ body }) => {
      if (!body.start_cursor) return list([notionPage("1", "First")], "empty");
      if (body.start_cursor === "empty") return list([], "last");
      return list([notionPage("2", "Last")]);
    },
  });
  const result = await load("src/utils/notion/page/index.ts").searchAllPages("title");
  assert.deepEqual(
    result.pages.map((page) => page.id),
    ["1", "2"],
  );
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.body.query === "title"));
});

test("database selection includes sources beyond the first response", async () => {
  const { load, requests } = setup({
    respond: ({ body }) =>
      body.start_cursor ? list([dataSource("2", "Second ", "database")]) : list([dataSource("1", "First")], "next"),
  });
  const databases = await load("src/utils/notion/database/index.ts").fetchDatabases();
  assert.deepEqual(
    databases.map((database) => database.title),
    ["First", "Second database"],
  );
  assert.equal(requests[1].body.start_cursor, "next");
  assert.ok(requests.every((request) => request.body.filter.value === "data_source"));
});

test("database queries include later records and preserve filters and sorting", async () => {
  const { load, requests } = setup({
    respond: ({ url, body }) => {
      if (!url.endsWith("/query")) return dataSource("source", "Database");
      return body.start_cursor
        ? list([notionPage("21", "Last")])
        : list(
            Array.from({ length: 20 }, (_, i) => notionPage(String(i), "First")),
            "next",
          );
    },
  });
  const pages = await load("src/utils/notion/database/index.ts").queryDatabase("source", "notes", "created_time");
  assert.equal(pages.length, 21);
  assert.equal(pages.at(-1).id, "21");
  const queries = requests.filter((request) => request.url.endsWith("/query"));
  assert.equal(queries[1].body.start_cursor, "next");
  assert.deepEqual(queries[1].body.filter, queries[0].body.filter);
  assert.deepEqual(queries[1].body.sorts, [{ direction: "descending", timestamp: "created_time" }]);
});

test("empty or whitespace-only secrets allow OAuth instead of becoming empty AI tokens", () => {
  for (const secret of [undefined, "", "   "])
    assert.equal(setup({ secret }).oauth.notionService.personalAccessToken, undefined);
  assert.equal(setup({ secret: "  ntn_secret \n" }).oauth.notionService.personalAccessToken, "ntn_secret");
});

test("testing a missing connection does not trigger sign-in", async () => {
  const { oauth, events, requests } = setup();
  assert.equal(await oauth.checkNotionConnection(), false);
  assert.deepEqual(events, []);
  assert.equal(requests.length, 0);
});

test("connection checks validate the configured secret before any saved OAuth token", async () => {
  const { oauth, requests } = setup({ secret: "ntn_secret", storedToken: "old-token" });
  assert.equal(await oauth.checkNotionConnection(), true);
  assert.equal(new Headers(requests[0].headers).get("authorization"), "Bearer ntn_secret");
});

test("reconnect clears revoked OAuth credentials and validates the new connection", async () => {
  const { oauth, events, requests } = setup({ storedToken: "revoked-token" });
  await oauth.reconnectNotion();
  assert.deepEqual(events, ["remove", "authorize"]);
  assert.ok(requests[0].url.endsWith("/users/me"));
  assert.equal(new Headers(requests[0].headers).get("authorization"), "Bearer fresh-token");
  assert.ok(oauth.getNotionClient());
});

test("reconnect does not silently ignore an internal integration secret", async () => {
  const { oauth, events } = setup({ secret: "ntn_secret", storedToken: "old-token" });
  await assert.rejects(oauth.reconnectNotion(), /Clear the Internal Integration Secret/);
  assert.deepEqual(events, []);
});

test("invalid new credentials fail verification rather than reporting successful reconnect", async () => {
  const { oauth } = setup({
    initializeClient: false,
    respond: () => ({ status: 401, body: { object: "error", code: "unauthorized", message: "API token is invalid." } }),
  });
  await assert.rejects(oauth.reconnectNotion(), /API token is invalid/);
  assert.throws(() => oauth.getNotionClient(), /No Notion client/);
  assert.equal(await oauth.checkNotionConnection(), false);
});

test("cancelled or failed authorization restores the saved credentials and active client", async () => {
  for (const message of ["Sign-in cancelled", "Token exchange failed"]) {
    const authorizeError = new Error(message);
    const { oauth, events, requests } = setup({ storedToken: "old-token", authorizeError });
    const previousClient = oauth.getNotionClient();
    await oauth.notionService.client.setTokens({
      accessToken: "old-token",
      refreshToken: "old-refresh-token",
      idToken: "old-id-token",
      scope: "old-scope",
      expiresIn: 3600,
    });
    events.length = 0;
    await assert.rejects(oauth.reconnectNotion(), (error) => error === authorizeError);
    assert.deepEqual(events, ["remove", "authorize", "restore"]);
    const restored = await oauth.notionService.client.getTokens();
    assert.equal(restored.accessToken, "old-token");
    assert.equal(restored.refreshToken, "old-refresh-token");
    assert.equal(restored.idToken, "old-id-token");
    assert.equal(restored.scope, "old-scope");
    assert.ok(restored.expiresIn > 0 && restored.expiresIn <= 3600);
    assert.equal(oauth.getNotionClient(), previousClient);
    assert.equal(await oauth.checkNotionConnection(), true);
    await oauth.getNotionClient().users.me({});
    assert.ok(requests.every((request) => new Headers(request.headers).get("authorization") === "Bearer old-token"));
  }
});

test("failed verification restores the previous connection after new credentials have been saved", async () => {
  for (const failure of ["invalid-token", "network-error"]) {
    let oauth;
    let previousClient;
    const context = setup({
      storedToken: "old-token",
      respond: (request) => {
        if (new Headers(request.headers).get("authorization") === "Bearer fresh-token") {
          assert.equal(oauth.getNotionClient(), previousClient);
          if (failure === "network-error") throw new Error("Network unavailable");
          return { status: 401, body: { object: "error", code: "unauthorized", message: "API token is invalid." } };
        }
        return { object: "user", id: "bot" };
      },
    });
    oauth = context.oauth;
    previousClient = oauth.getNotionClient();
    await assert.rejects(oauth.reconnectNotion(), /API token is invalid|Network unavailable/);
    assert.equal(oauth.getNotionClient(), previousClient);
    assert.equal(await oauth.checkNotionConnection(), true);
    await oauth.getNotionClient().users.me({});
  }
});

test("revoked access offers OAuth recovery or secret preferences, and network failures preserve credentials", async () => {
  const error = new APIResponseError({
    code: APIErrorCode.Unauthorized,
    message: "API token is invalid.",
    status: 401,
    headers: new Headers(),
    rawBodyText: "",
  });
  for (const secret of [undefined, "ntn_secret"]) {
    const { load, toasts, events } = setup({ secret });
    const { showNotionError } = load("src/utils/notion/errors.ts");
    await showNotionError(error, "Search failed");
    await toasts[0].primaryAction.onAction();
    assert.deepEqual(events, secret ? ["preferences"] : [{ name: "manage-connection", type: "user" }]);
    await showNotionError(new Error("Network unavailable"), "Search failed");
    assert.equal(toasts[1].message, "Network unavailable");
    assert.equal(toasts[1].primaryAction, undefined);
    assert.equal(events.length, 1);
  }
});

test("AI search follows pagination and returns complete titles in cloneable results", async () => {
  const { load } = setup({
    respond: ({ body }) =>
      body.start_cursor
        ? list([notionPage("2", "Second ", "meeting")])
        : list([notionPage("1", "First ", "meeting")], "next"),
  });
  const results = await load("src/tools/search-pages.ts").default({ searchText: "meeting" });
  assert.deepEqual(
    results.map((page) => page.title),
    ["First meeting", "Second meeting"],
  );
  assert.deepEqual(structuredClone(results), results);
});

test("Add Text to Page does not close or report success after a rejected append", async () => {
  let submit;
  let closed = false;
  const toasts = [];
  const jsx = (type, props) => ({ type, props });
  const load = createLoader({
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (initial) => [initial, () => {}] },
    "@raycast/api": {
      Action: { SubmitForm: "submit" },
      ActionPanel: "actions",
      Form: { Dropdown: { Item: "item" } },
      Icon: {},
      Toast: { Style: { Success: "success", Animated: "animated", Failure: "failure" } },
      showToast: async (toast) => {
        toasts.push(toast);
      },
      closeMainWindow: async () => {
        closed = true;
      },
    },
    "@raycast/utils": {
      withAccessToken: () => (fn) => fn,
      FormValidation: { Required: "required" },
      useForm: ({ onSubmit }) => {
        submit = onSubmit;
        return { itemProps: {} };
      },
    },
    "./hooks": { useSearchPages: () => ({ data: { pages: [{ id: "page", object: "page", title: "Page" }] } }) },
    "./utils/notion": { appendBlockToPage: async () => undefined, getPageIcon: () => "page" },
    "./utils/notion/oauth": { notionService: {} },
  });
  load("src/add-text-to-page.tsx").default({ arguments: {} });
  await submit({ page: "page", textToAppend: "Note", prepend: false, addDateDivider: false });
  assert.equal(closed, false);
  assert.ok(!toasts.some((toast) => toast.style === "success"));
});

const dailyNoteDate = new Date(2026, 9, 8);

test("daily note lookup appends to today's page matched by title", async () => {
  const { load, requests } = setup({
    respond: ({ url, body }) => {
      if (url.includes("/search")) return list([dataSource("source", "Daily Notes")]);
      if (url.endsWith("/query")) return list([notionPage("today", "Oct 8, ", "2026")]);
      return { object: "user", id: "bot" };
    },
  });
  const { findTodaysDailyNote, getDateTitle } = load("src/utils/notion/dailyNote.ts");
  const dateTitle = getDateTitle("MMM d, yyyy", dailyNoteDate);
  const result = await findTodaysDailyNote("Daily Notes", "MMM d, yyyy", dailyNoteDate);
  assert.equal(result.pageId, "today");
  assert.equal(result.dateTitle, dateTitle);
  const query = requests.find((request) => request.url.endsWith("/query"));
  assert.deepEqual(query.body.filter, { property: "title", title: { equals: dateTitle } });
});

test("daily note lookup falls back to a date property when the title format differs", async () => {
  const { load, requests } = setup({
    respond: ({ url, body }) => {
      if (url.includes("/search")) return list([dataSource("source", "Daily Notes")]);
      if (url.endsWith("/query")) {
        if (body.filter?.title) return list([]);
        return list([notionPage("by-date", "Thursday")]);
      }
      if (url.includes("/data_sources/")) {
        return {
          ...dataSource("source", "Daily Notes"),
          properties: {
            Name: { id: "title", name: "Name", type: "title", title: {} },
            Date: { id: "date", name: "Date", type: "date", date: {} },
          },
        };
      }
      return { object: "user", id: "bot" };
    },
  });
  const { findTodaysDailyNote } = load("src/utils/notion/dailyNote.ts");
  const result = await findTodaysDailyNote("Daily Notes", "MMM d, yyyy", dailyNoteDate);
  assert.equal(result.pageId, "by-date");
  const dateQuery = requests.find((request) => request.url.endsWith("/query") && request.body.filter?.date);
  assert.equal(dateQuery.body.filter.property, "Date");
  assert.equal(dateQuery.body.filter.date.equals, "2026-10-08");
});

test("daily note lookup fails when today's page is missing", async () => {
  const { load } = setup({
    respond: ({ url }) => {
      if (url.includes("/search")) return list([dataSource("source", "Daily Notes")]);
      if (url.endsWith("/query")) return list([]);
      if (url.includes("/data_sources/")) {
        return {
          ...dataSource("source", "Daily Notes"),
          properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
        };
      }
      return { object: "user", id: "bot" };
    },
  });
  const { findTodaysDailyNote, MissingDailyNotePageError, getDateTitle } = load("src/utils/notion/dailyNote.ts");
  await assert.rejects(
    () => findTodaysDailyNote("Daily Notes", "MMM d, yyyy", dailyNoteDate),
    (error) => {
      assert.equal(error.name, "MissingDailyNotePageError");
      assert.equal(error.dateTitle, getDateTitle("MMM d, yyyy", dailyNoteDate));
      return error instanceof MissingDailyNotePageError;
    },
  );
});

test("Add Text to Daily Note does not close or report success after a rejected append", async () => {
  let submit;
  let closed = false;
  const toasts = [];
  const jsx = (type, props) => ({ type, props });
  const load = createLoader({
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (initial) => [initial, () => {}] },
    "@raycast/api": {
      Action: { SubmitForm: "submit" },
      ActionPanel: "actions",
      Form: { Description: "description", Dropdown: { Item: "item" } },
      Icon: {},
      Toast: { Style: { Success: "success", Animated: "animated", Failure: "failure" } },
      getPreferenceValues: () => ({ daily_notes_database: "Daily Notes", daily_note_date_format: "MMM d, yyyy" }),
      showToast: async (toast) => {
        toasts.push(toast);
      },
      closeMainWindow: async () => {
        closed = true;
      },
    },
    "@raycast/utils": {
      withAccessToken: () => (fn) => fn,
      FormValidation: { Required: "required" },
      useForm: ({ onSubmit }) => {
        submit = onSubmit;
        return { itemProps: {} };
      },
    },
    "./utils/notion": { appendBlockToPage: async () => undefined },
    "./utils/notion/dailyNote": {
      findTodaysDailyNote: async () => ({ pageId: "today", dateTitle: "Oct 8, 2026", databaseName: "Daily Notes" }),
      describeDailyNoteError: () => ({ title: "failed", message: "nope" }),
      getDateTitle: () => "Oct 8, 2026",
    },
    "./utils/notion/oauth": { notionService: {} },
  });
  load("src/add-text-to-daily-note.tsx").default({ arguments: {} });
  await submit({ textToAppend: "Note", prepend: false, addDateDivider: false });
  assert.equal(closed, false);
  assert.ok(!toasts.some((toast) => toast.style === "success"));
});

function loadOpenDailyNote({
  findTodaysDailyNote,
  describeDailyNoteError = () => ({ title: "failed", message: "nope" }),
}) {
  const toasts = [];
  const opened = [];
  let closed = false;
  const load = createLoader({
    "@raycast/api": {
      Toast: { Style: { Success: "success", Animated: "animated", Failure: "failure" } },
      getPreferenceValues: () => ({
        daily_notes_database: "Daily Notes",
        daily_note_date_format: "MMM d, yyyy",
        open_in: { name: "Notion" },
      }),
      showToast: async (toast) => {
        toasts.push(toast);
      },
      closeMainWindow: async () => {
        closed = true;
      },
    },
    "@raycast/utils": { withAccessToken: () => (fn) => fn },
    "./utils/notion/dailyNote": { findTodaysDailyNote, describeDailyNoteError },
    "./utils/notion/oauth": { notionService: {} },
    "./utils/openPage": {
      urlForPreferredMethod: (url) => url,
      openPageUrl: async (url) => {
        opened.push(url);
      },
    },
  });
  return {
    command: load("src/open-daily-note.ts").default,
    toasts,
    opened,
    get closed() {
      return closed;
    },
  };
}

test("Open Daily Note opens today's looked-up page", async () => {
  const context = loadOpenDailyNote({
    findTodaysDailyNote: async () => ({ pageId: "ab-cd", dateTitle: "Oct 8, 2026", databaseName: "Daily Notes" }),
  });
  await context.command();
  assert.deepEqual(context.opened, ["https://www.notion.so/abcd"]);
  assert.equal(context.closed, true);
});

test("Open Daily Note does not open Notion when today's page is missing", async () => {
  const context = loadOpenDailyNote({
    findTodaysDailyNote: async () => {
      const error = new Error("missing");
      error.name = "MissingDailyNotePageError";
      throw error;
    },
    describeDailyNoteError: () => ({ title: "No daily note", message: "not yet" }),
  });
  await context.command();
  assert.deepEqual(context.opened, []);
  assert.equal(context.closed, false);
  assert.ok(context.toasts.some((toast) => toast.style === "failure" && toast.title === "No daily note"));
});

test("addNote creates a child page under today's daily note", async () => {
  const { load, requests } = setup({
    respond: ({ url, body }) => {
      if (url.includes("/search")) return list([dataSource("source", "Daily Notes")]);
      if (url.endsWith("/query") && body.filter?.title) return list([notionPage("today", body.filter.title.equals)]);
      if (/\/pages$/.test(url))
        return { object: "page", id: "child", properties: { title: { type: "title", title: [] } } };
      return { object: "user", id: "bot" };
    },
  });
  const { addNote } = load("src/utils/notion/notes.ts");
  const result = await addNote({
    note: "Buy milk\nFrom the store",
    databaseName: "Daily Notes",
    dateFormat: "MMM d, yyyy",
    date: dailyNoteDate,
  });
  assert.equal(result.pageId, "child");
  assert.equal(result.title, "Buy milk");
  const create = requests.find((request) => /\/pages$/.test(request.url));
  assert.equal(create.body.parent.page_id, "today");
  assert.equal(create.body.properties.title.title[0].text.content, "Buy milk");
  assert.ok(create.body.children?.length > 0);
});

test("addNote does not create a child page when today's daily note is missing", async () => {
  const { load, requests } = setup({
    respond: ({ url }) => {
      if (url.includes("/search")) return list([dataSource("source", "Daily Notes")]);
      if (url.endsWith("/query")) return list([]);
      if (url.includes("/data_sources/")) {
        return {
          ...dataSource("source", "Daily Notes"),
          properties: { Name: { id: "title", name: "Name", type: "title", title: {} } },
        };
      }
      return { object: "user", id: "bot" };
    },
  });
  const { addNote } = load("src/utils/notion/notes.ts");
  await assert.rejects(
    () =>
      addNote({
        note: "Buy milk",
        databaseName: "Daily Notes",
        dateFormat: "MMM d, yyyy",
        date: dailyNoteDate,
      }),
    (error) => error.name === "MissingDailyNotePageError",
  );
  assert.ok(!requests.some((request) => /\/pages$/.test(request.url)));
});
