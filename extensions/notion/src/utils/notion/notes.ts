import { isNotionClientError } from "@notionhq/client";
import type { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints";
import { markdownToBlocks } from "@tryfabric/martian";

import {
  describeDailyNoteError,
  findTodaysDailyNote,
  MissingDailyNotePageError,
  MissingDailyNotesDatabaseError,
} from "./dailyNote";
import { getDateTitle } from "./dateTitle";
import { getNotionClient } from "./oauth";

export { getDateTitle };

/** Notion rejects any rich text element longer than this. */
const RICH_TEXT_LIMIT = 2000;

export function notePageTitle(note: string) {
  const line = note.split(/\r?\n/).find((part) => part.trim()) ?? note;
  const title = line.trim();
  return title.length > RICH_TEXT_LIMIT ? title.slice(0, RICH_TEXT_LIMIT) : title;
}

async function createSubPage(parentPageId: string, title: string, children?: BlockObjectRequest[]) {
  const notion = getNotionClient();
  const page = await notion.pages.create({
    parent: { page_id: parentPageId },
    properties: {
      title: { title: [{ text: { content: title } }] },
    },
    ...(children?.length ? { children } : {}),
  });

  return page.id;
}

type AddNoteParams = {
  note: string;
  databaseName: string;
  dateFormat: string;
  date?: Date;
};

/**
 * Creates a child page under today's Daily Notes page.
 * Today's page must already exist; this does not create it.
 */
export async function addNote({ note, databaseName, dateFormat, date }: AddNoteParams) {
  const { pageId: dailyNoteId, dateTitle } = await findTodaysDailyNote(databaseName, dateFormat, date);
  const title = notePageTitle(note);
  const children = markdownToBlocks(note) as BlockObjectRequest[];
  const pageId = await createSubPage(dailyNoteId, title, children);

  return { pageId, title, dateTitle };
}

export type AddNoteErrorInfo = {
  title: string;
  message: string;
};

export function describeAddNoteError(err: unknown, databaseName: string): AddNoteErrorInfo {
  if (
    err instanceof MissingDailyNotesDatabaseError ||
    err instanceof MissingDailyNotePageError ||
    isNotionClientError(err)
  ) {
    return describeDailyNoteError(err, databaseName);
  }

  console.error(err);
  return {
    title: "Couldn't save the note",
    message: "Your note wasn't written to Notion. Try again — it's still in the form.",
  };
}
