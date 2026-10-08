import { BlockObjectRequest } from "@notionhq/client/build/src/api-endpoints";
import {
  Action,
  ActionPanel,
  Form,
  Icon,
  LaunchProps,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  showToast,
} from "@raycast/api";
import { FormValidation, useForm, withAccessToken } from "@raycast/utils";
import { markdownToBlocks } from "@tryfabric/martian";

import { appendBlockToPage } from "./utils/notion";
import { describeDailyNoteError, findTodaysDailyNote, getDateTitle } from "./utils/notion/dailyNote";
import { notionService } from "./utils/notion/oauth";

type AddTextToDailyNoteValues = {
  prepend: boolean;
  addDateDivider: boolean;
  textToAppend: string;
};

type DailyNotePreferences = {
  daily_notes_database: string;
  daily_note_date_format: string;
};

function AddTextToDailyNote(props: LaunchProps<{ arguments: { text?: string } }>) {
  const { daily_notes_database, daily_note_date_format } = getPreferenceValues<DailyNotePreferences>();
  const dateTitle = getDateTitle(daily_note_date_format);

  const { itemProps, handleSubmit } = useForm<AddTextToDailyNoteValues>({
    async onSubmit(values) {
      try {
        await showToast({ style: Toast.Style.Animated, title: "Adding content to the page" });

        const { pageId } = await findTodaysDailyNote(daily_notes_database, daily_note_date_format);
        const content = markdownToBlocks(values.textToAppend) as BlockObjectRequest[];
        const result = await appendBlockToPage({
          pageId,
          children: content,
          prepend: values.prepend,
          addDateDivider: values.addDateDivider,
        });
        if (!result) return;
        await closeMainWindow();
        await showToast({ style: Toast.Style.Success, title: "Added text to daily note" });
      } catch (err) {
        const { title, message } = describeDailyNoteError(err, daily_notes_database);
        await showToast({ style: Toast.Style.Failure, title, message });
      }
    },
    initialValues: {
      textToAppend: props.arguments.text ?? "",
    },
    validation: {
      textToAppend: FormValidation.Required,
    },
  });

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={handleSubmit} title="Add Text to Daily Note" icon={Icon.Plus} />
        </ActionPanel>
      }
    >
      <Form.Description title="Destination" text={`${daily_notes_database} › ${dateTitle}`} />

      <Form.TextArea enableMarkdown autoFocus={!props.arguments.text} title="Content" {...itemProps.textToAppend} />

      <Form.Checkbox
        {...itemProps.prepend}
        label="Append at the top"
        info="Append the content at the top of the page instead of the bottom"
        storeValue
      />

      <Form.Checkbox
        {...itemProps.addDateDivider}
        label="Append with a date divider"
        info="Add a divider with the current date before the content"
        storeValue
      />
    </Form>
  );
}
export default withAccessToken(notionService)(AddTextToDailyNote);
