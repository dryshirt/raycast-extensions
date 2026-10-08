import { Toast, closeMainWindow, getPreferenceValues, showToast } from "@raycast/api";
import { withAccessToken } from "@raycast/utils";

import { describeDailyNoteError, findTodaysDailyNote } from "./utils/notion/dailyNote";
import { notionService } from "./utils/notion/oauth";
import { openPageUrl, urlForPreferredMethod } from "./utils/openPage";

function pageUrl(pageId: string) {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

export default withAccessToken(notionService)(async () => {
  const { daily_notes_database, daily_note_date_format, open_in } = getPreferenceValues();

  try {
    await showToast({ style: Toast.Style.Animated, title: "Opening daily note" });

    const { pageId } = await findTodaysDailyNote(daily_notes_database, daily_note_date_format);
    await openPageUrl(urlForPreferredMethod(pageUrl(pageId), open_in), open_in);
    await closeMainWindow();
  } catch (err) {
    const { title, message } = describeDailyNoteError(err, daily_notes_database);
    await showToast({ style: Toast.Style.Failure, title, message });
  }
});
