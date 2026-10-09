import {
  Action,
  ActionPanel,
  Form,
  Icon,
  LaunchProps,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  popToRoot,
  showToast,
} from "@raycast/api";
import { useForm, withAccessToken } from "@raycast/utils";

import { addNote, describeAddNoteError, getDateTitle } from "./utils/notion/notes";
import { notionService } from "./utils/notion/oauth";
import { urlForPreferredMethod, openPageUrl } from "./utils/openPage";

type AddNoteValues = {
  note: string;
};

function pageUrl(pageId: string) {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function AddNote(props: LaunchProps<{ arguments: Arguments.AddNote }>) {
  const { daily_notes_database, daily_note_date_format, open_in } = getPreferenceValues();
  const dateTitle = getDateTitle(daily_note_date_format);

  const { itemProps, handleSubmit } = useForm<AddNoteValues>({
    initialValues: {
      note: props.arguments.note ?? "",
    },
    async onSubmit(values) {
      try {
        await showToast({ style: Toast.Style.Animated, title: "Adding note" });

        const {
          pageId,
          title,
          dateTitle: destinationTitle,
        } = await addNote({
          note: values.note.trim(),
          databaseName: daily_notes_database,
          dateFormat: daily_note_date_format,
        });

        await closeMainWindow();
        await popToRoot();
        await showToast({
          style: Toast.Style.Success,
          title: "Note added",
          message: `${destinationTitle} › ${title}`,
          primaryAction: {
            title: "Open Page",
            onAction: () => openPageUrl(urlForPreferredMethod(pageUrl(pageId), open_in), open_in),
          },
        });
      } catch (err) {
        const { title, message } = describeAddNoteError(err, daily_notes_database);
        await showToast({ style: Toast.Style.Failure, title, message });
      }
    },
    validation: {
      note: (value) => {
        if (!value?.trim()) return "Write your note first";
      },
    },
  });

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm onSubmit={handleSubmit} title="Add Note" icon={Icon.Plus} />
        </ActionPanel>
      }
    >
      <Form.TextArea
        {...itemProps.note}
        title="Note"
        placeholder="What's on your mind?"
        autoFocus={!props.arguments.note}
        enableMarkdown
      />

      <Form.Description title="Destination" text={`${daily_notes_database} › ${dateTitle}`} />
    </Form>
  );
}

export default withAccessToken(notionService)(AddNote);
