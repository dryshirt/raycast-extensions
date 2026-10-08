import { APIErrorCode, ClientErrorCode, collectPaginatedAPI, isNotionClientError } from "@notionhq/client";
import { LocalStorage } from "@raycast/api";
import { format } from "date-fns";

import { pageMapper } from "./global";
import { getDateTitle } from "./notes";
import { getNotionClient } from "./oauth";

export { getDateTitle };

const DATABASE_CACHE_KEY = "DAILY_NOTES_DATABASE";
const DATE_PAGE_CACHE_KEY = "DAILY_NOTES_DATE_PAGE";

function databaseCacheKey(databaseName: string) {
  return `${DATABASE_CACHE_KEY}::${databaseName.toLowerCase()}`;
}

function datePageCacheKey(databaseId: string, dateTitle: string) {
  return `${DATE_PAGE_CACHE_KEY}::${databaseId}::${dateTitle}`;
}

function titlesMatch(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isUsablePage(result: { object: string; archived?: boolean; in_trash?: boolean }) {
  if (result.object !== "page") return false;
  if ("archived" in result && result.archived) return false;
  if ("in_trash" in result && result.in_trash) return false;
  return true;
}

async function validatePageId(pageId: string) {
  try {
    const notion = getNotionClient();
    const page = await notion.pages.retrieve({ page_id: pageId });
    const isTrashed = ("archived" in page && page.archived) || ("in_trash" in page && page.in_trash);
    return isTrashed ? undefined : pageId;
  } catch {
    return undefined;
  }
}

async function validateDataSourceId(dataSourceId: string) {
  try {
    const notion = getNotionClient();
    await notion.dataSources.retrieve({ data_source_id: dataSourceId });
    return dataSourceId;
  } catch {
    return undefined;
  }
}

async function getCachedId(key: string, validate: (id: string) => Promise<string | undefined>) {
  const cached = await LocalStorage.getItem<string>(key);
  if (!cached) return undefined;

  const id = await validate(cached);
  if (!id) await LocalStorage.removeItem(key);

  return id;
}

export class MissingDailyNotesDatabaseError extends Error {
  constructor(readonly databaseName: string) {
    super(`There is no "${databaseName}" database`);
    this.name = "MissingDailyNotesDatabaseError";
  }
}

export class MissingDailyNotePageError extends Error {
  constructor(
    readonly databaseName: string,
    readonly dateTitle: string,
  ) {
    super(`There is no "${dateTitle}" page in "${databaseName}"`);
    this.name = "MissingDailyNotePageError";
  }
}

async function findDailyNotesDatabaseId(databaseName: string) {
  const cacheKey = databaseCacheKey(databaseName);
  const cachedId = await getCachedId(cacheKey, validateDataSourceId);
  if (cachedId) return cachedId;

  const notion = getNotionClient();
  let cursor: string | undefined;

  do {
    const { results, has_more, next_cursor } = await notion.search({
      query: databaseName,
      filter: { property: "object", value: "data_source" },
      start_cursor: cursor,
      page_size: 100,
    });

    const match = results.find((result) => {
      if (result.object !== "data_source" || !("title" in result)) return false;
      const title = result.title.map((text) => text.plain_text).join("");
      return titlesMatch(title, databaseName);
    });

    if (match) {
      await LocalStorage.setItem(cacheKey, match.id);
      return match.id;
    }

    cursor = has_more && next_cursor ? next_cursor : undefined;
  } while (cursor);

  throw new MissingDailyNotesDatabaseError(databaseName);
}

async function findPageByTitle(dataSourceId: string, dateTitle: string) {
  const notion = getNotionClient();
  const pages = await collectPaginatedAPI(notion.dataSources.query, {
    data_source_id: dataSourceId,
    filter: {
      property: "title",
      title: {
        equals: dateTitle,
      },
    },
  });

  const match = pages.find((page) => isUsablePage(page) && titlesMatch(pageMapper(page).title ?? "", dateTitle));
  return match?.id;
}

function localDateStamp(date: Date) {
  return format(date, "yyyy-MM-dd");
}

async function findPageByDate(dataSourceId: string, date: Date) {
  const notion = getNotionClient();
  const dataSource = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  if (!("properties" in dataSource)) return undefined;

  const datePropertyNames = Object.values(dataSource.properties)
    .filter((property) => property.type === "date")
    .map((property) => property.name);

  if (datePropertyNames.length === 0) return undefined;

  const today = localDateStamp(date);
  const dateFilters = datePropertyNames.map((name) => ({
    property: name,
    date: { equals: today },
  }));

  const pages = await collectPaginatedAPI(notion.dataSources.query, {
    data_source_id: dataSourceId,
    filter: dateFilters.length === 1 ? dateFilters[0] : { or: dateFilters },
  });

  const match = pages.find((page) => isUsablePage(page));
  return match?.id;
}

export async function findTodaysDailyNote(databaseName: string, dateFormat: string, date: Date = new Date()) {
  const dateTitle = getDateTitle(dateFormat, date);
  const databaseId = await findDailyNotesDatabaseId(databaseName);
  const cacheKey = datePageCacheKey(databaseId, dateTitle);

  const cachedPageId = await getCachedId(cacheKey, validatePageId);
  if (cachedPageId) return { pageId: cachedPageId, dateTitle, databaseName };

  const pageId = (await findPageByTitle(databaseId, dateTitle)) ?? (await findPageByDate(databaseId, date));
  if (!pageId) throw new MissingDailyNotePageError(databaseName, dateTitle);

  await LocalStorage.setItem(cacheKey, pageId);
  return { pageId, dateTitle, databaseName };
}

export type DailyNoteErrorInfo = {
  title: string;
  message: string;
};

export function describeDailyNoteError(err: unknown, databaseName: string): DailyNoteErrorInfo {
  console.error(err);

  if (err instanceof MissingDailyNotesDatabaseError) {
    return {
      title: `No "${databaseName}" database found`,
      message: "Share that database with the Raycast integration, or update the Daily Notes Database preference.",
    };
  }

  if (err instanceof MissingDailyNotePageError) {
    return {
      title: `No "${err.dateTitle}" daily note`,
      message: `Notion doesn't have today's page in "${databaseName}" yet. Wait for it to be created, then try again.`,
    };
  }

  if (isNotionClientError(err)) {
    switch (err.code) {
      case APIErrorCode.Unauthorized:
      case ClientErrorCode.RequestTimeout:
        return {
          title: "Couldn't reach Notion",
          message: "Check your connection, then run the command again.",
        };
      case APIErrorCode.RestrictedResource:
      case APIErrorCode.ObjectNotFound:
        return {
          title: "Raycast can't access that database",
          message: "In Notion, open the Daily Notes database menu and share it with the Raycast integration.",
        };
      case APIErrorCode.RateLimited:
        return {
          title: "Notion is rate limiting Raycast",
          message: "Wait a few seconds and try again.",
        };
    }
  }

  return {
    title: "Couldn't add text to today's daily note",
    message: "The text wasn't written to Notion. Try again — it's still in the form.",
  };
}
